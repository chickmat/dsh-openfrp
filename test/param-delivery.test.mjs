/**
 * Parameter-delivery contract test.
 *
 * The gap this closes (field report v4 §2.6): every existing test checked the
 * *shape* of a tool spec — that `defineTool` accepts it, that `render` returns
 * content blocks. None of them checked that a parameter's **value** reaches the
 * action. So `follow_ms` could be declared, documented and accepted, and then
 * silently dropped, and 85 passing tests said nothing.
 *
 * The rule now is one line long: **the tool layer camelizes every argument, and
 * the action layer only ever sees camelCase.** These tests assert the actual
 * delivery rather than the intention:
 *
 *  1. For every non-routing tool, every declared parameter's value must arrive
 *     in the action's payload under its camelCase name.
 *  2. For the routing tools (`action: '...'`), the enum value must dispatch, and
 *     the parameters that are only meaningful for a branch must arrive in that
 *     branch.
 *
 * Run: node test/param-delivery.test.mjs
 */

import assert from 'node:assert/strict';
import { buildToolSpecs, camelizeArgs } from '../src/tool-specs.js';

let passed = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  ok  ${name}`); }
  else { failures.push({ name, detail }); console.log(`FAIL  ${name}${detail === '' ? '' : `\n      ${detail}`}`); }
}

/** A distinctive value for a parameter, chosen so it survives its own type checks. */
function sentinelFor(key, def, seen = new Map()) {
  if (Array.isArray(def.enum) && def.enum.length > 0) return def.enum[0];
  if (def.type === 'boolean') return true;
  if (def.type === 'number') {
    // Distinct per key so a mix-up between two numeric parameters is visible.
    if (!seen.has(key)) seen.set(key, 100000 + seen.size);
    return seen.get(key);
  }
  if (def.type === 'array') return [`SENTINEL_${key}`];
  return `SENTINEL_${key}`;
}

function sameValue(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  return Object.is(a, b);
}

/** Record every call the action layer receives. */
function makeActionSpy() {
  const calls = [];
  const layer = new Proxy({}, {
    get: (_target, name) => (...args) => {
      calls.push({ name: String(name), args });
      return Promise.resolve({ ok: true, __spy: true });
    },
  });
  return { layer, calls };
}

const ROUTING_TOOLS = new Set(['openfrp_account', 'openfrp_tunnel', 'openfrp_expose']);
const fakeRuntime = () => ({ handles: new Map(), instances: new Map(), config: {} });

console.log('\n[0] camelizeArgs 的基本行为');
check('snake_case 转驼峰', camelizeArgs({ follow_ms: 1, grace_seconds: 2, boot_wait_seconds: 3 }).followMs === 1
  && camelizeArgs({ grace_seconds: 2 }).graceSeconds === 2
  && camelizeArgs({ boot_wait_seconds: 3 }).bootWaitSeconds === 3);
check('已经是驼峰的键不动', camelizeArgs({ followMs: 1 }).followMs === 1);
check('单段键不动', camelizeArgs({ id: 'x', action: 'up' }).id === 'x');
check('非对象原样返回', camelizeArgs(null) === null && camelizeArgs(undefined) === undefined);

console.log('\n[1] 每个非路由工具：参数的值真的到达动作层');

const specs = buildToolSpecs(fakeRuntime, null);
const spy = makeActionSpy();
const spySpecs = buildToolSpecs(fakeRuntime, spy.layer);

for (const spec of spySpecs) {
  if (ROUTING_TOOLS.has(spec.name)) continue;
  const declared = Object.entries(spec.parameters ?? {});
  if (declared.length === 0) continue;

  const seen = new Map();
  const args = {};
  for (const [key, def] of declared) args[key] = sentinelFor(key, def, seen);

  spy.calls.length = 0;
  await spec.execute(args);

  const call = spy.calls[spy.calls.length - 1];
  const payload = call?.args?.[1];
  if (payload === undefined || typeof payload !== 'object') {
    check(`${spec.name} 调用了动作层并传了参数对象`, false, JSON.stringify(spy.calls.map(c => c.name)));
    continue;
  }
  for (const [key, def] of declared) {
    const camel = camelizeArgs({ [key]: null });
    const expectedKey = Object.keys(camel)[0];
    const got = payload[expectedKey];
    check(`${spec.name}.${key} → ${expectedKey} 的值到达了动作层`,
      sameValue(got, args[key]),
      `期望 ${JSON.stringify(args[key])}，实际 ${JSON.stringify(got)}；payload 键 = ${Object.keys(payload).join(', ')}`);
  }
}

console.log('\n[2] 路由工具：枚举值必须真的派发到对应分支');

const ROUTING = {
  openfrp_account: {
    status: [], login: ['auto_open'], poll: ['request_uuid'], wait: ['request_uuid', 'timeout_ms'],
  },
  openfrp_expose: {
    up: ['id', 'proxy_id', 'auto_create', 'node_id', 'mode', 'wait_ms'], down: ['id', 'proxy_id'],
  },
  openfrp_tunnel: {
    list: [], nodes: ['protocol', 'classify'], create: ['name', 'type', 'local_port'],
    delete: ['proxy_id'], enable: ['proxy_id'], disable: ['proxy_id'],
  },
};

for (const spec of spySpecs) {
  const table = ROUTING[spec.name];
  if (table === undefined) continue;
  for (const [action, relevant] of Object.entries(table)) {
    const args = { action };
    const seen = new Map();
    for (const [key, def] of Object.entries(spec.parameters ?? {})) {
      if (key === 'action') continue;
      args[key] = sentinelFor(key, def, seen);
    }
    // For 'up'/'down' the expose tool takes different routes; keep the other
    // branch's params out of the way is unnecessary — the tool reads what it needs.
    spy.calls.length = 0;
    await spec.execute(args);

    check(`${spec.name} action=${action} 至少调用了一次动作层`, spy.calls.length > 0, JSON.stringify(spy.calls.map(c => c.name)));
    const called = spy.calls.map(c => c.name);
    if (action === 'delete') {
      check(`${spec.name}.delete 派发到 tunnelDelete`, called.includes('tunnelDelete'), called.join(', '));
    }
    if (action === 'nodes') {
      const call = spy.calls.find(c => c.name === 'nodesList');
      check(`${spec.name}.nodes 的 protocol 到达动作层`, call?.args?.[1]?.protocol === args.protocol,
        `收到 ${JSON.stringify(call?.args?.[1])}`);
      check(`${spec.name}.nodes 的 classify 到达动作层`, call?.args?.[1]?.classify === args.classify,
        `收到 ${JSON.stringify(call?.args?.[1])}`);
    }
    if (spec.name === 'openfrp_expose' && action === 'up') {
      const call = spy.calls.find(c => c.name === 'exposeUp');
      const payload = call?.args?.[1] ?? {};
      check('expose.up 的 node_id 到达动作层（v4 重命名的参数之一）', payload.nodeId === args.node_id, JSON.stringify(payload));
      check('expose.up 的 auto_create 到达动作层', payload.autoCreate === true, JSON.stringify(payload));
      check('expose.up 的 wait_ms 到达动作层', payload.waitMs === args.wait_ms, JSON.stringify(payload));
      check('expose.up 的 proxy_id 到达动作层', payload.proxyId === args.proxy_id, JSON.stringify(payload));
    }
    if (spec.name === 'openfrp_tunnel' && action === 'create') {
      const call = spy.calls.find(c => c.name === 'tunnelCreate');
      check('tunnel.create 把字段透传给动作层', call !== undefined && call.args[1] !== undefined, JSON.stringify(called));
      const payload = call?.args?.[1] ?? {};
      check('tunnel.create 的 local_port 以驼峰形式送达（动作层两种都能认）',
        payload.localPort === args.local_port || payload.local_port === args.local_port, JSON.stringify(payload));
    }
    if (spec.name === 'openfrp_account' && action === 'wait') {
      const call = spy.calls.find(c => c.name === 'accountWait');
      check('account.wait 的 request_uuid / timeout_ms 到达动作层',
        call?.args?.[1]?.requestUuid === args.request_uuid && call?.args?.[1]?.timeoutMs === args.timeout_ms,
        JSON.stringify(call?.args?.[1]));
    }
  }
}

console.log('\n[3] 两个已报告缺陷的定点回归（v4 §2.2 / §2.4）');

{
  const { layer, calls } = makeActionSpy();
  const built = buildToolSpecs(fakeRuntime, layer);
  const logsSpec = built.find(s => s.name === 'service_logs');
  calls.length = 0;
  await logsSpec.execute({ id: 'x', lines: 60, follow_ms: 12345 });
  check('service_logs 的 follow_ms 不再被静默丢弃（v4 §2.2）',
    calls[0]?.args?.[1]?.followMs === 12345,
    `动作层收到 ${JSON.stringify(calls[0]?.args?.[1])} —— 曾经这里是 undefined，于是跟读从未生效`);
}

{
  const { layer, calls } = makeActionSpy();
  const built = buildToolSpecs(fakeRuntime, layer);
  const stopSpec = built.find(s => s.name === 'service_stop');
  calls.length = 0;
  await stopSpec.execute({ id: 'x', grace_seconds: 7 });
  check('service_stop 的 grace_seconds 不再被静默丢弃（v4 §2.4）',
    calls[0]?.args?.[1]?.graceSeconds === 7,
    `动作层收到 ${JSON.stringify(calls[0]?.args?.[1])}`);
}

console.log('\n[4] 工具层确实套了转名（防止有人把 wrapper 拿掉）');
{
  const { layer, calls } = makeActionSpy();
  const built = buildToolSpecs(fakeRuntime, layer);
  const attach = built.find(s => s.name === 'service_attach');
  calls.length = 0;
  await attach.execute({ id: 'svc', target: 'C:/x', port: 25565, kind: 'minecraft-java' });
  const payload = calls[0]?.args?.[1] ?? {};
  check('全下划线参数也能原样送达', payload.id === 'svc' && payload.target === 'C:/x' && payload.port === 25565 && payload.kind === 'minecraft-java',
    JSON.stringify(payload));
}

console.log('\n[5] 声明的参数名与动作层解构名一一对得上（静态）');
{
  // Extract every destructured parameter name from the action layer's source.
  const src = await import('node:fs').then(fs => fs.readFileSync(new URL('../src/actions.js', import.meta.url), 'utf8'));
  const destructured = new Set();
  for (const match of src.matchAll(/export (?:async )?function \w+\(runtime, \{([^}]*)\}/g)) {
    for (const part of match[1].split(',')) {
      const name = part.split('=')[0].trim();
      if (name !== '') destructured.add(name);
    }
  }
  check('从 actions.js 解析出动作层参数名', destructured.size > 10, `${destructured.size} 个`);

  const offenders = [];
  for (const spec of specs) {
    if (ROUTING_TOOLS.has(spec.name)) continue;
    for (const key of Object.keys(spec.parameters ?? {})) {
      const camel = Object.keys(camelizeArgs({ [key]: null }))[0];
      if (!destructured.has(camel)) offenders.push(`${spec.name}.${key} → ${camel}`);
    }
  }
  check('每个非路由工具的每个参数都能被动作层解构到', offenders.length === 0, offenders.join('; '));
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const { name, detail } of failures) console.error(`\n--- ${name}\n${detail}`);
  process.exit(1);
}
