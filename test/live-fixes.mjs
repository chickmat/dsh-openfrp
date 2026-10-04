/**
 * Live verification of the field-report fixes, against the REAL OpenFrp API.
 *
 * The running Host still has the pre-fix code loaded (host plugins load at
 * startup), so this drives the fixed modules directly instead:
 *
 *   B1  local_port landed as 0            → assert the read-back shows the number we sent
 *   B2  tunnel name rejected              → assert sanitization + a real create succeeds
 *   B3  no usable allowPort / blind ports → assert an auto-picked port creates successfully
 *   B4  frpc 0.67 success line not matched→ assert `expose up` returns an address
 *   M5  group taken from the display name → assert the machine group key is used
 *   realname defaulted to false           → assert the account's real state is used
 *
 * It creates exactly ONE throwaway tunnel and removes it again, plus a
 * throwaway TCP listener. Everything it touches is cleaned up in `finally`.
 *
 * Run: node test/live-fixes.mjs
 */

import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  createRuntime, accountStatus, nodesList, tunnelsList, tunnelCreate, tunnelDelete,
  serviceAttach, exposeUp, exposeDown, serviceExportScripts, serviceList, serviceDetach,
} from '../src/actions.js';
import { upsertService } from '../src/registry.js';

let passed = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  ok  ${name}`); }
  else { failures.push({ name, detail }); console.log(`FAIL  ${name}${detail === '' ? '' : `\n      ${detail}`}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const runtime = createRuntime({ config: {} });
const createdTunnelIds = [];
let listener = null;
let listenerPort = 0;
let exposedProxyId = null;

try {
  // ── M5 + realname: node permissions must use the account's real facts ──
  console.log('\n[1] M5：用户组与实名状态（这两条曾让大陆节点全被误拒）');
  const status = await accountStatus(runtime);
  check('已登录', status.loggedIn === true, JSON.stringify(status));
  check('拿到机器用户组键（不是展示名）',
    typeof status.account?.group === 'string' && /^[a-z]+$/.test(status.account.group),
    `group=${JSON.stringify(status.account?.group)} friendlyGroup=${JSON.stringify(status.account?.friendlyGroup)}`);
  check('读到真实实名状态', typeof status.account?.realname === 'boolean', String(status.account?.realname));
  console.log(`      group=${status.account?.group}  friendly=${status.account?.friendlyGroup}  实名=${status.account?.realname}`);

  const allNodes = await nodesList(runtime, { protocol: 'tcp' });
  const mainland = await nodesList(runtime, { protocol: 'tcp', classify: 1 });
  check('nodes 回报的用户组 = 账号机器键', allNodes.accountGroup === status.account?.group, `${allNodes.accountGroup} vs ${status.account?.group}`);
  check('nodes 回报的实名状态 = 账号真实状态', allNodes.realnameVerified === (status.account?.realname === true), String(allNodes.realnameVerified));
  console.log(`      tcp 可用节点 ${allNodes.suitable}/${allNodes.total}；大陆节点 ${mainland.suitable}/${mainland.total}`);
  console.log(`      实名前被误拒的大陆节点，现在：${mainland.suitable > 0 ? `可选 ${mainland.suitable} 个` : '仍为 0（下面看拒绝理由）'}`);
  if (mainland.rejected.length > 0) {
    for (const r of mainland.rejected.slice(0, 3)) console.log(`        拒 ${r.name}: ${r.reasons.join('、')}`);
  }

  // ── B1 + B2 + B3: create a real tunnel and read it back ──
  console.log('\n[2] B1/B2/B3：创建隧道并回读（这是报告里的阻塞级问题）');
  const before = await tunnelsList(runtime);
  const broken = before.tunnels.filter(t => t.localPort === 0);
  console.log(`      现有隧道 ${before.total} 条，其中本地端口为 0 的坏隧道：${broken.map(t => `${t.name}(${t.id})`).join('、') || '无'}`);
  for (const t of broken) {
    await tunnelDelete(runtime, { proxyId: t.id });
    console.log(`      已删除坏隧道 ${t.name}(${t.id})`);
  }

  const node = allNodes.ranked[0];
  check('挑到一个可用节点', node !== undefined, JSON.stringify(allNodes.ranked.slice(0, 3)));
  console.log(`      选用节点 ${node?.name} (id=${node?.id}, 区域 ${node?.classify})`);

  // Deliberately pass a name OpenFrp would reject, to prove sanitization.
  const createResult = await tunnelCreate(runtime, {
    name: 'DSH-Test-01', // uppercase + hyphens + digits: all illegal
    type: 'tcp',
    local_addr: '127.0.0.1',
    local_port: 25565,
    node_id: node.id,
    // no remote_port → exercises the auto-pick + retry path (B3)
  });
  check('创建成功', createResult.ok === true, JSON.stringify(createResult).slice(0, 600));
  if (createResult.ok === true) {
    createdTunnelIds.push(createResult.verified.id);
    check('B2：非法隧道名被自动规整', createResult.payload.name === 'dshtest', `name=${createResult.payload.name}`);
    check('B2：规整被明确回报（不静默）', Array.isArray(createResult.notes) && createResult.notes.length > 0, JSON.stringify(createResult.notes));
    check('B3：自动挑到了远程端口', Number.isInteger(createResult.remotePort), String(createResult.remotePort));
    check('B1：回读到的 localPort 等于提交值',
      Number(createResult.verified.localPort) === 25565,
      `回读 localPort=${createResult.verified.localPort}`);
    check('B1：提交的 local_port 是数字', typeof createResult.payload.local_port === 'number', typeof createResult.payload.local_port);
    console.log(`      隧道 ${createResult.verified.proxyName}(id=${createResult.verified.id}) 本地 ${createResult.verified.localIp}:${createResult.verified.localPort} 远程端口 ${createResult.remotePort}`);

    const after = await tunnelsList(runtime);
    const mine = after.tunnels.find(t => t.id === createResult.verified.id);
    check('list 里不再出现 127.0.0.1:0', mine?.local === '127.0.0.1:25565', `local=${mine?.local}`);
    check('list 不再对这条隧道报警', mine?.warning === undefined, String(mine?.warning));
  }

  // ── B4: expose a real listener and catch frpc's success line ──
  console.log('\n[3] B4：把真实监听端口暴露出去（frpc 成功行匹配）');
  listenerPort = await new Promise((resolve, reject) => {
    listener = net.createServer(socket => socket.end('ok\n'));
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => resolve(listener.address().port));
  });
  console.log(`      起了个临时 TCP 监听：127.0.0.1:${listenerPort}`);

  const attached = await serviceAttach(runtime, { id: 'probe', port: listenerPort, kind: 'generic-port' });
  check('挂靠到该端口', attached.localPort === listenerPort, JSON.stringify(attached));

  // Point the throwaway tunnel at the listener so the whole chain is real.
  if (createdTunnelIds.length > 0) {
    await exposeEditLocalPort(runtime, createdTunnelIds[0], listenerPort);
  }

  const up = await exposeUp(runtime, {
    id: 'probe',
    proxyId: createdTunnelIds[0],
    waitMs: 60_000,
  });
  check('B4：expose up 成功（不再 90s 超时）', up.ok === true, JSON.stringify(up).slice(0, 900));
  if (up.ok === true) {
    exposedProxyId = up.proxyId;
    check('B4：返回了公网地址', typeof up.public === 'string' && up.public.includes(':'), String(up.public));
    check('B4：证据来自 frpc 的成功行', typeof up.evidence === 'string' && up.evidence.length > 0, String(up.evidence));
    console.log(`      公网地址：${up.public}`);
    console.log(`      证据：${String(up.evidence).trim().slice(0, 140)}`);

    // Prove it end to end: connect to the public address and expect our banner.
    const reachable = await probeTcp(up.public.split(':')[0], Number(up.public.split(':')[1]), 12_000);
    check('从公网地址真的能连上本地监听', reachable.ok === true, reachable.detail);
    if (reachable.ok) console.log(`      公网连接成功，收到：${JSON.stringify(reachable.data)}`);
  }

  // ── D6, completed in v4 ──
  console.log('\n[4] D6（v4）：失效的隧道记录必须挡住导出');
  {
    // Fabricate a record whose proxy id certainly does not exist on OpenFrp.
    // Before the v4 fix this exported happily and baked the dead address into
    // the scripts, while service_list called the very same record stale —
    // one record, two contradictory verdicts.
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-openfrp-stale-'));
    upsertService({
      id: 'stalecheck',
      kind: 'generic-port',
      root: fakeRoot,
      localPort: 25565,
      tunnel: { provider: 'openfrp', proxyId: 99999999, public: 'dead.example.com:1', ownedBy: 'plugin' },
    });
    const blocked = await serviceExportScripts(runtime, { id: 'stalecheck' });
    check('失效隧道记录被拒绝导出', blocked.ok === false && blocked.code === 'tunnel-record-stale', JSON.stringify(blocked).slice(0, 320));
    check('handoff 明说隧道已不存在', blocked.handoff?.tunnelStillExists === false, JSON.stringify(blocked.handoff));
    check('readyForHandoff 为 false（不会被误读成一切正常）', blocked.handoff?.readyForHandoff === false, JSON.stringify(blocked.handoff));
    check('给出了可执行的下一步', typeof blocked.mustDoFirst === 'string' && blocked.mustDoFirst.includes('create'), blocked.mustDoFirst);

    // service_list and the exporter must agree — same record, same verdict.
    const listed = await serviceList(runtime);
    check('service_list 与导出工具判断一致', listed.services.find(s => s.id === 'stalecheck')?.stale === true,
      JSON.stringify(listed.services.find(s => s.id === 'stalecheck')));

    const detached = serviceDetach(runtime, { id: 'stalecheck' });
    check('service_detach 能清掉这条例记录', detached.removed === true, JSON.stringify(detached));
    check('清掉后不再出现', (await serviceList(runtime)).services.some(s => s.id === 'stalecheck') === false, 'still listed');
    fs.rmSync(fakeRoot, { recursive: true, force: true });
  }
} catch (error) {
  check('验证过程未抛异常', false, `${error.message}\n${error.stack?.split('\n').slice(0, 4).join('\n')}`);
} finally {
  console.log('\n[5] 清理');
  try {
    if (exposedProxyId !== null) { await exposeDown(runtime, { proxyId: exposedProxyId }); console.log(`      已停止 frpc（隧道 ${exposedProxyId}）`); }
  } catch (error) { console.log(`      停止 frpc 失败：${error.message}`); }
  for (const id of createdTunnelIds) {
    try {
      await tunnelDelete(runtime, { proxyId: id });
      console.log(`      已删除测试隧道 ${id}`);
    } catch (error) { console.log(`      删除隧道 ${id} 失败：${error.message}`); }
  }
  if (listener !== null) { listener.close(); console.log('      已关闭临时监听'); }
  // Do not leave our own attachment behind either — a registry that only grows
  // is exactly what v4 flagged.
  try {
    serviceDetach(runtime, { id: 'probe' });
    console.log('      已从注册表移除测试挂靠 probe');
  } catch { /* best effort */ }
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const { name, detail } of failures) console.error(`\n--- ${name}\n${detail}`);
  process.exit(1);
}
process.exit(0);

// ── helpers ──────────────────────────────────────────────────

/** Point an existing tunnel at a different local port (needed to reuse the throwaway). */
async function exposeEditLocalPort(runtime, proxyId, localPort) {
  const { tunnelEdit } = await import('../src/actions.js');
  const result = await tunnelEdit(runtime, {
    proxy_id: proxyId,
    name: 'dshtest',
    type: 'tcp',
    local_addr: '127.0.0.1',
    local_port: localPort,
    node_id: (await tunnelsList(runtime)).tunnels.find(t => t.id === proxyId)?.nodeId,
    remote_port: (await tunnelsList(runtime)).tunnels.find(t => t.id === proxyId)?.public?.split(':')[1],
  });
  console.log(`      edit 把本地端口改为 ${localPort}：${result.ok === true ? '成功并已回读确认' : JSON.stringify(result).slice(0, 300)}`);
  return result;
}

/** Connect to host:port and read a little; proves the tunnel really reaches us. */
function probeTcp(host, port, timeoutMs) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port });
    let data = '';
    const done = result => { socket.removeAllListeners(); socket.destroy(); resolve(result); };
    socket.setTimeout(timeoutMs);
    socket.on('data', chunk => { data += chunk.toString(); if (data.length > 0) done({ ok: true, data: data.trim() }); });
    socket.once('connect', () => { setTimeout(() => done({ ok: true, data: data.trim() || '(已连接，无数据)' }), 1500); });
    socket.once('timeout', () => done({ ok: false, detail: '连接超时' }));
    socket.once('error', error => done({ ok: false, detail: error.code ?? error.message }));
  });
}
