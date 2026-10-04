/**
 * Tool-contract test.
 *
 * This exists because of a real, silent failure: the first shipped specs omitted
 * `output`, `defineTool` threw on the very first tool, and the entire tool
 * registration was lost — while the plugin's system-prompt section still
 * appeared, so from the outside it looked loaded. Nothing but a contract test
 * against the Host's own `defineTool` catches that.
 *
 * The Host's `@deepseek-ai/dsh-tools` is not resolvable from the plugin
 * directory (it lives inside the dsh installation), so we try the bare
 * specifier first and fall back to the known Host paths. If neither exists the
 * test SKIPS loudly rather than passing vacuously.
 *
 * Run: node test/tools-contract.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

let passed = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  ok  ${name}`); }
  else { failures.push({ name, detail }); console.log(`FAIL  ${name}${detail === '' ? '' : `\n      ${detail}`}`); }
}

// ── Locate the Host's defineTool ─────────────────────────────
const CANDIDATES = [
  '@deepseek-ai/dsh-tools',
  'file:///C:/Users/Admin/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js',
];

let defineTool = null;
let source = '';
for (const candidate of CANDIDATES) {
  try {
    const mod = await import(candidate);
    if (typeof mod.defineTool === 'function') {
      defineTool = mod.defineTool;
      source = candidate;
      break;
    }
  } catch {
    /* try next */
  }
}

if (defineTool === null) {
  console.log('\n跳过：找不到宿主的 @deepseek-ai/dsh-tools（这在插件目录下是正常的）。');
  console.log('请在 DSH 安装目录下运行本测试，或确认上面的候选路径存在。');
  process.exit(0);
}
console.log(`\n使用宿主的 defineTool：${source}`);

const { buildToolSpecs, renderValue } = await import('../src/tool-specs.js');

// A runtime stub: the specs only call it lazily inside execute, which we do not run.
const specs = buildToolSpecs(() => { throw new Error('runtime 未初始化（测试不应触发它）'); });

console.log(`\n[1] 每个 spec 都能被宿主的 defineTool 接受（共 ${specs.length} 个）`);
const compiled = [];
for (const spec of specs) {
  try {
    compiled.push({ spec, tool: defineTool(spec) });
    check(`${spec.name}`, true);
  } catch (error) {
    check(`${spec.name}`, false, error.message);
  }
}

console.log('\n[2] 工具面自身的约束');
const names = specs.map(s => s.name);
check('工具名唯一', new Set(names).size === names.length, JSON.stringify(names));
check('全部带 openfrp_ / service_ 前缀', names.every(n => n.startsWith('openfrp_') || n.startsWith('service_')), JSON.stringify(names));
check('每个工具都有非空 description', specs.every(s => typeof s.description === 'string' && s.description.length > 30), JSON.stringify(specs.filter(s => !s.description || s.description.length <= 30).map(s => s.name)));
check('每个工具都有 execute 函数', specs.every(s => typeof s.execute === 'function'), JSON.stringify(specs.filter(s => typeof s.execute !== 'function').map(s => s.name)));
check('每个工具都声明了 output.render', specs.every(s => typeof s.output?.render === 'function'), JSON.stringify(specs.filter(s => typeof s.output?.render !== 'function').map(s => s.name)));

console.log('\n[3] render 返回 ContentBlock[]，不是裸字符串');
for (const { spec } of compiled) {
  const blocks = spec.output.render({}, { ok: true, hello: '世界' });
  check(`${spec.name} render 返回数组`, Array.isArray(blocks), JSON.stringify(blocks));
  check(`${spec.name} render 元素是 text block`,
    Array.isArray(blocks) && blocks.every(b => b && b.type === 'text' && typeof b.text === 'string'),
    JSON.stringify(blocks));
}
check('render 能序列化复杂对象', renderValue({ a: [1, 2], b: { c: '中文' } }).includes('中文'));
check('render 对 null 不崩', renderValue(null) === 'null');

console.log('\n[4] 值 schema 是宿主 DSL 支持的最小形状');
for (const { spec } of compiled) {
  const schema = spec.output.schema;
  check(`${spec.name} schema 显式声明 additionalProperties`,
    schema?.type === 'object' && (schema.additionalProperties === true || schema.additionalProperties === false),
    JSON.stringify(schema));
  check(`${spec.name} schema 未使用 required（DSL 不支持）`, schema?.required === undefined, JSON.stringify(schema));
}

console.log('\n[5] registerOpenFrpTools 端到端（这一层曾经静默失败）');
const { registerOpenFrpTools } = await import('../src/tools.js');
const registered = [];
const stubCtx = { tools: { register: tool => { registered.push(tool); return () => {}; } } };
let dispose = null;
try {
  dispose = registerOpenFrpTools(stubCtx, () => ({}), defineTool);
  check('注册过程没有抛错', true);
} catch (error) {
  check('注册过程没有抛错', false, error.message);
}
check(`注册出了 ${specs.length} 个工具`, registered.length === specs.length, `实际 ${registered.length}`);
check('注册的工具名与 spec 一致',
  JSON.stringify(registered.map(t => t.name)) === JSON.stringify(names),
  JSON.stringify(registered.map(t => t.name)));
check('返回了 disposer', typeof dispose === 'function');
dispose?.();
check('disposer 可重复调用', (() => { try { dispose?.(); return true; } catch { return false; } })());

try {
  registerOpenFrpTools(stubCtx, () => ({}), undefined);
  check('缺少 defineTool 时明确报错', false, '居然没报错');
} catch (error) {
  check('缺少 defineTool 时明确报错', /defineTool/.test(error.message), error.message);
}

// A deliberately broken spec must fail the whole registration, not half-register.
try {
  registerOpenFrpTools(stubCtx, () => ({}), spec => {
    if (spec.name === 'service_logs') throw new Error('模拟宿主拒绝');
    return defineTool(spec);
  });
  check('任一 spec 被拒时整体失败（不半注册）', false, '居然没抛错');
} catch (error) {
  check('任一 spec 被拒时整体失败（不半注册）', /工具 "service_logs" 的定义被宿主拒绝/.test(error.message), error.message);
}
check('失败时没有注册任何工具（编译先于注册）', registered.length === specs.length, `实际 ${registered.length}`);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const { name, detail } of failures) console.error(`\n--- ${name}\n${detail}`);
  process.exit(1);
}
