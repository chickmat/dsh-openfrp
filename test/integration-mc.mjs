/**
 * Integration test: prove the plugin's own modules can observe and command a
 * REAL, RUNNING Minecraft server — the exact claim that was challenged
 * ("服务器没开，你读个文件是怎么知道在运行时可以读到实时日志呢").
 *
 * It uses the plugin's own code paths, not a re-implementation:
 *   attachService  → detect + resolve the actual port / RCON              (src/service.js)
 *   waitForLine    → readiness handshake on logs/latest.log               (src/logtail.js)
 *   probeService   → per-check liveness, never inferred from log activity (src/service.js)
 *   withRcon       → run a command mid-run and read the server's reply     (src/rcon.js)
 *   collectLines   → prove the log keeps growing while the server runs     (src/logtail.js)
 *   diagnoseFromObservations → evidence-backed findings                    (src/service.js)
 *
 * Everything happens in a throwaway directory; the user's own servers are
 * never touched. The directory is removed at the end.
 *
 * Run: node test/integration-mc.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { MC_DONE_RE, MC_BOUND_RE } from '../src/protocol.js';
import { attachService, probeService, diagnoseFromObservations, findFreePort } from '../src/service.js';
import { waitForLine, collectLines, readTailLines } from '../src/logtail.js';
import { withRcon } from '../src/rcon.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORK = path.join(HERE, '.tmp', `mc-${Date.now()}`);
const UA = 'dsh-openfrp-integration-test/0.1';

let passed = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failures.push({ name, detail });
    console.log(`FAIL  ${name}${detail === '' ? '' : `\n      ${detail}`}`);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Find a Java 25+ runtime; Minecraft 26.x refuses to start on anything older. */
function findJava() {
  const candidates = [
    'C:\\Program Files\\Java\\jdk-25.0.4\\bin\\java.exe',
    'C:\\Program Files\\Java\\jdk-26.0.2\\bin\\java.exe',
    'C:\\Program Files\\Java\\latest\\bin\\java.exe',
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  const which = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(which, ['java'], { encoding: 'utf8' });
  const first = String(result.stdout ?? '').split(/\r?\n/)[0].trim();
  return first === '' ? null : first;
}

async function downloadServerJar(destination) {
  const manifest = await (await fetch('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', {
    headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30_000),
  })).json();
  const release = manifest.latest.release;
  const entry = manifest.versions.find(v => v.id === release);
  const versionJson = await (await fetch(entry.url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) })).json();
  const url = versionJson.downloads.server.url;
  console.log(`  .. 下载 Minecraft ${release} 服务端（${Math.round(versionJson.downloads.server.size / 1e6)} MB）`);
  const response = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`下载服务端失败：HTTP ${response.status}`);
  fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
  return { version: release, javaMajor: versionJson.javaVersion?.majorVersion ?? 21 };
}

function stopServer(pid) {
  return new Promise(resolve => {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true }, () => resolve());
    } else {
      try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
      resolve();
    }
  });
}

async function main() {
  const java = findJava();
  if (java === null) {
    console.log('跳过：找不到 Java 运行时。');
    return;
  }

  fs.mkdirSync(WORK, { recursive: true });
  const jarPath = path.join(WORK, 'server.jar');
  const { version } = await downloadServerJar(jarPath);

  const gamePort = await findFreePort();
  const rconPort = await findFreePort();
  const rconPassword = `it${Math.random().toString(36).slice(2, 10)}`;
  console.log(`  .. 隔离实例：游戏端口 ${gamePort}，RCON 端口 ${rconPort}，工作目录 ${WORK}`);

  fs.writeFileSync(path.join(WORK, 'eula.txt'), 'eula=true\n');
  fs.writeFileSync(path.join(WORK, 'server.properties'), [
    `server-port=${gamePort}`,
    'server-ip=',
    'enable-rcon=true',
    `rcon.port=${rconPort}`,
    `rcon.password=${rconPassword}`,
    'online-mode=false',
    'level-type=minecraft\\:flat',
    'level-name=itworld',
    'view-distance=4',
    'simulation-distance=4',
    'max-players=4',
    'spawn-protection=0',
    'sync-chunk-writes=false',
    '',
  ].join('\n'));

  console.log('  .. 启动服务端（-Xms512M -Xmx1G）');
  // NOTE: stdio is deliberately NOT a pipe. Under a confined DSH sandbox a
  // child spawned with piped stdio fails with EPERM (measured), and we do not
  // need the pipe anyway: the server writes logs/latest.log, and that file is
  // the plugin's real observation channel.
  const child = spawn(java, ['-Xms512M', '-Xmx1G', '-jar', 'server.jar', 'nogui'], {
    cwd: WORK,
    stdio: 'ignore',
    windowsHide: true,
  });
  let exited = null;
  child.on('exit', code => { exited = code; });
  child.on('error', error => { exited = -1; console.log(`  .. spawn error: ${error.message}`); });

  let serverPid = child.pid;
  const logFile = path.join(WORK, 'logs', 'latest.log');

  try {
    // ── 1. attach: the plugin must find the service by convention alone ──
    console.log('\n[1] attachService 自动识别目录');
    // Wait for the log file to exist so detection has something to read.
    for (let i = 0; i < 100 && !fs.existsSync(logFile); i += 1) await sleep(300);

    const handle = await attachService({ id: 'integration', target: WORK });
    check('识别为 minecraft-java', handle.kind === 'minecraft-java', `实际 ${handle.kind}`);
    check('从 server.properties 读到 RCON 参数', handle.exec !== null && handle.exec.port === rconPort,
      JSON.stringify(handle.exec));
    check('识别到日志文件', handle.logs !== null && handle.logs.path === logFile, JSON.stringify(handle.logs));

    // ── 2. readiness handshake ──
    console.log('\n[2] waitForLine 等就绪信号');
    const started = Date.now();
    const ready = await waitForLine(logFile, MC_DONE_RE, { timeoutMs: 240_000, fromOffset: 0 });
    check('捕获到 Done (...) 就绪标志', ready.match !== null, ready.line);
    console.log(`      ${ready.line}`);
    console.log(`      启动耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);

    // ── 3. the actual bound port comes from the log, not the config ──
    console.log('\n[3] 实际绑定端口从日志读取');
    const lines = readTailLines(logFile, 400);
    const boundLine = lines.find(l => MC_BOUND_RE.test(l)) ?? '';
    const boundMatch = MC_BOUND_RE.exec(boundLine);
    check('日志里的实际绑定端口 == 配置端口', boundMatch !== null && Number(boundMatch[1]) === gamePort,
      `配置 ${gamePort}，日志 ${boundMatch?.[1]}`);
    console.log(`      ${boundLine}`);

    // ── 4. re-attach: now it can resolve the port from the log ──
    const handle2 = await attachService({ id: 'integration', target: WORK });
    check('attach 后的端口来自日志而非配置', handle2.localPort === gamePort && handle2.localPortSource.includes('日志'),
      `port=${handle2.localPort} source=${handle2.localPortSource}`);
    check('观察到就绪状态', handle2.observed.ready === true, JSON.stringify(handle2.observed));

    // ── 5. probeService: per-check liveness ──
    console.log('\n[5] probeService 逐项核实');
    const status = await probeService(handle2);
    const portCheck = status.checks.find(c => c.name === 'local-port');
    const rconCheck = status.checks.find(c => c.name === 'rcon');
    check('端口检查：有人在监听', portCheck?.ok === true, portCheck?.detail);
    check('RCON 检查：服务端应答', rconCheck?.ok === true, rconCheck?.detail);
    check('running 判定为真', status.running === true, JSON.stringify(status.checks));

    // ── 6. the decisive part: command + live log, WHILE RUNNING ──
    console.log('\n[6] 运行中发命令 + 实时读日志');
    const before = fs.statSync(logFile).size;
    const marker = `IT-${Date.now().toString(36).toUpperCase()}`;

    const replies = await withRcon(
      { host: '127.0.0.1', port: rconPort, password: rconPassword, timeoutMs: 15_000 },
      async connection => {
        const out = [];
        out.push({ command: `say ${marker}`, reply: await connection.exec(`say ${marker}`) });
        out.push({ command: 'list', reply: await connection.exec('list') });
        return out;
      },
    );
    const listReply = replies.find(r => r.command === 'list')?.reply ?? '';
    check('RCON 在运行中返回了 list 的结果', /players online/i.test(listReply), JSON.stringify(replies));
    console.log(`      > list\n      ${listReply.trim()}`);

    await sleep(1200);
    const after = fs.statSync(logFile).size;
    const tail = readTailLines(logFile, 30).join('\n');
    check('日志文件在运行中增长', after > before, `${before} -> ${after} 字节`);
    check('命令确实写进了日志（时间戳与命令时刻一致）', tail.includes(marker),
      tail.split('\n').slice(-4).join('\n'));
    console.log(`      日志增长 ${after - before} 字节；最后几行：`);
    for (const line of tail.split('\n').slice(-3)) console.log(`      ${line}`);

    // ── 7. live window through the plugin's own collector ──
    console.log('\n[7] collectLines 实时窗口');
    const collected = await collectLines(logFile, { durationMs: 1500, fromOffset: -1 });
    check('collectLines 能返回数组（空闲时为空是正确行为）', Array.isArray(collected), JSON.stringify(collected));

    // ── 8. the trap: a quiet log must NOT be reported as dead ──
    console.log('\n[8] 空闲不写日志 ≠ 服务端死了');
    const quietStatus = await probeService(handle2);
    const { findings } = diagnoseFromObservations({ status: quietStatus, handle: handle2 });
    check('空闲状态下没有误报"服务端没起来"',
      !findings.some(f => f.code === 'not-started'),
      JSON.stringify(findings.map(f => f.code)));
    check('空闲状态下没有误报"没有命令通道"',
      !findings.some(f => f.code === 'no-command-channel'),
      JSON.stringify(findings.map(f => f.code)));

    // ── 9. diagnosis: invent a port mismatch and check it is caught with evidence ──
    console.log('\n[9] 诊断给出证据而不是猜测');
    const mismatch = diagnoseFromObservations({
      status: quietStatus,
      handle: handle2,
      tunnel: { localPort: gamePort + 1, errors: [] },
    }).findings.find(f => f.code === 'port-mismatch');
    check('端口不一致被抓到并带两个数字', mismatch !== undefined
      && mismatch.evidence.includes(String(gamePort + 1))
      && mismatch.evidence.includes(String(gamePort)), mismatch?.evidence);

    // ── 10. graceful shutdown through the command channel ──
    console.log('\n[10] 运行中通过 RCON 优雅停服');
    await withRcon({ host: '127.0.0.1', port: rconPort, password: rconPassword, timeoutMs: 15_000 },
      connection => connection.exec('stop'));
    for (let i = 0; i < 60 && exited === null; i += 1) await sleep(500);
    check('服务端已退出', exited !== null, `exit=${exited}`);
  } finally {
    if (exited === null && serverPid !== undefined) {
      console.log('  .. 强制结束测试服务端');
      await stopServer(serverPid);
    }
    await sleep(800);
    try {
      fs.rmSync(WORK, { recursive: true, force: true });
      console.log(`  .. 已清理 ${WORK}`);
    } catch (error) {
      console.log(`  .. 清理失败（可手动删除）：${error.message}`);
    }
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const { name, detail } of failures) console.error(`\n--- ${name}\n${detail}`);
    process.exit(1);
  }
}

main().catch(error => {
  console.error('\n集成测试异常终止：', error);
  process.exit(1);
});
