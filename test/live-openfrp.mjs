/**
 * Live verification of the two halves that do not need a human in the loop:
 *
 *  1. The OpenFrp REST client against the real API (release manifest + the
 *     unauthenticated error path, which must quote OpenFrp's own words).
 *  2. The argo remote-login *first step*: a real request for consent, which
 *     must come back with an authorization_url and a request_uuid. (We cancel
 *     it immediately; nothing is authorized, nothing is stored.)
 *
 * Run: node test/live-openfrp.mjs
 */

import { OpenFrpClient, listTunnelsByToken } from '../src/openfrp-client.js';
import { startLogin, cancelLogin, pendingLoginCount } from '../src/openfrp-auth.js';

let passed = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  ok  ${name}`); }
  else { failures.push({ name, detail }); console.log(`FAIL  ${name}\n      ${detail}`); }
}

console.log('\n[1] OpenFrp REST client — public endpoint');
const client = new OpenFrpClient({});
try {
  const software = await client.getSoftware();
  const data = software.data ?? {};
  check('getSoftware 成功（带 UA）', software.flag === true, JSON.stringify(software.raw).slice(0, 200));
  check('拿到 frpc 最新版本号', typeof data.latest_ver === 'string' && data.latest_ver !== '', String(data.latest_ver));
  check('拿到至少一个下载源', Array.isArray(data.source) && data.source.length > 0, JSON.stringify(data.source));
  console.log(`      frpc 最新版 ${data.latest_full}（${data.latest_ver}）`);
  for (const source of data.source ?? []) console.log(`      下载源：${source.label} → ${source.value}`);
} catch (error) {
  check('getSoftware 成功', false, error.message);
}

console.log('\n[2] 未登录时的错误必须是 OpenFrp 的原话');
try {
  await client.getUserInfo();
  check('未登录应当失败', false, '居然成功了');
} catch (error) {
  check('抛出了错误', error.name === 'OpenFrpError', error.name);
  check('错误里保留了 OpenFrp 的原文', error.message.includes('登入凭证无效'), error.message);
  console.log(`      ${error.message}`);
}

console.log('\n[3] 坏 token 的错误也要可读');
try {
  await listTunnelsByToken('00000000000000000000000000000000');
  check('坏 token 应当失败', false, '居然成功了');
} catch (error) {
  check('坏 token 抛出可读错误', /失败|拒绝|无效/.test(error.message), error.message);
  console.log(`      ${error.message}`);
}

console.log('\n[4] argo 远程登录：真实发起一次授权请求');
try {
  const started = await startLogin({});
  check('拿到 authorization_url', typeof started.authorizationUrl === 'string' && started.authorizationUrl.startsWith('http'), started.authorizationUrl);
  check('拿到 request_uuid', typeof started.requestUuid === 'string' && started.requestUuid.length > 8, started.requestUuid);
  check('有效期 5 分钟', new Date(started.expiresAt).getTime() - Date.now() <= 5 * 60 * 1000 + 2000, started.expiresAt);
  check('挂起的登录会话已记录', pendingLoginCount() === 1, String(pendingLoginCount()));
  console.log(`      授权地址：${started.authorizationUrl}`);
  console.log(`      request_uuid：${started.requestUuid}`);
  check('取消后会话被清除', cancelLogin(started.requestUuid) === true && pendingLoginCount() === 0, String(pendingLoginCount()));
} catch (error) {
  check('startLogin 成功', false, error.message);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const { name, detail } of failures) console.error(`\n--- ${name}\n${detail}`);
  process.exit(1);
}
