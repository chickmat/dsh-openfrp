/**
 * Plugin-load test — the closest thing to "start the Host" that does not
 * require restarting the Host.
 *
 * Why it must be run with `--preserve-symlinks`:
 *
 *   DSH loads plugins through the profile's `node_modules` junction
 *   (`~/.dsh/profiles/web/node_modules/dsh-openfrp` → the plugin directory).
 *   Plain Node resolves that junction to its real path, and then the plugin's
 *   `@deepseek-ai/*` imports fail (measured: "Cannot find package
 *   '@deepseek-ai/schemastery'"). With `--preserve-symlinks` the resolution
 *   walks the profile's node_modules and everything loads — which is exactly
 *   how the Host does it.
 *
 * So this test reproduces the Host's resolution AND drives the plugin's real
 * `apply()` with a stub cordis context, then asserts that the tool surface
 * actually got registered.
 *
 * This is the test that would have caught the original bug: the plugin loaded,
 * announced itself in the system prompt, and registered zero tools because
 * `defineTool` threw on the first spec.
 *
 * Run: node --preserve-symlinks test/plugin-load.test.mjs
 *      (npm run test:load)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let passed = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  ok  ${name}`); }
  else { failures.push({ name, detail }); console.log(`FAIL  ${name}${detail === '' ? '' : `\n      ${detail}`}`); }
}

// ── Locate the entry point the Host would load ───────────────
const junction = path.join(os.homedir(), '.dsh', 'profiles', 'web', 'node_modules', 'dsh-openfrp');
const viaJunction = path.join(junction, 'src', 'index.js');
const local = path.resolve(import.meta.dirname, '..', 'src', 'index.js');
const entry = fs.existsSync(viaJunction) ? viaJunction : local;
const junctionExists = fs.existsSync(viaJunction);

console.log('\n加载入口:');
console.log(`  ${entry}`);
console.log(`  (profile junction ${junctionExists ? '存在' : '不存在'})`);

if (!junctionExists) {
  // Without the junction, `@deepseek-ai/*` cannot resolve from the plugin
  // directory at all, so this test could not say anything about the Host —
  // and a "missing dependency" failure would be misleading.
  console.log('\n跳过：插件尚未安装到 profile（junction 不存在），无法模拟宿主解析。');
  console.log('  请在 DSH 之外的普通终端里执行：');
  console.log(`    dsh plugin --profile web add link:${path.resolve(import.meta.dirname, '..')}`);
  console.log('  然后重跑本测试。');
  process.exit(0);
}
if (!process.execArgv.includes('--preserve-symlinks')) {
  console.log('\n⚠️  未启用 --preserve-symlinks：@deepseek-ai/* 解析会失败。请用 `npm run test:load`。');
}

let plugin;
try {
  plugin = await import(pathToFileURL(entry).href);
} catch (error) {
  console.log(`\nFAIL  插件入口加载失败：${error.code ?? ''} ${String(error.message).split('\n')[0]}`);
  console.log('      （这正是 Host 启动时会看到的错误）');
  process.exit(1);
}

console.log('\n[1] 入口导出');
check('导出 name', typeof plugin.name === 'string' && plugin.name !== '', String(plugin.name));
check('导出 apply 函数', typeof plugin.apply === 'function');
// schemastery returns a callable schema (a function with metadata), not a plain object.
check('导出 Config（schemastery schema）',
  plugin.Config !== undefined && (typeof plugin.Config === 'object' || typeof plugin.Config === 'function'),
  typeof plugin.Config);
check('导出 GUIDANCE 文案', typeof plugin.GUIDANCE === 'string' && plugin.GUIDANCE.length > 100);
check('inject 不再把 tools 列为启动依赖', Array.isArray(plugin.inject) && !plugin.inject.includes('tools'), JSON.stringify(plugin.inject));

console.log('\n[2] 用桩上下文跑真实的 apply()（模拟宿主）');
const registeredTools = [];
const promptSections = [];
const loggedErrors = [];

function makeStubCtx() {
  const ctx = {
    logger: {
      info: () => {},
      warn: () => {},
      error: message => loggedErrors.push(String(message)),
    },
    tools: {
      register: tool => {
        registeredTools.push(tool);
        return () => {};
      },
    },
    systemPrompt: {
      section: spec => {
        promptSections.push(spec);
        return () => {};
      },
    },
    effect: fn => {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    // cordis: inject(deps, cb) runs cb once the deps exist; our stub runs it now.
    inject: (_deps, cb) => {
      cb(ctx);
      return () => {};
    },
  };
  return ctx;
}

try {
  plugin.apply(makeStubCtx(), {});
  check('apply() 没有抛错', true);
} catch (error) {
  check('apply() 没有抛错', false, `${error.message}\n${error.stack?.split('\n').slice(0, 4).join('\n')}`);
}

const EXPECTED_TOOLS = [
  'openfrp_account', 'openfrp_tunnel', 'openfrp_expose', 'openfrp_diagnose', 'openfrp_environment',
  'service_attach', 'service_list', 'service_status', 'service_logs', 'service_exec',
  'service_start', 'service_stop', 'service_detach', 'service_export_scripts',
];
const registeredNames = registeredTools.map(t => t.name);
check(`注册了 ${EXPECTED_TOOLS.length} 个工具`, registeredTools.length === EXPECTED_TOOLS.length,
  `实际 ${registeredTools.length}: ${registeredNames.join(', ')}${loggedErrors.length > 0 ? `；宿主日志：${loggedErrors.join(' | ')}` : ''}`);
check('每个预期工具都在注册表里',
  EXPECTED_TOOLS.every(name => registeredNames.includes(name)),
  `缺少 ${EXPECTED_TOOLS.filter(name => !registeredNames.includes(name)).join(', ')}`);
check('注册了系统提示段落', promptSections.length === 1 && promptSections[0].name === 'plugin:dsh-openfrp',
  JSON.stringify(promptSections.map(s => s.name)));
check('没有记录到注册错误', loggedErrors.length === 0, loggedErrors.join(' | '));

// ── The methodology must ship as a SKILL, not be hard-coded into scripts ──
const skillFile = path.resolve(import.meta.dirname, '..', 'skills', 'service-handoff', 'SKILL.md');
check('随包分发了 handoff 技能', fs.existsSync(skillFile), skillFile);
if (fs.existsSync(skillFile)) {
  const skill = fs.readFileSync(skillFile, 'utf8');
  check('技能带 frontmatter（name/description/whenToUse）',
    skill.startsWith('---') && skill.includes('name:') && skill.includes('description:') && skill.includes('whenToUse:'),
    skill.slice(0, 140));
  check('技能讲的是"换版本/换端怎么重新实例化"，不是硬编码答案',
    skill.includes('换版本') && skill.includes('基岩版') && skill.includes('改哪三处'),
    '缺少换版本/换端的适配章节');
  check('技能含四态与世界锁规则',
    skill.includes('四态') && skill.includes('session.lock') && skill.includes('绝不另起'));
}

console.log('\n[3] 关闭开关时不应注册任何东西');
const offTools = [];
const offCtx = makeStubCtx();
offCtx.tools.register = tool => { offTools.push(tool); return () => {}; };
try {
  plugin.apply(offCtx, { enabled: false });
  check('enabled:false 时不注册工具', offTools.length === 0, `实际 ${offTools.length}`);
} catch (error) {
  check('enabled:false 时不抛错', false, error.message);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const { name, detail } of failures) console.error(`\n--- ${name}\n${detail}`);
  process.exit(1);
}
