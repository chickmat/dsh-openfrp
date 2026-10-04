/**
 * dsh-openfrp — the frpc runtime.
 *
 * Facts this module encodes (all verified on this machine, docs §4.3 / §5):
 *
 *  - **We never write an frpc config file.** `frpc -u <token> -p <id>` is the
 *    official "remote config mode": frpc pulls the whole tunnel definition from
 *    the OpenFrp API itself.
 *  - The ready line carries the public address:
 *    ``Your `name` proxy is available now. Use [`addr`] to connect.``
 *  - Logs go to **stdout**, and are **ANSI-coloured by default** — hence
 *    `--disable-log-color`, without which every pattern fails.
 *  - `--noupdate` matters: otherwise frpc may replace its own binary mid-run.
 *  - We only ever own the processes **we** started. Killing foreign frpc
 *    processes would break the user's other tunnels (docs §14.6).
 *
 * @module dsh-openfrp/frpc
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { FRPC_ARGS, FRPC_READY_RE, FRPC_ERRORS, USER_AGENT, stripAnsi, cleanChildEnv } from './protocol.js';
import { dataDir } from './registry.js';
import { tailFile, readTailLines } from './logtail.js';
import { runCapture, runQuiet } from './exec.js';

// ─────────────────────────────────────────────────────────────
// Platform naming (what the OpenFrp download server expects)
// ─────────────────────────────────────────────────────────────

/** Map Node's platform/arch onto the names OpenFrp's release server uses. */
export function frpcNames({ platform = process.platform, arch = process.arch } = {}) {
  const osName = { win32: 'windows', linux: 'linux', darwin: 'darwin', freebsd: 'freebsd', android: 'android' }[platform];
  if (osName === undefined) throw new Error(`不支持的平台：${platform}`);
  const archName = { x64: 'amd64', ia32: '386', arm64: 'arm64', arm: 'arm' }[arch];
  if (archName === undefined) throw new Error(`不支持的架构：${arch}`);
  const ext = platform === 'win32' ? 'zip' : 'tar.gz';
  const file = platform === 'win32' ? `frpc_${osName}_${archName}.exe` : `frpc_${osName}_${archName}`;
  return { osName, archName, ext, file, archive: `frpc_${osName}_${archName}.${ext}` };
}

/** Where this plugin keeps its own frpc copy. 插件自己的 frpc 目录。 */
export function frpcCacheDir() {
  return path.join(dataDir(), 'frpc');
}

// ─────────────────────────────────────────────────────────────
// Locating an existing frpc (we prefer not to download)
// ─────────────────────────────────────────────────────────────

/**
 * Candidate locations, most-specific first. The official launcher's directory
 * is included because reusing the binary the user already has is strictly
 * better than a second 6 MB download — but it is only ever *read*, never
 * managed by us.
 *
 * 候选位置，从最具体到最通用。含官方启动器目录（只是复用它的二进制，不做管理）。
 */
export function frpcCandidates({ platform = process.platform, arch = process.arch, configured = '' } = {}) {
  const { file } = frpcNames({ platform, arch });
  const candidates = [];
  if (configured !== '') candidates.push(configured);
  if (platform === 'win32') {
    const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
    candidates.push(path.join(pf86, 'OpenFrp Launcher', 'frpc', file));
    candidates.push(path.join(pf, 'OpenFrp Launcher', 'frpc', file));
  } else if (platform === 'darwin') {
    candidates.push('/Applications/OpenFrp Launcher.app/Contents/Resources/frpc', path.join(os.homedir(), 'Library/Application Support/OpenFrp/frpc', file));
  } else {
    candidates.push('/usr/local/bin/frpc', '/usr/bin/frpc', path.join(os.homedir(), '.local/bin/frpc'));
  }
  candidates.push(path.join(frpcCacheDir(), file));
  return candidates;
}

/** First existing candidate, or null. 找到第一个存在的路径。 */
export function locateFrpc(options = {}) {
  for (const candidate of frpcCandidates(options)) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/**
 * Run `frpc -v` and return the version string (last word of the first line).
 *
 * Uses file-descriptor capture rather than `execFile`: piped stdio fails with
 * `EPERM` under the default confined DSH sandbox, and this call sits on the
 * critical path of `openfrp_expose` — with `execFile` the whole expose flow threw.
 */
export async function readFrpcVersion(binary) {
  const result = await runCapture(binary, ['-v'], { timeoutMs: 15_000 });
  const text = result.stdout.trim();
  if (text === '') return { ok: false, version: '', error: result.error ?? '无输出' };
  const version = text.split(/\r?\n/)[0].trim().split(/\s+/).pop() ?? '';
  return { ok: true, version, error: '' };
}

// ─────────────────────────────────────────────────────────────
// Minimal ZIP reader (Windows releases ship .zip; we have no archive dep)
// ─────────────────────────────────────────────────────────────

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

function findEocd(buffer) {
  const min = Math.max(0, buffer.length - 66_000);
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/** List `{name, method, compressedSize, offset}` for every entry in a zip. */
export function listZipEntries(buffer) {
  const eocd = findEocd(buffer);
  if (eocd === -1) throw new Error('不是有效的 ZIP（找不到 EOCD）');
  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CEN_SIG) break;
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const offset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    entries.push({ name, method, compressedSize, offset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Extract every file from a zip into memory: `Map<name, Buffer>`. */
export function extractZip(buffer) {
  const out = new Map();
  for (const entry of listZipEntries(buffer)) {
    if (entry.name.endsWith('/')) continue;
    const local = entry.offset;
    if (buffer.readUInt32LE(local) !== LOC_SIG) throw new Error(`ZIP 局部头损坏：${entry.name}`);
    const nameLength = buffer.readUInt16LE(local + 26);
    const extraLength = buffer.readUInt16LE(local + 28);
    const start = local + 30 + nameLength + extraLength;
    const raw = buffer.subarray(start, start + entry.compressedSize);
    if (entry.method === 0) out.set(entry.name, Buffer.from(raw));
    else if (entry.method === 8) out.set(entry.name, zlib.inflateRawSync(raw));
    else throw new Error(`不支持的 ZIP 压缩方式 ${entry.method}（${entry.name}）`);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Download / update
// ─────────────────────────────────────────────────────────────

/**
 * Fetch the release manifest and, when needed, download frpc into the plugin's
 * own cache directory.
 *
 * 拉取发行清单，必要时把 frpc 下到插件自己的缓存目录。
 */
export async function ensureFrpc({ binary = '', fetchImpl, platform = process.platform, arch = process.arch, apiBase, force = false } = {}) {
  const names = frpcNames({ platform, arch });
  const target = path.join(frpcCacheDir(), names.file);
  const existing = binary !== '' ? binary : locateFrpc({ platform, arch });
  if (!force && existing !== null && fs.existsSync(existing)) {
    const info = await readFrpcVersion(existing);
    return { binary: existing, downloaded: false, version: info.version };
  }

  const doFetch = fetchImpl ?? globalThis.fetch;
  const manifestUrl = `${apiBase ?? 'https://api.openfrp.net'}/commonQuery/get?key=software`;
  const response = await doFetch(manifestUrl, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`获取 frpc 发行信息失败：HTTP ${response.status}`);
  const manifest = await response.json();
  const data = manifest?.data ?? {};
  const latest = String(data.latest ?? '');
  const latestFull = String(data.latest_full ?? latest.replace(/\//g, ''));
  const sources = Array.isArray(data.source) ? data.source.map(s => s?.value).filter(Boolean) : [];
  if (latest === '' || sources.length === 0) throw new Error('发行信息缺少 latest 或 source，无法下载 frpc');

  const attempts = [`${sources[0]}${latest}${names.archive}`, ...sources.slice(1).map(s => `${s}${latest}${names.archive}`)];
  let archive = null;
  const failures = [];
  for (const url of attempts) {
    try {
      const res = await doFetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(180_000) });
      if (!res.ok) { failures.push(`${url} → HTTP ${res.status}`); continue; }
      archive = Buffer.from(await res.arrayBuffer());
      break;
    } catch (error) {
      failures.push(`${url} → ${error?.message ?? error}`);
    }
  }
  if (archive === null) throw new Error(`下载 frpc 全部下载源均失败：\n${failures.join('\n')}`);

  fs.mkdirSync(frpcCacheDir(), { recursive: true });
  if (names.ext === 'zip') {
    const files = extractZip(archive);
    // Official zips are flat: a single `frpc_windows_amd64.exe`. Do not rename it.
    const entry = [...files.entries()].find(([name]) => name.endsWith('.exe'))
      ?? [...files.entries()].find(([name]) => !name.includes('/'));
    if (entry === undefined) throw new Error('下载的 ZIP 里找不到可执行文件');
    fs.writeFileSync(target, entry[1], { mode: 0o755 });
  } else {
    const tarEntry = readFlatTarGz(archive);
    if (tarEntry === null) throw new Error('下载的 tar.gz 里找不到可执行文件');
    fs.writeFileSync(target, tarEntry, { mode: 0o755 });
  }

  const info = await readFrpcVersion(target);
  return { binary: target, downloaded: true, version: info.version, latestFull };
}

/**
 * Read the first regular file out of a flat .tar.gz. OpenFrp's Linux/macOS
 * archives contain a single binary, so a tiny reader is enough (no tar dep).
 *
 * 从扁平 tar.gz 里读出第一个普通文件。
 */
export function readFlatTarGz(archive) {
  const tar = zlib.gunzipSync(archive);
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeText = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = Number.parseInt(sizeText, 8) || 0;
    const typeFlag = String.fromCharCode(header[156] || 48);
    const dataStart = offset + 512;
    if (typeFlag === '0' || typeFlag === '\0' || typeFlag === '') {
      if (name !== '' && !name.endsWith('/')) return tar.subarray(dataStart, dataStart + size);
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// Process management (only our own children)
// ─────────────────────────────────────────────────────────────

/**
 * One frpc instance we own.
 *
 * **Why frpc's output goes to a file instead of a pipe.** Under a confined
 * DSH sandbox a child spawned with piped stdio fails with `EPERM` (measured:
 * `pipe` → EPERM, `ignore` → ok, file descriptor → ok). Redirecting stdout and
 * stderr to two append descriptors on one file works, needs no pipe, keeps both
 * streams in order-of-arrival, and has a real bonus: the tunnel's log outlives
 * the plugin, so a restarted DSH can still read what frpc said.
 *
 * 为什么 frpc 输出重定向到文件而不是走管道：受限沙箱下带管道的 spawn 会 EPERM。
 * 同一文件两个 append fd 可以拿到 stdout+stderr，且日志能跨插件重启存活。
 */
export class FrpcInstance {
  constructor({ binary, token, proxyIds, logFile = '', onLine, extraArgs = [], timeoutMs = 90_000 }) {
    this.binary = binary;
    this.token = token;
    this.proxyIds = Array.isArray(proxyIds) ? proxyIds : [proxyIds];
    this.onLine = onLine;
    this.extraArgs = extraArgs;
    this.timeoutMs = timeoutMs;
    this.logFile = logFile === '' ? defaultFrpcLogFile(this.proxyIds) : logFile;
    this.child = null;
    this.lines = [];
    this.publicAddress = '';
    this.errors = [];
    this.exited = null;
    this.tail = null;
    /** @type {((value:{address:string,line:string})=>void)|null} */
    this.readyResolve = null;
    this.readyPromise = new Promise(resolve => { this.readyResolve = resolve; });
  }

  get pid() {
    return this.child?.pid ?? null;
  }

  get running() {
    return this.child !== null && this.child.exitCode === null && this.exited === null;
  }

  /** Build argv. Exported shape matters for tests. */
  argv() {
    return ['-u', this.token, '-p', this.proxyIds.join(','), ...FRPC_ARGS.always, ...this.extraArgs];
  }

  start() {
    if (this.child !== null) throw new Error('该 frpc 实例已经启动');

    // Output capture is a cache, not a precondition: if our data directory is
    // not writable (read-only home, full disk, confined sandbox) fall back to
    // temp, and if that fails too run without capture rather than refusing to
    // start the tunnel at all.
    const prepared = prepareLogFile(this.logFile);
    this.logFile = prepared.path;

    let fds = null;
    if (prepared.ok) {
      try {
        fds = [fs.openSync(this.logFile, 'a'), fs.openSync(this.logFile, 'a')];
      } catch {
        fds = null;
      }
    }
    try {
      this.child = spawn(this.binary, this.argv(), {
        env: cleanChildEnv(),
        windowsHide: true,
        stdio: fds === null ? 'ignore' : ['ignore', fds[0], fds[1]],
      });
    } finally {
      // The child holds its own duplicated handles; ours can go.
      if (fds !== null) for (const fd of fds) fs.closeSync(fd);
    }

    this.child.on('error', error => {
      this.exited = { code: null, signal: null, error: String(error?.message ?? error) };
      this.readyResolve?.({ address: '', line: `frpc 启动失败：${error?.message ?? error}` });
    });
    this.child.on('exit', (code, signal) => {
      this.exited = { code, signal };
      this.readyResolve?.({ address: '', line: `frpc 已退出（code=${code}, signal=${signal}）` });
    });

    this.tail = tailFile(this.logFile, {
      intervalMs: 150,
      fromOffset: 0,
      onLine: line => this.#ingest(line),
    });
    return this;
  }

  /** One log line: record it, classify it, and look for the ready marker. */
  #ingest(rawLine) {
    const line = stripAnsi(rawLine).trim();
    if (line === '') return;
    this.lines.push(line);
    if (this.lines.length > 500) this.lines.shift();
    this.onLine?.(line);

    if (this.publicAddress === '') {
      const ready = FRPC_READY_RE.exec(line);
      if (ready !== null) {
        this.publicAddress = ready[1];
        this.readyResolve?.({ address: ready[1], line });
      }
    }
    for (const signature of FRPC_ERRORS) {
      if (signature.re.test(line)) {
        this.errors.push({ code: signature.code, line });
        break;
      }
    }
  }

  /** Re-read the whole log (useful after a plugin restart). */
  replay() {
    for (const line of readTailLines(this.logFile, 500)) this.#ingest(line);
    return this;
  }

  /** Wait for the tunnel to come up, or fail with the evidence we collected. */
  async waitReady(timeoutMs = this.timeoutMs) {
    const timer = new Promise(resolve => setTimeout(() => resolve({ address: '', line: '等待超时' }), timeoutMs));
    const result = await Promise.race([this.readyPromise, timer]);
    if (result.address !== '') return result;
    const reason = this.errors.length > 0
      ? this.errors.map(e => `[${e.code}] ${e.line}`).join('\n')
      : this.lines.slice(-10).join('\n');
    throw new Error(`frpc 未能在 ${timeoutMs}ms 内就绪：${result.line}\n最近日志：\n${reason}`);
  }

  /** Recent log lines, for the agent to read as evidence. */
  recentLines(count = 60) {
    return readTailLines(this.logFile, count);
  }

  /** Stop only this instance. Windows needs the tree killed (`/T`). */
  async stop({ timeoutMs = 10_000 } = {}) {
    this.tail?.stop();
    this.tail = null;
    if (this.child === null) return;
    const { pid } = this.child;
    if (pid === undefined) return;
    if (process.platform === 'win32') {
      await runQuiet('taskkill', ['/F', '/T', '/PID', String(pid)]);
    } else {
      try {
        this.child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
    const deadline = Date.now() + timeoutMs;
    while (this.running && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    this.child = null;
  }
}

/** Where an instance's log lives when the caller does not choose a path. */
export function defaultFrpcLogFile(proxyIds) {
  const ids = (Array.isArray(proxyIds) ? proxyIds : [proxyIds]).join('_');
  return path.join(dataDir(), 'logs', `frpc-${ids}.log`);
}

/**
 * Make sure we have a writable, empty log file to redirect into.
 *
 * Falls back to the temp directory, and reports `ok:false` when nothing is
 * writable so the caller can still start the process without capture. Refusing
 * to start a tunnel just because a log file could not be created would trade a
 * cosmetic loss for a functional one.
 */
export function prepareLogFile(preferred) {
  const candidates = [
    preferred,
    path.join(os.tmpdir(), 'dsh-openfrp', path.basename(preferred)),
  ];
  for (const candidate of candidates) {
    try {
      fs.mkdirSync(path.dirname(candidate), { recursive: true });
      fs.writeFileSync(candidate, '');
      return { ok: true, path: candidate, fallback: candidate !== preferred };
    } catch {
      /* try the next candidate */
    }
  }
  return { ok: false, path: preferred, fallback: false };
}

/**
 * Kill only processes we can prove are ours: this pid exists, and it is frpc.
 * Deliberately does NOT do `taskkill /IM frpc.exe`, which would take down the
 * user's other (official-launcher) tunnels.
 *
 * 只清理能证明是我们自己的进程；**绝不做** 按映像名全杀。
 */
export async function isOurFrpc(pid) {
  const result = await runCapture('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { timeoutMs: 8000 });
  if (result.ok !== true) return false;
  return /frpc/i.test(result.stdout);
}
