/**
 * Export end-to-end test.
 *
 * Builds a fake service directory, attaches to it, exports the hand-off
 * scripts, and asserts the properties that matter:
 *
 *  - the file set is complete and lands in one fixed `_dsh/` subdirectory
 *  - `.ps1` / `.md` carry a UTF-8 BOM, `.bat` does not (cmd would print it)
 *  - no secrets leak into the scripts
 *  - the world-lock / four-state rules are actually present in the start script
 *
 * A separate PowerShell pass then syntax-checks the generated scripts for real;
 * see `npm run test:export`.
 *
 * Run: node test/export.test.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createRuntime, serviceAttach, serviceExportScripts, serviceDetach, serviceList } from '../src/actions.js';
import { detectServiceState, detectStartPlan, findFreePort, isPortListening } from '../src/service.js';
import { buildExportFiles } from '../src/script-templates.js';
import net from 'node:net';

/** Same fixture shape the template tests use, for the java-jar branch check. */
function exportFixture(overrides = {}) {
  return buildExportFiles({
    root: 'C:/s',
    port: '25566',
    rconPort: '25575',
    proxyId: 1224779,
    publicAddress: '',
    frpcPath: 'C:/frpc.exe',
    startPlanKind: 'java-jar',
    existingStartScript: '',
    javaPath: 'C:/java.exe',
    memory: '2G',
    bootWaitSeconds: 180,
    ...overrides,
  });
}

let passed = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  ok  ${name}`); }
  else { failures.push({ name, detail }); console.log(`FAIL  ${name}${detail === '' ? '' : `\n      ${detail}`}`); }
}

const TMP = path.resolve(import.meta.dirname, '.tmp', 'export-check');
fs.rmSync(TMP, { recursive: true, force: true });
const svcDir = path.join(TMP, 'fakesvc');
fs.mkdirSync(path.join(svcDir, 'logs'), { recursive: true });

// Ask the OS for a port that is actually free — hard-coding 25566 made the
// fixture collide with a live server on this machine, which is exactly the
// "port occupied by something that is not ours" case the detector reports.
const PORT = await findFreePort();
fs.writeFileSync(path.join(svcDir, 'server.properties'), [
  `server-port=${PORT}`,
  'enable-rcon=true',
  'rcon.port=25575',
  'rcon.password=super-secret-pw',
  'online-mode=false',
  'motd=export test',
  '',
].join('\n'));
// A start script must win over `java -jar` — that is the Fabric/Forge rule.
fs.writeFileSync(path.join(svcDir, '启动服务器.bat'), '@echo off\r\n');
fs.writeFileSync(path.join(svcDir, 'server.jar'), 'not a real jar');
fs.writeFileSync(path.join(svcDir, 'logs', 'latest.log'), [
  '[12:00:00] [Server thread/INFO]: Starting minecraft server version 26.2',
  `[12:00:01] [Server thread/INFO]: Starting Minecraft server on *:${PORT}`,
  '[12:00:02] [Server thread/INFO]: Done (0.913s)! For help, type "help"',
  '',
].join('\n'));

const runtime = createRuntime({ config: {} });

try {
  console.log('\n[1] 挂靠');
  const attached = await serviceAttach(runtime, { id: 'fakesvc', target: svcDir });
  check('识别为 minecraft-java', attached.kind === 'minecraft-java', attached.kind);
  check('端口取自日志实际绑定值', attached.localPort === PORT, `${attached.localPort} vs ${PORT}`);
  check('不再回显密钥值', attached.detection?.properties === undefined, JSON.stringify(Object.keys(attached.detection ?? {})));
  check('只回显 propertyKeys', Array.isArray(attached.detection?.propertyKeys) && attached.detection.propertyKeys.includes('rcon.password'), JSON.stringify(attached.detection?.propertyKeys));

  console.log('\n[2] 四态判定');
  const handle = runtime.handles.get('fakesvc');
  const cold = await detectServiceState(handle);
  check('没人监听 + 没有我们的进程 → 冷启动', cold.state === 'cold', `${cold.state}：${cold.evidence}`);
  check('保护期来自公式', cold.guardSeconds >= 60, String(cold.guardSeconds));

  // Now occupy the port with a foreign process: the detector must say
  // "running, but no process of ours matches — find out who owns it",
  // rather than pretending it is our server.
  const foreign = net.createServer(() => {});
  await new Promise(resolve => foreign.listen(PORT, '127.0.0.1', resolve));
  const occupied = await detectServiceState(handle);
  check('端口被别人占 → running 且明确说不是我们的进程',
    occupied.state === 'running' && occupied.processes.length === 0 && /没有匹配到本服务的进程|别的东西/.test(occupied.evidence),
    `${occupied.state}：${occupied.evidence}`);
  await new Promise(resolve => foreign.close(resolve));
  check('关掉占用者后端口释放', (await isPortListening('127.0.0.1', PORT, 800)) === false);

  console.log('\n[3] 启动方式：脚本优先于 java -jar');
  const plan = detectStartPlan(svcDir);
  check('选中目录里的启动脚本', plan.kind === 'script', JSON.stringify(plan));
  check('脚本名是 启动服务器.bat', plan.ok === true && /启动服务器\.bat$/.test(plan.script), plan.script);

  console.log('\n[4] 交接顺序门禁（v3 §2.2 / §2.3）');
  const outDir = path.join(TMP, 'exported');
  // No tunnel record yet → export must refuse: the scripts would carry no
  // address, and the user might double-click them before a second export.
  const blocked = await serviceExportScripts(runtime, { id: 'fakesvc', dir: outDir });
  check('没有隧道记录时拒绝导出', blocked.ok === false && blocked.code === 'no-tunnel-record', JSON.stringify(blocked).slice(0, 240));
  check('给出必须先做的一步', typeof blocked.mustDoFirst === 'string' && blocked.mustDoFirst.includes('create'), blocked.mustDoFirst);
  check('返回交接检查点', blocked.handoff !== undefined && blocked.handoff.tunnelRecord === null && blocked.handoff.scriptsHaveAddress === false, JSON.stringify(blocked.handoff));
  check('说明可以 force 跳过', typeof blocked.forceHint === 'string' && blocked.forceHint.includes('force'), blocked.forceHint);

  // The ordered flow creates the tunnel RECORD first, then exports once.
  // `force` is used for the tunnel cross-check because THIS test is about file
  // generation: the id below does not exist on the account any more, and the
  // stale-record refusal is verified against the real API in live-fixes.
  const TUNNEL = { proxyId: 1224779 };

  // ── The command window is required, and it is DSH's job to author it ──
  const noConsole = await serviceExportScripts(runtime, { id: 'fakesvc', dir: outDir, ...TUNNEL, force: true });
  check('服务有指令通道但没带控制窗口 → 拒绝导出（v4 §3.4）',
    noConsole.ok === false && noConsole.code === 'control-window-missing',
    JSON.stringify(noConsole).slice(0, 300));
  check('指明必须先做的事是"生成控制窗口"',
    typeof noConsole.mustDoFirst === 'string' && noConsole.mustDoFirst.includes('指令控制窗口'), noConsole.mustDoFirst);
  check('给了生成规则（指向技能 + 换端要重推）',
    Array.isArray(noConsole.howToGenerate) && noConsole.howToGenerate.some(line => line.includes('dsh-openfrp-handoff'))
    && noConsole.howToGenerate.some(line => line.includes('基岩版')), JSON.stringify(noConsole.howToGenerate).slice(0, 200));
  check('交接检查点标明控制窗口缺失',
    noConsole.handoff?.controlWindow?.required === true && noConsole.handoff.controlWindow.provided === false,
    JSON.stringify(noConsole.handoff?.controlWindow));
  check('readyForHandoff 因控制窗口缺失而为 false', noConsole.handoff?.readyForHandoff === false, JSON.stringify(noConsole.handoff));

  // DSH generates the console for THIS service and passes it in.
  const CONSOLE_BAT = '@echo off\r\nchcp 65001 >nul\r\nnode "%~dp0my-console.cjs"\r\n';
  const CONSOLE_CJS = '// generated for this service\nconsole.log("hello");\n';
  const result = await serviceExportScripts(runtime, {
    id: 'fakesvc',
    dir: outDir,
    ...TUNNEL,
    memory: '3G',
    force: true,
    extraFiles: [
      { path: '控制台.bat', content: CONSOLE_BAT, role: 'control-window', note: '本次为这个服务生成' },
      { path: 'my-console.cjs', content: CONSOLE_CJS },
    ],
  });
  check('带上控制窗口后导出成功', result.ok === true, JSON.stringify(result).slice(0, 300));
  check('交接检查点显示隧道记录已就位', result.handoff?.tunnelRecord?.proxyId === 1224779, JSON.stringify(result.handoff));
  check('交接检查点显示控制窗口已提供',
    result.handoff?.controlWindow?.provided === true && result.handoff.controlWindow.files.includes('控制台.bat'),
    JSON.stringify(result.handoff?.controlWindow));
  // `readyForHandoff` stays false here — and that is the honest answer: the only
  // remaining blocker is the tunnel record, which does not exist on the account.
  // The point of the field is that it cannot be misread as "all clear".
  check('控制窗口满足后，剩下的拦截项只有隧道（诚实，不谎报就绪）',
    result.handoff?.readyForHandoff === false && result.handoff?.tunnelStillExists === false
    && result.handoff?.controlWindow?.provided === true,
    JSON.stringify(result.handoff));

  const expected = ['start-server.ps1', 'stop-server.ps1', 'start-tunnel.ps1', 'stop-tunnel.ps1', 'start-all.ps1', 'stop-all.ps1', 'debug-tunnel.ps1', '启动.bat', '停止.bat', 'README.md'];
  for (const name of expected) {
    check(`生成 ${name}`, fs.existsSync(path.join(outDir, name)), path.join(outDir, name));
  }

  console.log('\n[4b] DSH 生成的文件被原样写入，插件不塞自己的控制台');
  check('写入 DSH 生成的控制窗口', fs.existsSync(path.join(outDir, '控制台.bat')), 'missing');
  check('内容逐字保留（不被改写）',
    fs.readFileSync(path.join(outDir, '控制台.bat'), 'utf8') === CONSOLE_BAT,
    JSON.stringify(fs.readFileSync(path.join(outDir, '控制台.bat'), 'utf8')));
  check('写入 DSH 生成的配套脚本', fs.existsSync(path.join(outDir, 'my-console.cjs')), 'missing');
  check('没有偷偷塞一个写死的控制台（rcon-console.cjs 不应存在）',
    fs.existsSync(path.join(outDir, 'rcon-console.cjs')) === false,
    '插件不应该硬编码控制台 —— 控制通道随服务与端而变');
  check('导出文件列表里没有 rcon-console.cjs',
    result.files.every(f => !String(f.path).includes('rcon-console')), JSON.stringify(result.files.map(f => f.path)));
  check('tellUser 指出了 DSH 生成的那个控制窗口文件名',
    String(result.tellUser).includes('控制台.bat'), String(result.tellUser).slice(0, 260));
  check('agentMustSay 也点了名', String(result.agentMustSay).includes('控制台.bat'), String(result.agentMustSay).slice(0, 220));
  check('notes 说明控制窗口来自本次生成', result.notes.some(n => n.includes('控制台.bat')), JSON.stringify(result.notes));
  check('tellUser 要求先给自己 OP', String(result.tellUser).includes('op <你的游戏ID>'), String(result.tellUser).slice(0, 300));

  console.log('\n[5] BOM 规则');
  for (const name of expected) {
    const file = path.join(outDir, name);
    if (!fs.existsSync(file)) continue;
    const head = fs.readFileSync(file).subarray(0, 3);
    const hasBom = head[0] === 0xEF && head[1] === 0xBB && head[2] === 0xBF;
    if (name.toLowerCase().endsWith('.bat')) {
      check(`${name} 不带 BOM（cmd 会把它打出来）`, hasBom === false, `head=${head.toString('hex')}`);
    } else {
      check(`${name} 带 UTF-8 BOM（PS 5.1 需要）`, hasBom === true, `head=${head.toString('hex')}`);
    }
  }

  console.log('\n[6] 规则写进了脚本，而不是只写在文档里');
  const start = fs.readFileSync(path.join(outDir, 'start-server.ps1'), 'utf8');
  check('start-server.ps1 有世界锁说明', start.includes('session.lock') && start.includes('绝不另起'));
  check('start-server.ps1 有四态', ['冷启动', '热重启', '启动中', '僵尸'].every(k => start.includes(k)));
  check('start-server.ps1 调用了用户的启动脚本', start.includes('启动服务器.bat'));
  check('start-server.ps1 没有退回 java -jar', start.includes('-jar') === false);
  // With a script-based plan we deliberately do NOT inject JVM flags — the
  // user's own launcher owns them (a Fabric pack needs its own arguments).
  // The memory value is still carried as the script's parameter default.
  check('内存作为参数默认值被写进去（脚本分支不注入 JVM 参数）', start.includes("$Memory = '3G'"), start.slice(0, 400));
  // The java-jar branch is the one that actually materialises -Xmx.
  const jarStart = exportFixture({ startPlanKind: 'java-jar', existingStartScript: '' })
    .find(f => f.path === 'start-server.ps1').content;
  check('java-jar 分支才写 -Xmx', jarStart.includes('-Xmx2G'), 'jar branch should carry the heap');
  const readme = fs.readFileSync(path.join(outDir, 'README.md'), 'utf8');
  check('README 有四态表与换版本指引', readme.includes('四态') && readme.includes('世界锁'));

  console.log('\n[7] 密钥不落进脚本');
  for (const name of expected) {
    const file = path.join(outDir, name);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    check(`${name} 不含 RCON 密码`, text.includes('super-secret-pw') === false);
  }
  check('密码单独放 rcon-password.txt（与用户既有习惯一致）', fs.existsSync(path.join(outDir, 'rcon-password.txt')));

  console.log('\n[8] 必须告诉用户');
  check('返回了 tellUser 文案', typeof result.tellUser === 'string' && result.tellUser.includes('双击'), String(result.tellUser).slice(0, 80));
  check('返回了 agentMustSay 指令', typeof result.agentMustSay === 'string' && result.agentMustSay.includes('必须明确告诉用户'));
  check('说明了生命周期归属', result.lifecycle?.ownedBy === 'user', JSON.stringify(result.lifecycle));
  check('指向了技能（脚本只是实例）', result.methodology?.skill === 'dsh-openfrp-handoff', JSON.stringify(result.methodology?.skill));
  check('列出了换服务时要改的三处', Array.isArray(result.methodology?.reInstantiateThese) && result.methodology.reInstantiateThese.length === 3, JSON.stringify(result.methodology?.reInstantiateThese));

  console.log('\n[9] 幂等：重复导出不炸');
  const again = await serviceExportScripts(runtime, { id: 'fakesvc', dir: outDir, ...TUNNEL, force: true, extraFiles: [{ path: '控制台.bat', content: CONSOLE_BAT, role: 'control-window' }] });
  check('第二次导出也成功', again.ok === true, JSON.stringify(again).slice(0, 200));

  console.log('\n[10] 必须让用户亲手打开并回报（v3 §规范 A 第 ⑦ 步）');
  check('tellUser 要求用户回报「已打开」', String(result.tellUser).includes('已打开'), String(result.tellUser).slice(0, 220));
  check('agentMustSay 是两条指令', String(result.agentMustSay).includes('已打开'), String(result.agentMustSay).slice(0, 200));
  check('返回了 9 步交接顺序（含"先生成控制窗口"）', Array.isArray(result.handoffOrder) && result.handoffOrder.length === 9, String(result.handoffOrder?.length));
  check('顺序里含 service_stop 这一步', result.handoffOrder.some(line => line.includes('service_stop')), JSON.stringify(result.handoffOrder));
  check('顺序里含"生成指令控制窗口"这一步', result.handoffOrder.some(line => line.includes('指令控制窗口')), JSON.stringify(result.handoffOrder));

  console.log('\n[11] 启动脚本的窗口文案不能说谎（v3 D3）');
  const startAll = fs.readFileSync(path.join(outDir, 'start-all.ps1'), 'utf8');
  check('start-all 说明本窗口要保持打开', startAll.includes('本窗口要一直开着') || startAll.includes('关掉本窗口'), 'window wording');
  // Compare the actual invocations, not bare filenames: the explanatory comment
  // legitimately mentions start-server.ps1 before either call.
  const tunnelCall = startAll.indexOf('Start-Process');
  const serverCall = startAll.indexOf("& (Join-Path $Root 'start-server.ps1')");
  check('隧道在服务端之前真的被启动（前台会阻塞）',
    tunnelCall !== -1 && serverCall !== -1 && tunnelCall < serverCall,
    `tunnelCall=${tunnelCall} serverCall=${serverCall}`);
  const bat = fs.readFileSync(path.join(outDir, '启动.bat'), 'utf8');
  check('启动.bat 明说不能关窗口', /KEEP THIS WINDOW OPEN/.test(bat), bat.slice(0, 300));
  check('启动.bat 不再声称可以关窗口', /does NOT depend on it/.test(bat) === false, 'the old, false claim is still there');
  console.log('\n[12] 测试自己善后（不再污染注册表）');
  const detached = serviceDetach(runtime, { id: 'fakesvc' });
  check('导出测试移除自己挂靠的服务', detached.removed === true, JSON.stringify(detached));
  check('移除后注册表里没有它', (await serviceList(runtime)).services.some(s => s.id === 'fakesvc') === false, 'still there');
} catch (error) {
  check('测试过程未抛异常', false, `${error.message}\n${error.stack?.split('\n').slice(0, 5).join('\n')}`);
}

console.log(`\n导出目录：${path.join(TMP, 'exported')}`);
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const { name, detail } of failures) console.error(`\n--- ${name}\n${detail}`);
  process.exit(1);
}
