/**
 * dsh-openfrp — a minimal, dependency-free Minecraft (Source) RCON client.
 *
 * Why hand-rolled instead of an npm package: this is the plugin's *command
 * channel*, the thing that lets the agent act instead of asking the human to
 * act. It should be auditable in one sitting and carry no supply-chain weight.
 *
 * Protocol facts (Minecraft Wiki, "RCON"):
 *  - TCP, little-endian, packet = int32 length | int32 requestId | int32 type | payload | 0x00 0x00.
 *  - type 3 = login, 2 = command, 0 = command response.
 *  - A failed login answers with requestId = -1.
 *  - Large responses are **fragmented** and there is no end marker; the common
 *    heuristics are "payload shorter than 4096 means last" or "send a second,
 *    harmless command and use its response as the boundary". We use the first at
 *    read level plus a short settle window, then trim the known terminator.
 *  - Some servers emit `§`-style colour codes; decode as latin1 and strip them.
 *
 * @module dsh-openfrp/rcon
 */

import net from 'node:net';

const TYPE_RESPONSE = 0;
const TYPE_COMMAND = 2;
const TYPE_LOGIN = 3;
const MAX_PAYLOAD = 4096;

export class RconError extends Error {
  constructor(message, { code = 'rcon' } = {}) {
    super(message);
    this.name = 'RconError';
    this.code = code;
  }
}

/** Build one wire packet. */
export function encodePacket(id, type, body) {
  const payload = Buffer.from(String(body), 'latin1');
  const buffer = Buffer.alloc(4 + 4 + 4 + payload.length + 2);
  buffer.writeInt32LE(4 + 4 + payload.length + 2, 0);
  buffer.writeInt32LE(id, 4);
  buffer.writeInt32LE(type, 8);
  payload.copy(buffer, 12);
  buffer.writeUInt8(0, 12 + payload.length);
  buffer.writeUInt8(0, 13 + payload.length);
  return buffer;
}

/**
 * Try to decode one packet from the front of `buffer`.
 * @returns {{id:number,type:number,body:string,rest:Buffer}|null}
 */
export function decodePacket(buffer) {
  if (buffer.length < 4) return null;
  const length = buffer.readInt32LE(0);
  if (length < 10 || length > 1024 * 1024) throw new RconError(`RCON 包长度异常：${length}`, { code: 'bad-length' });
  if (buffer.length < length + 4) return null;
  const id = buffer.readInt32LE(4);
  const type = buffer.readInt32LE(8);
  const body = buffer.subarray(12, 4 + length - 2).toString('latin1');
  return { id, type, body, rest: buffer.subarray(length + 4) };
}

/**
 * Strip Minecraft formatting codes (`§` + one char) and normalize.
 * 去掉 § 颜色代码。我们想要的是能直接读的文本。
 */
export function stripFormatting(text) {
  return String(text).replace(/\u00a7./g, '').replace(/\r/g, '').trimEnd();
}

/** One-shot RCON connection. Use `withRcon()` unless you need to keep it open. */
export class RconConnection {
  constructor({ host = '127.0.0.1', port, password, timeoutMs = 10_000 }) {
    this.host = host;
    this.port = port;
    this.password = password;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    /** @type {Array<{resolve:Function,reject:Function}>} */
    this.waiters = [];
  }

  async connect() {
    if (this.socket !== null) return this;
    this.socket = await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port }, () => resolve(socket));
      socket.setTimeout(this.timeoutMs);
      socket.once('error', error => reject(new RconError(`无法连接 RCON ${this.host}:${this.port}：${error.message}`, { code: 'connect-failed' })));
      socket.once('timeout', () => reject(new RconError(`RCON 连接超时：${this.host}:${this.port}`, { code: 'connect-timeout' })));
    });

    this.socket.on('data', chunk => this.#onData(chunk));
    this.socket.on('error', error => this.#failAll(new RconError(`RCON 连接错误：${error.message}`, { code: 'socket-error' })));
    this.socket.on('close', () => this.#failAll(new RconError('RCON 连接已关闭', { code: 'closed' })));

    await this.#login();
    return this;
  }

  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      let packet;
      try {
        packet = decodePacket(this.buffer);
      } catch (error) {
        this.#failAll(error);
        return;
      }
      if (packet === null) return;
      this.buffer = packet.rest;
      const waiter = this.waiters.shift();
      if (waiter !== undefined) waiter.resolve(packet);
    }
  }

  #failAll(error) {
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  #send(id, type, body) {
    this.socket.write(encodePacket(id, type, body));
  }

  /** Await one packet, or fail on timeout. */
  #nextPacket(timeoutMs = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      this.waiters.push(waiter);
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(new RconError('等待 RCON 响应超时', { code: 'read-timeout' }));
      }, timeoutMs);
      const originalResolve = waiter.resolve;
      waiter.resolve = packet => { clearTimeout(timer); originalResolve(packet); };
      const originalReject = waiter.reject;
      waiter.reject = error => { clearTimeout(timer); originalReject(error); };
    });
  }

  async #login() {
    const id = this.nextId++;
    this.#send(id, TYPE_LOGIN, this.password);
    const packet = await this.#nextPacket();
    if (packet.id === -1) {
      throw new RconError('RCON 登录失败：密码错误。', { code: 'auth-failed' });
    }
  }

  /**
   * Run a command and return the server's own words.
   * Fragmented responses are accumulated until a short packet arrives, then a
   * brief settle window catches any stragglers.
   */
  async exec(command) {
    if (this.socket === null) throw new RconError('RCON 尚未连接', { code: 'not-connected' });
    const id = this.nextId++;
    this.#send(id, TYPE_COMMAND, command);

    const chunks = [];
    for (;;) {
      let packet;
      try {
        packet = await this.#nextPacket(chunks.length === 0 ? this.timeoutMs : 750);
      } catch (error) {
        if (chunks.length > 0 && error?.code === 'read-timeout') break;
        throw error;
      }
      chunks.push(packet.body);
      if (Buffer.byteLength(packet.body, 'latin1') < MAX_PAYLOAD) {
        // Possible trailing fragments; wait briefly, then stop.
        try {
          const extra = await this.#nextPacket(250);
          chunks.push(extra.body);
        } catch {
          break;
        }
        break;
      }
    }
    return stripFormatting(chunks.join(''));
  }

  close() {
    if (this.socket !== null) {
      this.socket.end();
      this.socket.destroy();
      this.socket = null;
    }
  }
}

/**
 * Convenience wrapper: connect, run commands, always close.
 * 便捷封装：连接 → 执行 → 一定关闭。
 */
export async function withRcon({ host, port, password, timeoutMs }, fn) {
  const connection = new RconConnection({ host, port, password, timeoutMs });
  try {
    await connection.connect();
    return await fn(connection);
  } finally {
    connection.close();
  }
}

/**
 * A cheap liveness probe: the server answers `list` only if RCON is really up.
 * Used by diagnosis instead of assuming, because "log file quiet" is NOT "dead".
 *
 * 便宜的存活探测：能答上 `list` 才算 RCON 真的活着。
 */
export async function probeRcon({ host, port, password, timeoutMs = 4000 }) {
  try {
    const reply = await withRcon({ host, port, password, timeoutMs }, connection => connection.exec('list'));
    return { alive: true, reply };
  } catch (error) {
    return { alive: false, error: String(error?.message ?? error), code: error?.code ?? 'unknown' };
  }
}
