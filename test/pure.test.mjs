/**
 * Pure-logic tests. No network, no Minecraft, no DSH — every assertion here is
 * about a fact we read out of the official sources or measured on this machine.
 *
 * Run: node test/pure.test.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  stripAnsi, isValidPort, cleanChildEnv, MC_DONE_RE, MC_BOUND_RE, MC_RCON_RE, MC_BIND_FAIL_RE, MC_OFFLINE_MODE_RE,
  FRPC_READY_RE, FRPC_ERRORS,
  isValidTunnelName, sanitizeTunnelName, tunnelNameFor, TUNNEL_NAME_RE,
  isLikelyProtectedRemotePort, pickRemotePortCandidates, classifyRemotePortError,
} from '../src/protocol.js';
import { encodePacket, decodePacket, stripFormatting } from '../src/rcon.js';
import { parseServerProperties, boundPortFromLog, isReadyFromLog, bindFailureFromLog, offlineModeFromLog, rconFromLog, diagnoseFromObservations, detectStartPlan, planToCommand, refreshRconCredentials, bootWaitSecondsFor, serviceProcessMarkers } from '../src/service.js';
import { publicAddressOf, cnameTargetOf, rankNodes, portAllowedByNode } from '../src/openfrp-client.js';
import { normalizeProxyFields } from '../src/actions.js';
import { b64urlPadded, b64DecodeAny } from '../src/openfrp-auth.js';
import { listZipEntries, extractZip, frpcNames, frpcCandidates, readFlatTarGz, prepareLogFile } from '../src/frpc.js';
import { readTailLines, tailFile } from '../src/logtail.js';
import { loadCredentials, saveCredentials, replaceCredentials } from '../src/registry.js';
import { buildExportFiles, userInstruction, EXPORT_DIR_NAME } from '../src/script-templates.js';
import zlib from 'node:zlib';

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`FAIL  ${name}\n      ${error.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`FAIL  ${name}\n      ${error.message}`);
  }
}

console.log('\nprotocol / log patterns');

test('stripAnsi removes frpc colour codes', () => {
  assert.equal(stripAnsi('\u001b[1;34mhello\u001b[0m'), 'hello');
  assert.equal(stripAnsi('plain'), 'plain');
});

test('isValidPort', () => {
  assert.equal(isValidPort(25565), true);
  assert.equal(isValidPort(0), false);
  assert.equal(isValidPort(65536), false);
  assert.equal(isValidPort(1.5), false);
});

test('cleanChildEnv drops proxy vars and de-duplicates case-insensitively', () => {
  const env = cleanChildEnv({ PATH: 'x', HTTP_PROXY: 'a', http_proxy: 'b', NO_PROXY: 'c', KEEP: 'y' }, {});
  assert.equal(env.PATH, 'x');
  assert.equal(env.KEEP, 'y');
  assert.equal(env.HTTP_PROXY, undefined);
  assert.equal(env.http_proxy, undefined);
  assert.equal(env.NO_PROXY, undefined);
});

test('Minecraft readiness marker matches the measured line', () => {
  // Measured: [22:40:17] [Server thread/INFO]: Done (0.425s)! For help, type "help"
  const match = MC_DONE_RE.exec('[22:40:17] [Server thread/INFO]: Done (0.425s)! For help, type "help"');
  assert.notEqual(match, null);
  assert.equal(match[1], '0.425');
});

test('Minecraft bound-port marker matches "*:25999"', () => {
  const match = MC_BOUND_RE.exec('[22:40:16] [Server thread/INFO]: Starting Minecraft server on *:25999');
  assert.notEqual(match, null);
  assert.equal(match[1], '25999');
});

test('RCON / bind-failure / offline-mode markers', () => {
  assert.equal(MC_RCON_RE.exec('[22:40:17] [Server thread/INFO]: RCON running on 0.0.0.0:25998')[2], '25998');
  assert.notEqual(MC_BIND_FAIL_RE.exec('**** FAILED TO BIND TO PORT!'), null);
  assert.notEqual(MC_OFFLINE_MODE_RE.exec('**** SERVER IS RUNNING IN OFFLINE/INSECURE MODE!'), null);
});

test('frpc ready pattern accepts BOTH wordings (Chinese one is what OF ships)', () => {
  // The OpenFrp build prints this; matching only English was a field-found bug:
  // frpc reported success and the plugin still timed out after 90s.
  const zh = '[client/control_ext.go:37] [tcp] 隧道 [dshmc] 启动成功, 请使用 [kr-se-cncn-1.ofalias.net:55219] 来连接服务.';
  const zhMatch = FRPC_READY_RE.exec(zh);
  assert.notEqual(zhMatch, null, 'Chinese success line must match');
  assert.equal(zhMatch[1], 'kr-se-cncn-1.ofalias.net:55219');

  const en = 'Your `wdsj` proxy is available now. Use [`ca13474b716f.ofalias.com:55218`] to connect.';
  const enMatch = FRPC_READY_RE.exec(en);
  assert.notEqual(enMatch, null, 'English success line must still match');
  assert.equal(enMatch[1], 'ca13474b716f.ofalias.com:55218');
});

test('frpc error signatures include the Chinese ones and the :0 signature', () => {
  const classify = line => FRPC_ERRORS.find(s => s.re.test(line))?.code;
  assert.equal(
    classify('[E] [proxy.go:208] [dshmc] 无法连接到本地服务 [127.0.0.1:0] error: dial tcp 127.0.0.1:0: connectex: The requested address is not valid in its context.'),
    'local-unreachable',
  );
  assert.equal(classify('dial tcp 127.0.0.1:0: connectex: nope'), 'zero-local-port');
  assert.equal(classify('隧道冲突'), 'proxy-conflict');
  assert.equal(classify('端口已被占用'), 'remote-port-taken');
});

test('frpc error signatures classify real lines', () => {
  const classify = line => FRPC_ERRORS.find(s => s.re.test(line))?.code;
  assert.equal(classify('connect to local service [127.0.0.1:25565] error: dial tcp connection refused'), 'local-unreachable');
  assert.equal(classify('proxy conflict'), 'proxy-conflict');
  assert.equal(classify('multi-instance racing, this one failed'), 'multi-instance-racing');
  assert.equal(classify('OpenFRP API 拒绝请求 [403 Forbidden, 用户不存在或用户状态异常]'), 'token-rejected');
  assert.equal(classify('all good here'), undefined);
});

console.log('\nserver.properties + log reading');

test('parseServerProperties handles comments, blanks and escaped colons', () => {
  const props = parseServerProperties([
    '#Minecraft server properties',
    '',
    'enable-rcon=true',
    'rcon.port=25575',
    'rcon.password=fb0gn9quy3pavh5w',
    'level-type=minecraft\\:flat',
    'motd=hello=world',
  ].join('\n'));
  assert.equal(props['enable-rcon'], 'true');
  assert.equal(props['rcon.port'], '25575');
  assert.equal(props['rcon.password'], 'fb0gn9quy3pavh5w');
  assert.equal(props['level-type'], 'minecraft:flat');
  assert.equal(props.motd, 'hello=world');
});

test('log-derived facts pick the LAST occurrence', () => {
  const lines = [
    '[t] Starting Minecraft server on *:25565',
    '[t] Done (1.0s)! For help, type "help"',
    '[t] RCON running on 0.0.0.0:25575',
    '[t] Starting Minecraft server on *:25570',
    '[t] RCON running on 0.0.0.0:25576',
  ];
  assert.equal(boundPortFromLog(lines), 25570);
  assert.deepEqual(rconFromLog(lines), { host: '0.0.0.0', port: 25576 });
  assert.equal(isReadyFromLog(lines), true);
  assert.equal(isReadyFromLog(['nothing here']), false);
  assert.equal(bindFailureFromLog(['**** FAILED TO BIND TO PORT!']).includes('FAILED'), true);
  assert.equal(offlineModeFromLog(['**** SERVER IS RUNNING IN OFFLINE/INSECURE MODE!']), true);
});

await testAsync('tailFile streams appended lines', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-openfrp-tail-'));
  const file = path.join(dir, 'latest.log');
  fs.writeFileSync(file, '');
  const seen = [];
  const watch = tailFile(file, { intervalMs: 40, fromOffset: 0, onLine: line => seen.push(line) });
  await new Promise(r => setTimeout(r, 80));
  fs.appendFileSync(file, 'first\nsecond\n');
  await new Promise(r => setTimeout(r, 200));
  watch.stop();
  assert.deepEqual(seen, ['first', 'second']);
  fs.rmSync(dir, { recursive: true, force: true });
});

await testAsync('tailFile survives rotation to a SHORTER file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-openfrp-tail2-'));
  const file = path.join(dir, 'latest.log');
  fs.writeFileSync(file, 'aaaaaaaaaaaaaaaaaaaa\n'); // 21 bytes
  const seen = [];
  const watch = tailFile(file, { intervalMs: 40, fromOffset: 0, onLine: line => seen.push(line) });
  await new Promise(r => setTimeout(r, 150));
  fs.writeFileSync(file, 'short\n'); // 6 bytes — clearly smaller than our offset
  await new Promise(r => setTimeout(r, 250));
  watch.stop();
  assert.equal(seen.at(-1), 'short');
  fs.rmSync(dir, { recursive: true, force: true });
});

await testAsync('tailFile survives rotation to a LONGER file (size alone cannot detect this)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-openfrp-tail3-'));
  const file = path.join(dir, 'latest.log');
  // Both contents are the same length first, to prove the fingerprint check is
  // what saves us, not a size comparison.
  fs.writeFileSync(file, 'first\nsecond\n'); // 13 bytes
  const seen = [];
  const watch = tailFile(file, { intervalMs: 40, fromOffset: 0, onLine: line => seen.push(line) });
  await new Promise(r => setTimeout(r, 200));
  assert.deepEqual(seen, ['first', 'second']);
  // Rewrite in place with content that is LONGER than our current offset.
  fs.writeFileSync(file, 'a-brand-new-server-log-line\n'); // 28 bytes > 13
  await new Promise(r => setTimeout(r, 300));
  watch.stop();
  assert.equal(seen.at(-1), 'a-brand-new-server-log-line');
  fs.rmSync(dir, { recursive: true, force: true });
});

await testAsync('readTailLines returns the last N non-empty lines', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-openfrp-tail2-'));
  const file = path.join(dir, 'latest.log');
  fs.writeFileSync(file, Array.from({ length: 50 }, (_, i) => `line-${i}`).join('\n') + '\n');
  const lines = readTailLines(file, 5);
  assert.deepEqual(lines, ['line-45', 'line-46', 'line-47', 'line-48', 'line-49']);
  assert.deepEqual(readTailLines(path.join(dir, 'missing.log'), 5), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log('\nRCON wire format');

test('RCON packet round-trips (login / command / response)', () => {
  const login = encodePacket(1, 3, 'secret');
  const decoded = decodePacket(login);
  assert.notEqual(decoded, null);
  assert.equal(decoded.id, 1);
  assert.equal(decoded.type, 3);
  assert.equal(decoded.body, 'secret');
  assert.equal(decoded.rest.length, 0);

  const command = encodePacket(2, 2, 'list');
  assert.equal(decodePacket(command).body, 'list');
});

test('RCON decode waits for a complete packet', () => {
  const packet = encodePacket(7, 0, 'There are 0 of a max of 4 players online:');
  assert.equal(decodePacket(packet.subarray(0, 6)), null);
  const decoded = decodePacket(packet);
  assert.equal(decoded.id, 7);
  assert.equal(decoded.type, 0);
  assert.match(decoded.body, /0 of a max of 4/);
});

test('RCON formatting codes are stripped (latin1 + section sign)', () => {
  assert.equal(stripFormatting('\u00a7aHello \u00a7rworld'), 'Hello world');
});

console.log('\ntunnel maths');

test('publicAddressOf mirrors the official launcher rule', () => {
  assert.equal(publicAddressOf({ connectAddress: 'cn-cq.of.shop', remotePort: 1892, proxyType: 'tcp' }), 'cn-cq.of.shop:1892');
  assert.equal(publicAddressOf({ connectAddress: 'cn-cq.of.shop:51607', remotePort: 1892, proxyType: 'tcp' }), 'cn-cq.of.shop:51607');
  assert.equal(publicAddressOf({ connectAddress: 'example.com', proxyType: 'https' }), 'example.com');
  assert.equal(publicAddressOf({ connectAddress: '', remotePort: 1 }), '');
});

test('cnameTargetOf finds the field the human could not locate', () => {
  assert.equal(cnameTargetOf({ nodeHostname: 'cn-cq-plc-1.of-7af93c01.shop' }), 'cn-cq-plc-1.of-7af93c01.shop');
  assert.equal(cnameTargetOf({ hostname: 'x' }), 'x');
  assert.equal(cnameTargetOf({}), '');
});

test('rankNodes filters impossible nodes and keeps the reasons', () => {
  const nodes = [
    { id: 1, name: 'good-hk', bandwidth: 50, classify: 2, group: 'normal;vip', needRealname: false, fullyLoaded: false, status: 200, protocolSupport: { tcp: true } },
    { id: 2, name: 'full', bandwidth: 999, classify: 2, group: 'normal', needRealname: false, fullyLoaded: true, status: 200, protocolSupport: { tcp: true } },
    { id: 3, name: 'no-tcp', bandwidth: 100, classify: 2, group: 'normal', needRealname: false, fullyLoaded: false, status: 200, protocolSupport: { tcp: false } },
    { id: 4, name: 'needs-realname', bandwidth: 100, classify: 2, group: 'normal', needRealname: true, fullyLoaded: false, status: 200, protocolSupport: { tcp: true } },
    { id: 5, name: 'wrong-group', bandwidth: 100, classify: 2, group: 'vip;svip', needRealname: false, fullyLoaded: false, status: 200, protocolSupport: { tcp: true } },
  ];
  const { ranked, rejected } = rankNodes(nodes, { protocol: 'tcp', userGroup: 'normal', realname: false });
  assert.deepEqual(ranked.map(n => n.name), ['good-hk']);
  const byName = Object.fromEntries(rejected.map(r => [r.name, r.reasons]));
  assert.match(byName.full.join(), /满载/);
  assert.match(byName['no-tcp'].join(), /不支持 tcp/);
  assert.match(byName['needs-realname'].join(), /实名/);
  assert.match(byName['wrong-group'].join(), /用户组/);
});

test('portAllowedByNode understands the allowPort field', () => {
  assert.equal(portAllowedByNode(null, 25565), true);
  assert.equal(portAllowedByNode('', 25565), true);
  assert.equal(portAllowedByNode('(50000,60000)', 55000), true);
  assert.equal(portAllowedByNode('(50000,60000)', 25565), false);
});

// ── Tunnel naming: OpenFrp accepts ^[a-z]+$ only (field report B2) ──
test('tunnel names: only lowercase letters survive', () => {
  assert.equal(isValidTunnelName('dshmc'), true);
  assert.equal(isValidTunnelName('dsh-mc-262'), false, 'hyphens are rejected by OpenFrp');
  assert.equal(isValidTunnelName('mc262'), false, 'digits are rejected too');
  assert.equal(isValidTunnelName('我的隧道'), false);
  assert.equal(sanitizeTunnelName('dsh-mc-262'), 'dshmc');
  assert.equal(sanitizeTunnelName('VanillaPlus-26.2'), 'vanillaplus');
  assert.equal(sanitizeTunnelName('我的隧道'), '');
  assert.equal(tunnelNameFor('mc'), 'mc');
  assert.equal(tunnelNameFor('VanillaPlus-26.2'), 'vanillaplus');
  assert.equal(tunnelNameFor('我的隧道'), 'dshsvc', 'nothing usable survives -> safe fallback');
});

// ── Remote port policy (field report B3) ──
test('remote port policy avoids protected ports and stays in the ephemeral band', () => {
  assert.equal(isLikelyProtectedRemotePort(25565), true, 'measured: "系统保护端口区间"');
  assert.equal(isLikelyProtectedRemotePort(80), true);
  assert.equal(isLikelyProtectedRemotePort(22), true);
  assert.equal(isLikelyProtectedRemotePort(55219), false);
  assert.equal(isLikelyProtectedRemotePort(65535.5), true);

  // Seeded LCG so the assertion is deterministic but the ports vary.
  let seed = 42;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const candidates = pickRemotePortCandidates(8, { random });
  assert.equal(candidates.length, 8);
  assert.equal(new Set(candidates).size, 8, 'no duplicates');
  for (const port of candidates) {
    assert.equal(port >= 10000 && port <= 65535, true, `out of band: ${port}`);
    assert.equal(isLikelyProtectedRemotePort(port), false);
  }

  // Even a degenerate random source must yield the requested number of
  // candidates (the function falls back to a deterministic sweep).
  const degenerate = pickRemotePortCandidates(8, { random: () => 0.5 });
  assert.equal(degenerate.length, 8);
  assert.equal(new Set(degenerate).size, 8);
});

test('remote port errors are classified so retries can be decided', () => {
  assert.equal(classifyRemotePortError('远程端口处于系统保护端口区间'), 'protected');
  assert.equal(classifyRemotePortError('远程端口不可用或已被占用'), 'taken');
  assert.equal(classifyRemotePortError('tcp/udp隧道,必须指定远程端口'), 'required');
  assert.equal(classifyRemotePortError('something else'), 'unknown');
});

test('normalizeProxyFields: local_port is a NUMBER, names are sanitized', () => {
  const tcp = normalizeProxyFields({ name: 'dsh-mc-262', type: 'TCP', local_port: 25565, node_id: '44', remote_port: '27388' });
  // A string local_port made OpenFrp store 0, so frpc dialled 127.0.0.1:0 (report B1).
  assert.equal(typeof tcp.local_port, 'number');
  assert.equal(tcp.local_port, 25565);
  assert.equal(tcp.name, 'dshmc', 'hyphens and digits must be stripped');
  assert.equal(tcp.__nameChangedFrom, 'dsh-mc-262', 'the rename is reported, not hidden');
  assert.equal(tcp.type, 'tcp');
  assert.equal(tcp.node_id, 44);
  assert.equal(tcp.remote_port, 27388);
  assert.equal(tcp.autoTls, 'false');

  const http = normalizeProxyFields({ name: 'web', type: 'http', local_port: 8000, node_id: 1, remote_port: 1234 });
  assert.equal(http.remote_port, '');

  assert.throws(() => normalizeProxyFields({ name: 'x', type: 'tcp', local_port: 'abc', node_id: 1 }), /local_port/);
  assert.throws(() => normalizeProxyFields({ name: 'x', type: 'tcp', local_port: 0, node_id: 1 }), /local_port/);
});

console.log('\nargo login encoding');

test('base64url encoding is padded, as the service expects', () => {
  const bytes = Uint8Array.from([1, 2, 3, 4, 5]);
  const encoded = b64urlPadded(bytes);
  assert.equal(encoded.length % 4, 0);
  assert.equal(encoded.includes('+'), false);
  assert.equal(encoded.includes('/'), false);
});

test('b64DecodeAny tolerates all four dialects', () => {
  const bytes = Buffer.from('hello openfrp world');
  const standard = bytes.toString('base64');
  const urlSafe = bytes.toString('base64url');
  assert.deepEqual(b64DecodeAny(standard), bytes);
  assert.deepEqual(b64DecodeAny(urlSafe), bytes);
  assert.deepEqual(b64DecodeAny(standard.replace(/=+$/, '')), bytes);
  assert.throws(() => b64DecodeAny(''));
});

console.log('\nfrpc naming / locating');

test('frpcNames maps platform and arch the way the download server does', () => {
  assert.deepEqual(frpcNames({ platform: 'win32', arch: 'x64' }), {
    osName: 'windows', archName: 'amd64', ext: 'zip', file: 'frpc_windows_amd64.exe', archive: 'frpc_windows_amd64.zip',
  });
  assert.equal(frpcNames({ platform: 'linux', arch: 'arm64' }).archive, 'frpc_linux_arm64.tar.gz');
  assert.equal(frpcNames({ platform: 'darwin', arch: 'arm64' }).file, 'frpc_darwin_arm64');
  assert.throws(() => frpcNames({ platform: 'aix', arch: 'x64' }));
});

test('frpcCandidates starts with the configured path', () => {
  const candidates = frpcCandidates({ platform: 'win32', arch: 'x64', configured: 'D:\\my\\frpc.exe' });
  assert.equal(candidates[0], 'D:\\my\\frpc.exe');
  assert.equal(candidates.some(c => c.includes('OpenFrp Launcher')), true);
});

console.log('\nzip + tar readers');

/** Build a minimal, uncompressed (method 0) zip in memory — enough to prove the reader. */
function buildStoredZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.from(content);
    const crc = zlib.crc32 ? zlib.crc32(data) : 0;
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // method 0 = stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    locals.push(local, data);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 10); // method 0
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    centrals.push(central);

    offset += local.length + data.length;
  }
  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, eocd]);
}

test('zip reader lists and extracts entries', () => {
  const zip = buildStoredZip([
    ['frpc_windows_amd64.exe', 'MZ fake binary'],
    ['README.txt', 'hello'],
  ]);
  const entries = listZipEntries(zip);
  assert.deepEqual(entries.map(e => e.name), ['frpc_windows_amd64.exe', 'README.txt']);
  const files = extractZip(zip);
  assert.equal(files.get('frpc_windows_amd64.exe').toString(), 'MZ fake binary');
  assert.equal(files.get('README.txt').toString(), 'hello');
});

test('tar reader pulls the first regular file out of a flat tar.gz', () => {
  const content = Buffer.from('#!/bin/sh\necho frpc\n');
  const header = Buffer.alloc(512);
  header.write('frpc_linux_amd64', 0, 'utf8');
  header.write('0000755\0', 100, 'utf8');
  header.write('0000000\0', 108, 'utf8');
  header.write('0000000\0', 116, 'utf8');
  header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 'utf8');
  header.write('00000000000\0', 136, 'utf8');
  header.write('0', 156, 'utf8'); // regular file
  header.write('ustar\0', 257, 'utf8');
  const padding = Buffer.alloc(Math.ceil(content.length / 512) * 512 - content.length);
  const tail = Buffer.alloc(1024);
  const archive = zlib.gzipSync(Buffer.concat([header, content, padding, tail]));
  const extracted = readFlatTarGz(archive);
  assert.notEqual(extracted, null);
  assert.equal(extracted.toString(), content.toString());
});

console.log('\ndiagnosis produces evidence, not guesses');

test('port mismatch between tunnel and service is reported with both numbers', () => {
  const handle = { id: 's', localPort: 25565, localPortSource: '日志中的实际绑定端口' };
  const status = {
    checks: [{ name: 'local-port', ok: true, detail: 'listening' }, { name: 'rcon', ok: true, detail: 'RCON 应答：ok' }],
    evidence: { lastLines: ['line'], ready: true, offlineMode: false, bindFailure: null },
  };
  const { findings } = diagnoseFromObservations({ status, handle, tunnel: { localPort: 25566, errors: [] } });
  const finding = findings.find(f => f.code === 'port-mismatch');
  assert.notEqual(finding, undefined);
  assert.equal(finding.severity, 'blocker');
  assert.match(finding.evidence, /local_port=25566/);
  assert.match(finding.evidence, /实际端口=25565/);
});

test('frpc local-unreachable becomes an evidence-backed finding', () => {
  const handle = { id: 's', localPort: 25565, localPortSource: 'x' };
  const status = { checks: [], evidence: { lastLines: [], ready: true, offlineMode: false, bindFailure: null } };
  const line = 'connect to local service [127.0.0.1:25565] error: dial tcp 127.0.0.1:25565: connect: connection refused';
  const { findings } = diagnoseFromObservations({ status, handle, tunnel: { localPort: 25565, errors: [{ code: 'local-unreachable', line }] } });
  const finding = findings.find(f => f.code === 'local-unreachable');
  assert.notEqual(finding, undefined);
  assert.equal(finding.evidence, line);
});

test('bind failure is a blocker and quotes the raw line', () => {
  const handle = { id: 's', localPort: 25565, localPortSource: 'x' };
  const raw = '**** FAILED TO BIND TO PORT!';
  const status = { checks: [], evidence: { lastLines: [raw], ready: false, offlineMode: false, bindFailure: raw } };
  const { findings } = diagnoseFromObservations({ status, handle });
  const finding = findings.find(f => f.code === 'port-taken');
  assert.equal(finding.severity, 'blocker');
  assert.equal(finding.evidence, raw);
});

test('offline mode is surfaced before exposing anything', () => {
  const handle = { id: 's', localPort: 25565, localPortSource: 'x' };
  const status = { checks: [], evidence: { lastLines: ['**** SERVER IS RUNNING IN OFFLINE/INSECURE MODE!'], ready: true, offlineMode: true, bindFailure: null } };
  const { findings } = diagnoseFromObservations({ status, handle });
  assert.notEqual(findings.find(f => f.code === 'offline-mode'), undefined);
});

test('a quiet log with a live port is NOT reported as dead', () => {
  // This is the measured trap: an idle server writes nothing for minutes.
  const handle = { id: 's', localPort: 25565, localPortSource: 'x' };
  const status = {
    checks: [{ name: 'local-port', ok: true, detail: 'listening' }, { name: 'rcon', ok: true, detail: 'RCON 应答：ok' }],
    evidence: { lastLines: ['an old line'], ready: true, offlineMode: false, bindFailure: null },
  };
  const { findings } = diagnoseFromObservations({ status, handle });
  assert.deepEqual(findings.map(f => f.code), ['healthy']);
});

console.log('\nservice start plan + credential refresh');

test('detectStartPlan prefers a start script over guessing java -jar', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-openfrp-start-'));
  fs.writeFileSync(path.join(dir, 'server.jar'), 'x');
  const jarOnly = detectStartPlan(dir);
  assert.equal(jarOnly.kind, 'java-jar');
  assert.match(jarOnly.caveat ?? '', /Fabric/, 'must warn that -jar breaks modpack launches');

  fs.writeFileSync(path.join(dir, '启动服务器.bat'), '@echo off');
  const withScript = detectStartPlan(dir);
  assert.equal(withScript.kind, 'script', 'a script in the directory always wins');
  assert.match(withScript.script, /启动服务器\.bat$/);
  assert.match(withScript.evidence, /-cp _launch Launch/);

  assert.equal(detectStartPlan(path.join(dir, 'nope')).ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('planToCommand builds platform-correct invocations', () => {
  assert.deepEqual(
    planToCommand({ kind: 'script', script: 'C:\\x\\启动服务器.bat' }, { platform: 'win32' }),
    { command: 'cmd', args: ['/c', 'C:\\x\\启动服务器.bat'] },
  );
  assert.deepEqual(
    planToCommand({ kind: 'script', script: 'C:\\x\\a.ps1' }, { platform: 'win32' }),
    { command: 'powershell', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\x\\a.ps1'] },
  );
  assert.deepEqual(
    planToCommand({ kind: 'java-jar', jar: 'C:\\x\\server.jar' }, { java: 'C:\\java.exe' }),
    { command: 'C:\\java.exe', args: ['-jar', 'C:\\x\\server.jar', 'nogui'] },
  );
  assert.throws(() => planToCommand({ kind: 'java-jar', jar: 'x' }, {}), /Java/);
});

test('refreshRconCredentials picks up an edited password (report M7)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-openfrp-creds-'));
  fs.writeFileSync(path.join(dir, 'server.properties'), 'enable-rcon=true\nrcon.port=25575\nrcon.password=old\n');
  const handle = { root: dir, exec: { kind: 'rcon', host: '127.0.0.1', port: 25575, password: 'stale' } };
  const first = refreshRconCredentials(handle);
  assert.equal(first.changed, true);
  assert.equal(handle.exec.password, 'old');
  assert.equal(refreshRconCredentials(handle).changed, false, 'no change on a second read');

  fs.writeFileSync(path.join(dir, 'server.properties'), 'enable-rcon=false\nrcon.password=old\n');
  const disabled = refreshRconCredentials(handle);
  assert.equal(disabled.changed, false);
  assert.match(disabled.note, /enable-rcon/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('replaceCredentials can REMOVE a key (saveCredentials merges and cannot)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-openfrp-cred-'));
  const file = path.join(dir, 'credentials.json');
  saveCredentials({ a: 1, stray: 'x' }, file);
  assert.deepEqual(loadCredentials(file), { a: 1, stray: 'x' });
  saveCredentials({ b: 2 }, file);
  assert.deepEqual(loadCredentials(file), { a: 1, stray: 'x', b: 2 }, 'merge keeps the stray key by design');

  const cleaned = loadCredentials(file);
  delete cleaned.stray;
  replaceCredentials(cleaned, file);
  assert.deepEqual(loadCredentials(file), { a: 1, b: 2 }, 'replace can drop it');

  // A failing write must not throw: persisting is a cache, not a precondition.
  const bogus = path.join(dir, 'nope', 'deep', 'credentials.json');
  assert.doesNotThrow(() => saveCredentials({ c: 3 }, bogus));
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log('\nhand-off: readiness formula, process markers, templates');

test('bootWaitSecondsFor applies the 2-3x cold-start formula', () => {
  assert.equal(bootWaitSecondsFor({ kind: 'minecraft-java' }), 180, '60s estimate x3');
  assert.equal(bootWaitSecondsFor({ coldStartSeconds: 10 }), 60, 'floored at 60');
  assert.equal(bootWaitSecondsFor({ coldStartSeconds: 50 }), 150);
  assert.equal(bootWaitSecondsFor({ kind: 'generic' }), 60);
});

test('serviceProcessMarkers uses ABSOLUTE paths, never a bare filename', () => {
  // The bare name `server.jar` also matched our own probe process, whose command
  // line contained the string — the detector then said "starting", service_start
  // waited instead of spawning, and the real cause of "it never starts" was our
  // own false positive (report v3 D2).
  const fromJar = serviceProcessMarkers({ root: 'C:/s' }, { ok: true, kind: 'java-jar', jar: 'C:/s/server.jar' });
  assert.equal(fromJar.includes(path.resolve('C:/s/server.jar')), true);
  assert.equal(fromJar.includes('server.jar'), false, 'a bare filename must not be a marker');

  const fromScript = serviceProcessMarkers({ root: 'C:/s' }, { ok: true, kind: 'script', script: 'C:/s/start-server.bat' });
  assert.equal(fromScript.includes(path.resolve('C:/s/start-server.bat')), true);

  const bare = serviceProcessMarkers({ root: 'C:/s' });
  assert.equal(bare.includes(path.resolve('C:/s')), true, 'the directory covers modded launchers and renamed jars');
  assert.equal(bare.includes(path.resolve('C:/s/server.jar')), true);
  assert.equal(bare.every(marker => path.isAbsolute(marker)), true, 'every marker must be absolute');
});

function exportFixture(overrides = {}) {
  return buildExportFiles({
    root: 'C:/s',
    port: '25566',
    rconPort: '25575',
    proxyId: 1224779,
    publicAddress: 'kr-se.ofalias.net:55220',
    frpcPath: 'C:/frpc.exe',
    startPlanKind: 'java-jar',
    existingStartScript: '',
    javaPath: 'C:/java.exe',
    memory: '2G',
    bootWaitSeconds: 180,
    ...overrides,
  });
}

test('export produces the hand-off file set', () => {
  const files = exportFixture();
  const names = files.map(f => f.path);
  for (const expected of ['start-server.ps1', 'stop-server.ps1', 'start-tunnel.ps1', 'stop-tunnel.ps1', 'start-all.ps1', 'stop-all.ps1', 'debug-tunnel.ps1', '启动.bat', '停止.bat', 'README.md']) {
    assert.equal(names.includes(expected), true, `缺少 ${expected}`);
  }
});

test('the generated start script encodes the world-lock avoidance', () => {
  const start = exportFixture().find(f => f.path === 'start-server.ps1').content;
  assert.match(start, /session.lock/, 'must name the lock');
  assert.match(start, /Test-Path session.lock/);           // it appears as a warning...
  assert.match(start, /不能\*\*用|不能用/, 'must say the file-exists test is wrong');
  assert.match(start, /绝不另起/, 'must forbid starting a second copy while loading');
  for (const state of ['冷启动', '热重启', '启动中', '僵尸']) {
    assert.equal(start.includes(state), true, `missing state ${state}`);
  }
  assert.match(start, /2-3 倍/, 'the guard formula must be stated, not just the number');
});

test('the generated start script reuses an existing start script instead of guessing', () => {
  const viaScript = exportFixture({ startPlanKind: 'script', existingStartScript: '启动服务器.bat' })
    .find(f => f.path === 'start-server.ps1').content;
  assert.match(viaScript, /启动服务器\.bat/, 'must call the user\'s own launcher');
  assert.equal(/-jar/.test(viaScript), false, 'must NOT fall back to java -jar for a script-launched pack');
});

test('batch shells stay ASCII (a BOM would be printed by cmd) while .ps1/.md do not', () => {
  for (const file of exportFixture()) {
    const isBatch = file.path.toLowerCase().endsWith('.bat');
    if (isBatch) {
      // eslint-disable-next-line no-control-regex
      assert.match(file.content, /^[\x00-\x7F]*$/, `${file.path} must be ASCII-only`);
      assert.equal(file.content.includes('-ExecutionPolicy Bypass'), true, `${file.path} must bypass the execution policy`);
    } else {
      assert.equal(file.content.length > 200, true, `${file.path} looks empty`);
    }
  }
});

test('secrets are not baked into the scripts', () => {
  for (const file of exportFixture()) {
    assert.equal(/OPENFRPeyJ/.test(file.content), false, `${file.path} must not carry an Authorization token`);
    assert.equal(/rcon\.password\s*=\s*\S/.test(file.content), false, `${file.path} must not hard-code the RCON password`);
  }
});

test('userInstruction explicitly tells the agent to say it to the user', () => {
  const text = userInstruction({ dir: 'C:/s/_dsh', startFile: '启动.bat', stopFile: '停止.bat', publicAddress: 'kr-se.ofalias.net:55220' });
  assert.match(text, /告诉用户/);
  assert.match(text, /双击/);
  assert.match(text, /启动\.bat/);
  assert.match(text, /kr-se\.ofalias\.net:55220/);
  assert.match(text, /DSH 启动的进程会随 DSH 一起结束/, 'must explain WHY the user runs it');
});

test('EXPORT_DIR_NAME is a single fixed subdirectory (idempotent re-export)', () => {
  assert.equal(EXPORT_DIR_NAME, '_dsh');
});

test('prepareLogFile degrades to temp instead of refusing to start', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-openfrp-log-'));
  const preferred = path.join(dir, 'nested', 'frpc-1.log');
  const first = prepareLogFile(preferred);
  assert.equal(first.ok, true);
  assert.equal(first.fallback, false);
  assert.equal(fs.existsSync(preferred), true);

  // An unwritable preferred path must NOT be fatal: output capture is a cache.
  const blocked = path.join(dir, 'file-not-a-dir', 'x.log');
  fs.writeFileSync(path.join(dir, 'file-not-a-dir'), 'this is a file, not a directory');
  const second = prepareLogFile(blocked);
  assert.equal(second.ok, true, 'must fall back rather than fail');
  assert.equal(second.fallback, true);
  assert.notEqual(second.path, blocked);
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const { name, error } of failures) console.error(`\n--- ${name}\n${error.stack}`);
  process.exit(1);
}
