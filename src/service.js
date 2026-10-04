/**
 * dsh-openfrp — the service side: attach, observe, diagnose.
 *
 * The design rule (docs §14.4): **attach, don't own.** A Minecraft server is
 * observed through a log file and commanded through RCON, so it does not matter
 * who started it — the human's `.bat`, PCL2, or a loop script. The plugin never
 * needs to be the parent process, which is exactly what makes it compatible
 * with "the user runs the server, DSH watches it".
 *
 * Everything here is **detected, never configured**: adapter selection keys off
 * conventions (`server.properties`, `logs/latest.log`), never off a directory
 * name, a version, or a mod loader.
 *
 * @module dsh-openfrp/service
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  MC_DONE_RE, MC_BOUND_RE, MC_RCON_RE, MC_BIND_FAIL_RE, MC_OFFLINE_MODE_RE,
} from './protocol.js';
import { readTailLines } from './logtail.js';
import { probeRcon } from './rcon.js';
import { runCapture } from './exec.js';

// ─────────────────────────────────────────────────────────────
// server.properties
// ─────────────────────────────────────────────────────────────

/**
 * Parse a `server.properties` file into a plain object.
 * Escaped colons (`minecraft\:flat`) are unescaped, as the server does.
 *
 * 解析 server.properties。
 */
export function parseServerProperties(text) {
  /** @type {Record<string,string>} */
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).replace(/\\:/g, ':');
    out[key] = value;
  }
  return out;
}

/** Read + parse `server.properties` from a directory; null when absent. */
export function readServerProperties(root) {
  const file = path.join(root, 'server.properties');
  try {
    return parseServerProperties(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Detection
// ─────────────────────────────────────────────────────────────

const MC_MARKERS = ['server.properties', 'eula.txt', 'banned-players.json', 'ops.json'];

/**
 * Decide what kind of service lives in `root`, using only conventions.
 * Returns the evidence for the decision so the agent can explain itself.
 *
 * 用约定判断目录里是什么服务，并把判断依据一起返回。
 */
export function detectService(root) {
  const absolute = path.resolve(root);
  const evidence = [];
  let exists = false;
  try {
    exists = fs.statSync(absolute).isDirectory();
  } catch {
    return { kind: 'unknown', root: absolute, evidence: ['目录不存在'], confident: false };
  }
  if (!exists) return { kind: 'unknown', root: absolute, evidence: ['不是目录'], confident: false };

  for (const marker of MC_MARKERS) {
    if (fs.existsSync(path.join(absolute, marker))) evidence.push(marker);
  }
  const logsDir = path.join(absolute, 'logs');
  if (fs.existsSync(logsDir)) evidence.push('logs/');
  const props = readServerProperties(absolute);

  if (evidence.length === 0) {
    // Nothing service-shaped here; the caller may still attach by port.
    return { kind: 'unknown', root: absolute, evidence: ['没有识别到服务端特征文件'], confident: false };
  }

  return {
    kind: 'minecraft-java',
    root: absolute,
    evidence,
    confident: props !== null || evidence.includes('logs/'),
    properties: props,
  };
}

// ─────────────────────────────────────────────────────────────
// Ports
// ─────────────────────────────────────────────────────────────

/** Is something listening on host:port? A real TCP connect, not a guess. */
export function isPortListening(host, port, timeoutMs = 1200) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port });
    const done = result => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** Ask the OS for an unused TCP port. Used only when we create a service ourselves. */
export function findFreePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

// ─────────────────────────────────────────────────────────────
// Reading the truth out of the log
// ─────────────────────────────────────────────────────────────

/**
 * The port the server *actually* bound, or null. Trust this over the config
 * file — a config can lie, the log cannot (docs §13.3).
 *
 * 服务端**实际**绑定的端口。
 */
export function boundPortFromLog(lines) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = MC_BOUND_RE.exec(lines[i]);
    if (match !== null) return Number(match[1]);
  }
  return null;
}

/** Was the server fully up (in this log)? */
export function isReadyFromLog(lines) {
  return lines.some(line => MC_DONE_RE.test(line));
}

/** Did the server die trying to bind? */
export function bindFailureFromLog(lines) {
  return lines.find(line => MC_BIND_FAIL_RE.test(line)) ?? null;
}

/** Was offline/insecure mode announced? Worth warning about before exposing. */
export function offlineModeFromLog(lines) {
  return lines.some(line => MC_OFFLINE_MODE_RE.test(line));
}

/** RCON endpoint as announced by the server itself. */
export function rconFromLog(lines) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = MC_RCON_RE.exec(lines[i]);
    if (match !== null) return { host: match[1], port: Number(match[2]) };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// Attach
// ─────────────────────────────────────────────────────────────

/**
 * Build a ServiceHandle (docs §14.4). Pure resolution: reads files, probes
 * nothing, starts nothing.
 *
 * 构造 ServiceHandle。只做解析：读文件，不探测、不启动。
 */
export async function attachService({ id, target, port, host = '127.0.0.1', kindHint } = {}) {
  const absolute = path.resolve(target);
  const detection = kindHint !== undefined ? { kind: kindHint, root: absolute, evidence: ['由调用方指定'], confident: true, properties: readServerProperties(absolute) } : detectService(absolute);
  const logFile = path.join(absolute, 'logs', 'latest.log');
  const hasLog = fs.existsSync(logFile);
  const lines = hasLog ? readTailLines(logFile, 400) : [];

  const properties = detection.properties ?? null;
  let localPort = port ?? null;
  const portSources = [];

  if (localPort !== null) portSources.push('调用方指定');

  const bound = boundPortFromLog(lines);
  if (bound !== null) {
    if (localPort !== null && localPort !== bound) portSources.push(`日志显示实际绑定 ${bound}，与指定的 ${localPort} 不一致，采用日志值`);
    else portSources.push('日志中的实际绑定端口');
    localPort = bound;
  } else if (localPort === null && properties?.['server-port'] !== undefined) {
    localPort = Number(properties['server-port']);
    portSources.push('server.properties（日志里还没有绑定记录）');
  }

  // RCON: prefer what the server announced, fall back to config.
  const announced = rconFromLog(lines);
  let rcon = null;
  if (announced !== null) {
    rcon = { host: announced.host === '0.0.0.0' ? '127.0.0.1' : announced.host, port: announced.port, password: properties?.['rcon.password'] ?? '', source: '日志' };
  } else if (properties?.['enable-rcon'] === 'true' && properties?.['rcon.password']) {
    rcon = { host: '127.0.0.1', port: Number(properties['rcon.port'] ?? 25575), password: properties['rcon.password'], source: 'server.properties' };
  }

  const handle = {
    id: id ?? path.basename(absolute),
    kind: detection.kind === 'unknown' && port !== undefined ? 'generic-port' : detection.kind,
    root: absolute,
    host,
    localPort,
    localPortSource: portSources.join('；') || '未知',
    // For a Minecraft server the log path is a CONVENTION, not a discovery: it
    // is `logs/latest.log` whether or not the directory exists yet. A cold start
    // has no `logs/` at all (measured, report v3 D4), and reporting "no log"
    // there would make the very first start undiagnosable. So we always carry
    // the inferred path plus whether it is there right now.
    logs: detection.kind === 'minecraft-java' || hasLog ? { path: logFile, exists: hasLog } : null,
    exec: rcon === null ? null : { kind: 'rcon', ...rcon },
    detection,
    observed: {
      ready: isReadyFromLog(lines),
      offlineMode: offlineModeFromLog(lines),
      bindFailure: bindFailureFromLog(lines),
      logLinesSampled: lines.length,
    },
    configHints: {
      onlineMode: properties?.['online-mode'] ?? null,
      maxPlayers: properties?.['max-players'] ?? null,
      motd: properties?.['motd'] ?? null,
      rconEnabled: properties?.['enable-rcon'] === 'true',
      serverPort: properties?.['server-port'] ?? null,
    },
  };
  return handle;
}

// ─────────────────────────────────────────────────────────────
// Status / reconciliation
// ─────────────────────────────────────────────────────────────

/**
 * Establish what is *actually* true right now, field by field.
 *
 * Note the deliberate ordering: the log is never used to decide liveness.
 * An idle Minecraft server writes nothing at all (measured: 47 s of zero
 * growth), so "log quiet" must never be read as "server dead".
 *
 * 逐项核实当前真实状态。**绝不拿"日志不动"当"服务端死了"**（§13.4）。
 */
export async function probeService(handle, { timeoutMs = 4000 } = {}) {
  const checks = [];

  // 1. Local port — the single most load-bearing fact, because the tunnel is
  //    built from it.
  const listening = handle.localPort === null ? null : await isPortListening(handle.host ?? '127.0.0.1', handle.localPort, timeoutMs);
  checks.push({
    name: 'local-port',
    ok: listening === true,
    detail: handle.localPort === null
      ? '不知道本地端口（日志里没有绑定记录，也没有 server.properties）'
      : listening === true
        ? `${handle.host ?? '127.0.0.1'}:${handle.localPort} 有人在监听`
        : `${handle.host ?? '127.0.0.1'}:${handle.localPort} **无人监听**`,
  });

  // 2. RCON — proves the command channel works, and doubles as liveness.
  let rcon = null;
  if (handle.exec?.kind === 'rcon' && handle.exec.password) {
    rcon = await probeRcon({ host: handle.exec.host, port: handle.exec.port, password: handle.exec.password, timeoutMs });
    // A password change on disk is a normal thing to happen between runs; the
    // attached handle would otherwise hold the stale one (field report M7).
    if (!rcon.alive && rcon.code === 'auth-failed') {
      const refreshed = refreshRconCredentials(handle);
      if (refreshed.changed === true) {
        rcon = await probeRcon({ host: handle.exec.host, port: handle.exec.port, password: handle.exec.password, timeoutMs });
        if (rcon.alive) {
          checks.push({ name: 'rcon-credentials', ok: true, detail: '检测到 server.properties 里的 RCON 凭据已变更，已自动刷新并重连成功。' });
        }
      }
    }
    checks.push({
      name: 'rcon',
      ok: rcon.alive,
      detail: rcon.alive
        ? `RCON 应答：${rcon.reply}`
        : `RCON 不通（${rcon.code}）：${rcon.error}`
          + (rcon.code === 'auth-failed' ? ' —— server.properties 里的 rcon.password 与服务端当前使用的密码不一致；改完配置后重启服务端，或重新 service_attach。' : ''),
    });
  } else {
    checks.push({
      name: 'rcon',
      ok: false,
      detail: handle.configHints?.rconEnabled === true
        ? 'server.properties 开了 RCON 但没读到密码，或服务端尚未打印 RCON 就绪行'
        : '未启用 RCON：需要在 server.properties 设 enable-rcon=true 并填 rcon.password，才能让 DSH 发命令',
    });
  }

  // 3. Log observation (informational only — see the note above).
  const lines = handle.logs ? readTailLines(handle.logs.path, 200) : [];
  checks.push({
    name: 'log',
    ok: lines.length > 0,
    detail: handle.logs
      ? `读到 ${lines.length} 行；就绪标志 ${isReadyFromLog(lines) ? '已出现' : '未出现'}；最后一行：${lines.at(-1) ?? '(空)'}`
      : '没有 logs/latest.log',
  });

  return {
    id: handle.id,
    running: listening === true || rcon?.alive === true,
    checks,
    evidence: {
      lastLines: lines.slice(-5),
      bindFailure: bindFailureFromLog(lines),
      offlineMode: offlineModeFromLog(lines),
      ready: isReadyFromLog(lines),
      boundPort: boundPortFromLog(lines),
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Evidence-based diagnosis
// ─────────────────────────────────────────────────────────────

/**
 * Turn observations into *conclusions with evidence* — the whole point of the
 * plugin (docs §14.7). Each finding carries the raw line that proves it, so the
 * agent can say "返回了 X，是 Y 问题" instead of "可能是 Z".
 *
 * 把观测变成**带证据的结论**。
 *
 * @returns {{findings: Array<{code:string,severity:string,problem:string,evidence:string,fix:string}>}}
 */
export function diagnoseFromObservations({ status, handle, tunnel } = {}) {
  const findings = [];
  const add = (code, severity, problem, evidence, fix) => findings.push({ code, severity, problem, evidence, fix });

  const lastLines = status?.evidence?.lastLines ?? [];
  const listening = status?.checks?.find(c => c.name === 'local-port')?.ok === true;
  const rconAlive = status?.checks?.find(c => c.name === 'rcon')?.ok === true;

  if (status?.evidence?.bindFailure) {
    add('port-taken', 'blocker', '服务端启动失败：端口被占用',
      status.evidence.bindFailure,
      '换一个 server-port，或先找出占用该端口的进程并结束它。');
  }

  if (!listening && status?.evidence?.ready === false) {
    add('not-started', 'blocker', '服务端没有处于就绪状态',
      lastLines.at(-1) ?? '(没有日志)',
      '检查启动脚本输出；若日志为空，说明进程根本没起来（Java 版本 / 内存 / 启动命令）。');
  }

  if (listening && !rconAlive) {
    add('no-command-channel', 'high', '服务端在跑，但 DSH 没有命令通道',
      status?.checks?.find(c => c.name === 'rcon')?.detail ?? '(无)',
      '在 server.properties 里设 enable-rcon=true、rcon.password=<密码>，然后重启服务端。');
  }

  if (status?.evidence?.offlineMode) {
    add('offline-mode', 'medium', '服务端正版验证已关闭（offline-mode=false）',
      lastLines.find(l => MC_OFFLINE_MODE_RE.test(l)) ?? '',
      '对外暴露前请确认这是有意的：任何人都能用任意 ID 进入。');
  }

  // Tunnel ↔ service mismatch: the classic "tunnel is up but players can't join".
  if (tunnel !== undefined && tunnel !== null && handle?.localPort !== null && handle?.localPort !== undefined) {
    const target = tunnel.localPort;
    if (target !== undefined && target !== null && Number(target) !== Number(handle.localPort)) {
      add('port-mismatch', 'blocker', '隧道指向的本地端口与服务端实际端口不一致',
        `隧道 local_port=${target}，服务端实际端口=${handle.localPort}（来源：${handle.localPortSource}）`,
        '把隧道的 local_port 改成实际端口，或让服务端监听隧道指向的那个端口。');
    }
    if (tunnel.errors?.length > 0) {
      for (const error of tunnel.errors) {
        if (error.code === 'local-unreachable') {
          add('local-unreachable', 'blocker', 'frpc 连不上本地服务',
            error.line,
            '确认服务端在跑、端口一致、且服务端监听的不是仅限某个网卡的地址。');
        } else if (error.code === 'proxy-conflict' || error.code === 'multi-instance-racing') {
          add('proxy-conflict', 'blocker', '同一条隧道被重复开启',
            error.line,
            '这条隧道已经在别处运行（很可能是官方启动器）。先关掉那一处，或改用另一条隧道。');
        } else if (error.code === 'token-rejected') {
          add('token-rejected', 'blocker', 'OpenFrp 拒绝了这个用户 token',
            error.line,
            'token 可能已重置或账号状态异常；重新登录获取新的 token。');
        } else {
          add(error.code, 'high', `frpc 报告错误：${error.code}`, error.line, '按 frpc 原始日志处理。');
        }
      }
    }
  }

  if (findings.length === 0) {
    add('healthy', 'info', '没有发现明确问题',
      status?.checks?.map(c => `${c.name}: ${c.detail}`).join(' | ') ?? '(无检查项)',
      '如果玩家仍有问题，请提供具体现象（连不上 / 卡顿 / 掉线），再针对性取证。');
  }

  return { findings };
}

// ─────────────────────────────────────────────────────────────
// Credential refresh (field report M7)
// ─────────────────────────────────────────────────────────────

/**
 * Re-read `server.properties` and update the handle's RCON endpoint if it
 * changed. Without this, editing the file (a normal thing to do between runs)
 * leaves the attached handle holding the old password and every command fails
 * with `auth-failed` until the user re-attaches.
 *
 * 重新读取 server.properties 并更新 RCON 凭据 —— 否则改过配置后必须先重新挂靠。
 */
export function refreshRconCredentials(handle) {
  if (handle === null || handle === undefined) return { changed: false };
  const properties = readServerProperties(handle.root);
  if (properties === null) return { changed: false };
  const password = properties['rcon.password'] ?? '';
  const port = Number(properties['rcon.port'] ?? 25575);
  const enabled = properties['enable-rcon'] === 'true';
  if (!enabled || password === '') {
    return { changed: false, note: 'server.properties 里没有启用 RCON（enable-rcon=true + rcon.password）。' };
  }
  const previous = handle.exec;
  const changed = previous === null
    || previous.password !== password
    || Number(previous.port) !== port;
  handle.exec = { kind: 'rcon', host: '127.0.0.1', port, password, source: 'server.properties（已刷新）' };
  return { changed, port };
}

// ─────────────────────────────────────────────────────────────
// Starting a service (field report M8)
// ─────────────────────────────────────────────────────────────

/** Script names we recognise as "this is how you start it", most specific first. */
const START_SCRIPT_PATTERNS = [
  /^启动服务器\.(bat|cmd|ps1)$/i,
  /^start[-_]?server\.(bat|cmd|ps1)$/i,
  /^启动.*\.(bat|cmd|ps1)$/,
  /^start.*\.(bat|cmd|ps1)$/i,
  /^run\.(bat|cmd|sh)$/i,
];

/**
 * Work out how this service should be started, and say what the evidence was.
 *
 * Deliberately conservative: a start script in the directory always wins over
 * guessing a `java -jar` command, because the script may encode hard-won
 * knowledge (a Fabric modpack must launch as `-cp _launch Launch`, never
 * `-jar`, or every mixin dies with ClassCastException).
 *
 * 推断该服务应当如何启动，并把依据一起返回。目录里有启动脚本就优先用它。
 */
export function detectStartPlan(root) {
  const absolute = path.resolve(root);
  let entries = [];
  try {
    entries = fs.readdirSync(absolute);
  } catch {
    return { ok: false, reason: `目录不存在或不可读：${absolute}` };
  }

  for (const pattern of START_SCRIPT_PATTERNS) {
    const match = entries.find(name => pattern.test(name));
    if (match !== undefined) {
      return {
        ok: true,
        kind: 'script',
        script: path.join(absolute, match),
        evidence: `目录里存在启动脚本 ${match}（优先使用它 —— 脚本里可能包含必须的启动方式，例如 Fabric 整合包必须 -cp _launch Launch 而不是 -jar）`,
      };
    }
  }

  const jar = entries.find(name => /^server\.jar$/i.test(name)) ?? entries.find(name => /\.jar$/i.test(name));
  if (jar !== undefined) {
    return {
      ok: true,
      kind: 'java-jar',
      jar: path.join(absolute, jar),
      evidence: `目录里有 ${jar}，可以用 java -jar 启动（若这是 Fabric/Forge 整合包，请改用其自带启动脚本）`,
      caveat: 'java -jar 只对原版/Paper 这类服务端可靠；Fabric/Forge 整合包需要它们自己的启动方式。',
    };
  }

  return { ok: false, reason: `在 ${absolute} 里既没找到启动脚本，也没找到可执行的 jar。请显式提供 script 参数。` };
}

/**
 * Start a command **detached from the DSH process tree**, capturing its output
 * into a file.
 *
 * Two things this gets right that a naive `spawn` does not:
 *
 *  - **`stdio` is a file descriptor, never a pipe.** A confined DSH sandbox
 *    rejects piped stdio with `EPERM` (measured), and we do not need a pipe: the
 *    file is readable afterwards, and it is how we report *why* a start failed.
 *  - **The output file is what makes failure diagnosable.** Report v3 D1: a
 *    start that silently did nothing was indistinguishable from one that was
 *    killed. With stdout/stderr on disk plus a pid, "it never spawned" and "it
 *    spawned and died" become different answers.
 *
 * @returns {{pid:number|null, command:string, args:string[], cwd:string, logFile:string|null}}
 */
export function startDetached({ command, args, cwd, logFile = null, extraEnv = {} }) {
  let fds = null;
  if (logFile !== null) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, '');
    fds = [fs.openSync(logFile, 'a'), fs.openSync(logFile, 'a')];
  }
  let child;
  try {
    child = spawn(command, args, {
      cwd,
      detached: true,
      windowsHide: true,
      stdio: fds === null ? 'ignore' : ['ignore', fds[0], fds[1]],
      env: { ...process.env, ...extraEnv },
    });
  } finally {
    if (fds !== null) for (const fd of fds) fs.closeSync(fd);
  }
  child.unref();
  return { pid: child.pid ?? null, command, args, cwd, logFile };
}

/**
 * Watch a freshly started process and report what actually happened.
 *
 * Distinguishes the three outcomes that used to be conflated (report v3 D1/D5):
 * `exited` (with the exit code and its output on disk), `listening` (it is up),
 * and `timeout` (still starting — or wedged).
 */
export async function watchStart(pid, { port = null, host = '127.0.0.1', timeoutMs = 180_000, pollMs = 1000, onTick } = {}) {
  const deadline = Date.now() + timeoutMs;
  let ticks = 0;
  for (;;) {
    ticks += 1;
    const alive = await pidsAlive([pid]);
    const listening = port === null ? false : await isPortListening(host, port, 1200);
    if (listening) return { outcome: 'listening', ticks, alive: alive.length > 0 };
    if (alive.length === 0) return { outcome: 'exited', ticks, alive: false };
    if (Date.now() >= deadline) return { outcome: 'timeout', ticks, alive: true };
    onTick?.({ ticks, alive: true, listening: false });
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}

/** Build the detached-start invocation for a plan. */
export function planToCommand(plan, { platform = process.platform, java = '' } = {}) {
  if (plan.kind === 'script') {
    const lower = plan.script.toLowerCase();
    if (lower.endsWith('.ps1')) {
      return { command: 'powershell', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', plan.script] };
    }
    if (platform === 'win32') {
      return { command: 'cmd', args: ['/c', plan.script] };
    }
    return { command: plan.script, args: [] };
  }
  if (plan.kind === 'java-jar') {
    if (java === '') throw new Error('启动 jar 需要 Java 路径，但没有找到可用的 java。');
    return { command: java, args: ['-jar', plan.jar, 'nogui'] };
  }
  throw new Error(`不认识的启动方式：${plan.kind}`);
}

/** Find a usable `java`, preferring a Java 25+ runtime for modern servers. */
export function findJava({ platform = process.platform } = {}) {  const candidates = platform === 'win32'
    ? [
      'C:\\Program Files\\Java\\jdk-25.0.4\\bin\\java.exe',
      'C:\\Program Files\\Java\\jdk-26.0.2\\bin\\java.exe',
      'C:\\Program Files\\Java\\latest\\bin\\java.exe',
    ]
    : ['/usr/bin/java', '/usr/local/bin/java'];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return '';
}

// ─────────────────────────────────────────────────────────────
// Process identification and the four-state machine
//
// This is where the world lock (`session.lock`) is actually avoided.
// ─────────────────────────────────────────────────────────────

// Output capture lives in exec.js and deliberately never uses a pipe — see that
// module for the measurement (piped stdio ⇒ EPERM under a confined sandbox,
// which is the DEFAULT mode).

/**
 * Command-line markers that identify THIS service's process — **absolute paths**,
 * never bare filenames.
 *
 * Two measured traps this avoids (report v3 §D2):
 *  1. Matching on the bare name `server.jar` also matched *our own probe
 *     process*, because the probe's command line contained the string. The
 *     detector then reported "starting", `service_start` waited instead of
 *     spawning, and the real cause of "the server never starts" was our own
 *     false positive.
 *  2. Exact process names are useless (`frpc_windows_amd64`), so we stay on the
 *     command line — but anchored to an absolute path inside this service's
 *     directory, which no unrelated process has a reason to contain.
 */
export function serviceProcessMarkers(handle, plan = null) {
  const markers = [];
  if (plan !== null && plan.ok === true && plan.kind === 'java-jar' && plan.jar !== undefined) {
    markers.push(path.resolve(plan.jar));
  }
  if (plan !== null && plan.ok === true && plan.kind === 'script' && plan.script !== undefined) {
    markers.push(path.resolve(plan.script));
  }
  const root = handle?.root;
  if (typeof root === 'string' && root !== '') {
    // The directory itself covers modded launchers (`-cp <root>/_launch Launch`)
    // and jars that were renamed. False positives are handled by excluding our
    // own process tree, not by weakening the marker.
    markers.push(path.resolve(root));
    markers.push(path.join(path.resolve(root), 'server.jar'));
  }
  return [...new Set(markers.filter(m => typeof m === 'string' && m !== ''))];
}

/** Process names that can plausibly be *the service* for a given plan. */
function serviceNameFilter(plan) {
  if (plan !== null && plan.ok === true && plan.kind === 'java-jar') return /java/i;
  return /java|bedrock|cmd|powershell|pwsh|sh|bash/i;
}

/**
 * Read the process table once. Returns pid, parent pid, name, start time and
 * command line — enough to derive both the ancestor chain and the matches
 * without a second shell call.
 */
async function readProcessTable({ platform = process.platform } = {}) {
  if (platform === 'win32') {
    const script = '$p = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | '
      + "Where-Object { $_.Name -match 'java|frpc|node|cmd|powershell|pwsh|bedrock' }); "
      + "if ($p.Count -eq 0) { '[]' } else { $p | Select-Object ProcessId, ParentProcessId, Name, "
      + "@{n='CreatedAt';e={$_.CreationDate.ToString('o')}}, CommandLine | ConvertTo-Json -Compress -Depth 3 }";
    const result = await runCapture('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
    if (result.ok !== true) return [];
    const text = result.stdout.trim();
    if (text === '' || text === '[]') return [];
    try {
      const parsed = JSON.parse(text);
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      return rows.map(row => ({
        pid: Number(row.ProcessId),
        ppid: Number(row.ParentProcessId),
        name: String(row.Name ?? ''),
        startedAt: row.CreatedAt ?? null,
        ageSeconds: row.CreatedAt === null || row.CreatedAt === undefined
          ? null
          : Math.max(0, Math.round((Date.now() - Date.parse(row.CreatedAt)) / 1000)),
        commandLine: String(row.CommandLine ?? ''),
      })).filter(row => Number.isInteger(row.pid));
    } catch {
      return [];
    }
  }

  const result = await runCapture('ps', ['-eo', 'pid,ppid,comm,args']);
  if (result.ok !== true) return [];
  return result.stdout.split(/\r?\n/).slice(1).map(line => {
    const parts = line.trim().split(/\s+/);
    return {
      pid: Number(parts[0]),
      ppid: Number(parts[1]),
      name: String(parts[2] ?? ''),
      startedAt: null,
      ageSeconds: null,
      commandLine: parts.slice(3).join(' '),
    };
  }).filter(row => Number.isInteger(row.pid));
}

/** This process plus every ancestor — the probe must never match itself. */
function ancestorPids(table, startPid = process.pid) {
  const excluded = new Set([startPid]);
  if (typeof process.ppid === 'number') excluded.add(process.ppid);
  const byPid = new Map(table.map(row => [row.pid, row]));
  let cursor = startPid;
  for (let i = 0; i < 32; i += 1) {
    const row = byPid.get(cursor);
    if (row === undefined) break;
    cursor = row.ppid;
    if (!Number.isInteger(cursor) || cursor <= 0 || excluded.has(cursor)) break;
    excluded.add(cursor);
  }
  return excluded;
}

/**
 * List processes whose command line matches this service.
 *
 * Excludes our own process and its whole ancestor chain: the detector is itself
 * a node process whose command line can contain the very strings it searches for.
 */
export async function findServiceProcesses(handle, { markers, plan = null, platform = process.platform } = {}) {
  const list = markers ?? serviceProcessMarkers(handle, plan);
  if (list.length === 0) return [];
  const nameFilter = serviceNameFilter(plan);

  const table = await readProcessTable({ platform });
  if (table.length === 0) return [];
  const excluded = ancestorPids(table, process.pid);

  return table
    .filter(row => !excluded.has(row.pid))
    .filter(row => row.commandLine !== '' && list.some(marker => row.commandLine.includes(marker)))
    .filter(row => row.name === '' || nameFilter.test(row.name))
    .map(({ pid, startedAt, ageSeconds, commandLine, name }) => ({ pid, startedAt, ageSeconds, commandLine, name }));
}

/** The readiness-guard formula, in one place. 就绪保护期的公式。 */
export function bootWaitSecondsFor({ kind = 'minecraft-java', coldStartSeconds = null } = {}) {
  // Measured: vanilla MC 26.2 binds its port ~9-12s after launch; a 110-mod
  // Fabric pack needs 40-60s. The guard is 2-3x the cold-start time.
  const measured = coldStartSeconds ?? (kind === 'minecraft-java' ? 60 : 20);
  return Math.max(60, Math.round(measured * 3));
}

/**
 * The four states, and why the third one is the one that bites.
 *
 * | state    | evidence                          | correct action          | if you get it wrong        |
 * |----------|-----------------------------------|-------------------------|----------------------------|
 * | cold     | port quiet, no process            | start                   | —                          |
 * | running  | port is listening                 | stop first, then start  | user thinks it restarted   |
 * | starting | port quiet, process young         | **wait, do not start**  | second copy fights `session.lock` |
 * | zombie   | port quiet, process old/very old  | clear it, then start    | it keeps holding the lock  |
 *
 * `session.lock` **always exists** — the file being present means nothing. Only
 * "can the lock be acquired" matters, and that can only be inferred from process
 * state, never from `Test-Path session.lock`.
 *
 * 四态判定。**世界锁规避就落在这里**：第三种状态（启动中）另起一个实例，
 * 两个都会去抢 session.lock，结果是谁都起不来。
 */
export async function detectServiceState(handle, { bootWaitSeconds = null, timeoutMs = 1500, plan = null } = {}) {
  const guardSource = bootWaitSeconds === null ? 'formula(冷启动耗时 ×2-3)' : '调用方指定';
  const guard = bootWaitSeconds ?? bootWaitSecondsFor({ kind: handle?.kind });
  const resolvedPlan = plan ?? (typeof handle?.root === 'string' ? detectStartPlan(handle.root) : null);

  const listening = handle?.localPort === null || handle?.localPort === undefined
    ? false
    : await isPortListening(handle.host ?? '127.0.0.1', handle.localPort, timeoutMs);

  const processes = await findServiceProcesses(handle, { plan: resolvedPlan });
  const youngest = processes.slice().sort((a, b) => (a.ageSeconds ?? 0) - (b.ageSeconds ?? 0))[0] ?? null;

  if (listening) {
    return {
      state: 'running',
      listening,
      processes,
      guardSeconds: guard,
      guardSource,
      evidence: `端口 ${handle.localPort} 已在监听` + (processes.length > 0 ? `，进程 PID ${processes.map(p => p.pid).join('/')}` : '（未匹配到进程，可能是别的东西占着这个端口）'),
      action: processes.length > 0
        ? '运行中：要重载配置就先优雅停止再启动（跳过这步会让用户以为重启了、其实没换配置）。'
        : '端口被占用但没有匹配到本服务的进程，请先确认占用者是谁。',
    };
  }

  if (youngest === null) {
    return {
      state: 'cold',
      listening,
      processes: [],
      guardSeconds: guard,
      guardSource,
      evidence: '端口没在监听，也没有匹配到本服务的进程',
      action: '冷启动：直接启动。',
    };
  }

  const age = youngest.ageSeconds ?? 0;
  if (age < guard) {
    return {
      state: 'starting',
      listening,
      processes,
      guardSeconds: guard,
      guardSource,
      evidence: `端口还没监听，但进程 PID ${youngest.pid} 只启动了 ${age} 秒（保护期 ${guard} 秒）`,
      action: '⚠️ 启动中：**必须等它就绪，绝不另起**。再起一个会去抢同一个 session.lock，两个都玩不转。',
    };
  }

  return {
    state: 'zombie',
    listening,
    processes,
    guardSeconds: guard,
    guardSource,
    evidence: `端口没在监听，而进程 PID ${youngest.pid} 已经存在 ${age} 秒（超过保护期 ${guard} 秒）`,
    action: '僵尸：卡死/超时的实例同样持着世界锁，必须先清掉再启动，否则下次开服必失败。',
  };
}

/**
 * Are these PIDs still alive? Used to prove whether a start actually spawned
 * something, instead of guessing (report v3 D1: "无法证明是没 spawn 还是被收走").
 */
export async function pidsAlive(pids, { platform = process.platform } = {}) {
  const wanted = new Set(pids.filter(pid => Number.isInteger(pid)));
  if (wanted.size === 0) return [];
  const table = await readProcessTable({ platform });
  return table.filter(row => wanted.has(row.pid)).map(row => ({ pid: row.pid, name: row.name, ageSeconds: row.ageSeconds }));
}

/** Clear the processes belonging to this service (used for the zombie state). */
export async function clearServiceProcesses(handle, { markers, plan = null } = {}) {
  const processes = await findServiceProcesses(handle, { markers, plan });
  const killed = [];
  for (const row of processes) {
    try {
      if (process.platform === 'win32') {
        // eslint-disable-next-line no-await-in-loop
        await new Promise(resolve => {
          spawn('taskkill', ['/F', '/T', '/PID', String(row.pid)], { stdio: 'ignore', windowsHide: true })
            .on('exit', () => resolve())
            .on('error', () => resolve());
        });
      } else {
        process.kill(row.pid, 'SIGTERM');
      }
      killed.push(row.pid);
    } catch {
      /* already gone */
    }
  }
  return { killed, found: processes.map(p => p.pid) };
}

// ─────────────────────────────────────────────────────────────
// Byte-order marks in config files (report v3 D7)
// ─────────────────────────────────────────────────────────────

/**
 * A UTF-8 BOM on `eula.txt` is invisible in every editor and fatal to startup:
 * the server reads the first line as `\uFEFFeula=true`, does not recognise it,
 * and refuses to run. Measured: `Set-Content -Encoding UTF8` on PowerShell 5.1
 * writes exactly that BOM.
 *
 * Returns the offending files, verified from the bytes rather than guessed.
 *
 * 配置文件带 UTF-8 BOM 会让服务端读不懂第一行并拒绝启动。这里从字节直接核实。
 */
export function findBomFiles(root, files = ['eula.txt', 'server.properties', 'whitelist.json', 'ops.json', 'banned-players.json', 'banned-ips.json']) {
  const hits = [];
  for (const name of files) {
    const file = path.join(path.resolve(root), name);
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const head = Buffer.alloc(3);
        const read = fs.readSync(fd, head, 0, 3, 0);
        if (read === 3 && head[0] === 0xEF && head[1] === 0xBB && head[2] === 0xBF) {
          hits.push({ file: name, path: file, bytes: head.toString('hex') });
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      /* missing files are fine */
    }
  }
  return hits;
}

/** Rewrite a file without its UTF-8 BOM, preserving the rest byte-for-byte. */
export function stripBom(file) {
  const bytes = fs.readFileSync(file);
  if (!(bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF)) {
    return { changed: false, bytes: bytes.length };
  }
  const rest = bytes.subarray(3);
  fs.writeFileSync(file, rest);
  return { changed: true, bytes: rest.length, removed: 3 };
}

/**
 * Fix every BOM we can prove is there, and say what we found first.
 * 修复 BOM，并把发现作为证据返回。
 */
export function fixConfigBoms(root) {
  const found = findBomFiles(root);
  const fixed = [];
  for (const hit of found) {
    try {
      const result = stripBom(hit.path);
      fixed.push({ ...hit, fixed: result.changed === true });
    } catch (error) {
      fixed.push({ ...hit, fixed: false, error: String(error?.message ?? error) });
    }
  }
  return { found, fixed };
}
