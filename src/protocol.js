/**
 * dsh-openfrp — protocol constants and shared types.
 *
 * Everything that is a *fact about the outside world* (API endpoints, frpc CLI
 * strings, log patterns, node/port rules) lives here, so the rest of the code
 * reads as intent rather than as magic strings.
 *
 * @module dsh-openfrp/protocol
 */

// ─────────────────────────────────────────────────────────────
// OpenFrp REST API
// ─────────────────────────────────────────────────────────────

/** Primary API host. 主 API 地址。 */
export const OF_API = 'https://api.openfrp.net';

/** Fallback API host (used by the official cross-platform launcher). 备用 API 地址。 */
export const OF_API_FALLBACK = 'https://of-dev-api.bfsea.com';

/** Remote-login service host. 远程登录服务地址。 */
export const OF_ACCESS = 'https://access.openfrp.net';

/**
 * OpenFrp's terms require every application to identify itself with a UA.
 * See docs/调研与技术方案.md §17.2 — requests without one may be blocked by their WAF.
 *
 * OpenFrp 服务条款要求第三方应用携带自己的 UA，否则可能被防火墙拦截。
 */
export const USER_AGENT = 'dsh-openfrp/0.1 (+https://github.com/chickmat/dsh-openfrp)';

/** REST paths under `OF_API`, all POST unless noted. 接口路径表。 */
export const EP = {
  getUserInfo: '/frp/api/getUserInfo',
  getUserProxies: '/frp/api/getUserProxies',
  getNodeList: '/frp/api/getNodeList',
  getNodeConf: '/frp/api/getNodeConf',
  getNodeStatus: '/frp/api/getNodeStatus',
  newProxy: '/frp/api/newProxy',
  editProxy: '/frp/api/editProxy',
  removeProxy: '/frp/api/removeProxy',
  changeProxy: '/frp/api/changeProxy',
  refreshProxyStatus: '/frp/api/refreshProxyStatus',
  // GET, token-only (no Authorization needed) — the cheapest read path there is.
  software: '/commonQuery/get?key=software',
};

/**
 * Token-only tunnel list. Note this is a *different* response shape from
 * `getUserProxies`: grouped by node, and it is the only endpoint that needs no
 * login. Returns `{ status, success, message, data: [{ node, proxies: [...] }] }`.
 *
 * 仅需 32 位用户 token 的只读隧道列表（按节点分组）。
 */
export function tokenTunnelListUrl(token, base = OF_API) {
  return `${base}/api?action=getallproxies&user=${encodeURIComponent(token)}`;
}

// ─────────────────────────────────────────────────────────────
// frpc
// ─────────────────────────────────────────────────────────────

/**
 * frpc CLI facts (verified against OF_0.67.0 and OF_0.68.0 on this machine):
 *  - `-u <token> -p <id[,id]>` is the "remote config mode": frpc pulls the whole
 *    tunnel definition from the OpenFrp API. We never generate a config file.
 *  - `--disable-log-color` matters: frpc emits ANSI escapes by default, which
 *    would break every log pattern below.
 *  - `--noupdate` stops frpc from replacing its own binary mid-run.
 */
export const FRPC_ARGS = {
  /** Flags always passed. 恒定参数。 */
  always: ['--disable-log-color', '--noupdate'],
};

/**
 * The lines that tell us a tunnel is actually up, and carry the public address.
 *
 * frpc ships **two** wordings and we must accept both, because the OpenFrp build
 * (OF_0.67.0, verified in the field) prints the Chinese one:
 *
 *   [client/control_ext.go:37] [tcp] 隧道 [dshmc] 启动成功, 请使用 [kr-se-cncn-1.ofalias.net:55219] 来连接服务.
 *   Your `name` proxy is available now. Use [`addr`] to connect.
 *
 * Matching only the English form was a real, field-found bug: frpc reported
 * success, the plugin kept waiting, and `openfrp_expose` failed after 90s while
 * the working address sat right there in the log.
 */
export const FRPC_READY_RE = /(?:proxy is available now|启动成功)[^[]*\[`?([^`\]]+)`?\]/i;

/** The Chinese local-service failure line, which quotes the wrong port verbatim. */
export const FRPC_LOCAL_FAIL_RE = /无法连接到本地服务\s*\[([^\]]+)\]/;

/** frpc error signatures worth turning into evidence. 错误特征 → 证据。 */
export const FRPC_ERRORS = [
  // Both wordings of the same failure: the OF build prints the Chinese one.
  { re: /connect to local service .* error/i, code: 'local-unreachable' },
  { re: /无法连接到本地服务/, code: 'local-unreachable' },
  { re: /proxy conflict|隧道冲突/i, code: 'proxy-conflict' },
  { re: /multi-instance racing|多实例竞争/i, code: 'multi-instance-racing' },
  { re: /port already used|端口已被占用/i, code: 'remote-port-taken' },
  { re: /login to server failed/i, code: 'login-failed' },
  { re: /i\/o deadline reached/i, code: 'node-overloaded' },
  { re: /OpenFRP API 拒绝请求|Forbidden|用户不存在或用户状态异常/i, code: 'token-rejected' },
  // Dialling :0 — the signature of the "local_port landed as 0" bug (B1).
  { re: /127\.0\.0\.1:0\b|:0: connectex|dial tcp \S*:0\b/i, code: 'zero-local-port' },
];

// ─────────────────────────────────────────────────────────────
// Minecraft / generic service facts (measured, see docs §13)
// ─────────────────────────────────────────────────────────────

/**
 * Minecraft server readiness marker. Measured on vanilla 26.3 and Fabric 26.2.
 * Only after this line is the server actually accepting connections.
 *
 * 服务端「真的起来了」的唯一可靠标志。
 */
export const MC_DONE_RE = /Done \(([\d.]+)s\)! For help, type "help"/;

/**
 * The server prints the port it *actually* bound. Trust this over
 * `server.properties`: a config can lie (another instance, a changed file).
 *
 * 实际绑定端口 —— 用它去建隧道，而不是信配置文件。
 */
export const MC_BOUND_RE = /Starting Minecraft server on \S*?:(\d+)/i;

/** RCON listener line, printed right after the server is up. */
export const MC_RCON_RE = /RCON running on ([\d.]+):(\d+)/;

/** Fatal bind failure — the evidence for "port is taken". */
export const MC_BIND_FAIL_RE = /FAILED TO BIND TO PORT|Perhaps a server is already running on that port/i;

/** Offline/insecure mode warning — worth surfacing before exposing to the internet. */
export const MC_OFFLINE_MODE_RE = /SERVER IS RUNNING IN OFFLINE\/INSECURE MODE/i;

// ─────────────────────────────────────────────────────────────
// Small shared helpers
// ─────────────────────────────────────────────────────────────

/** Strip ANSI escapes (frpc colour, Minecraft formatting). 去 ANSI 转义。 */
export function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

/** True when `port` is a usable TCP port number. */
export function isValidPort(port) {
  return Number.isInteger(port) && port > 0 && port < 65536;
}

/**
 * Build a cleaned environment for a child process: proxy variables removed
 * (the user runs a system proxy that must not capture frpc's traffic) and, on
 * Windows, case-duplicated keys collapsed because env names are
 * case-insensitive there.
 *
 * 子进程环境：清掉代理变量；Windows 下按键名小写去重（环境变量大小写不敏感）。
 */
export function cleanChildEnv(base = process.env, { keepProxy = false } = {}) {
  /** @type {Record<string,string>} */
  const out = {};
  const seen = new Set();
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    if (!keepProxy && (lower === 'http_proxy' || lower === 'https_proxy' || lower === 'all_proxy' || lower === 'no_proxy')) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** Human-readable "127.0.0.1:25565" for a handle. */
export function endpoint(host, port) {
  return `${host}:${port}`;
}

// ─────────────────────────────────────────────────────────────
// Tunnel naming (field-measured, see the test report B2)
// ─────────────────────────────────────────────────────────────

/**
 * OpenFrp accepts **lowercase ASCII letters only** in a tunnel name.
 * Measured: `dsh-mc-262` → "隧道名不符合要求"; `dshmc` → accepted. The account's
 * existing tunnels (`wdsj`, `httpsn`) fit the same shape.
 *
 * The API doc says nothing about this, and the error message does not either,
 * so the rule has to live here.
 */
export const TUNNEL_NAME_RE = /^[a-z]+$/;

/** Is this a name OpenFrp will accept? */
export function isValidTunnelName(name) {
  return typeof name === 'string' && TUNNEL_NAME_RE.test(name);
}

/**
 * Turn arbitrary text into a legal tunnel name: keep only ASCII letters, lower
 * case them. Returns `''` when nothing survives, so callers can fall back.
 */
export function sanitizeTunnelName(text) {
  return String(text ?? '').replace(/[^a-zA-Z]/g, '').toLowerCase();
}

/** A short, legal tunnel name derived from a service id. */
export function tunnelNameFor(serviceId, { suffix = '' } = {}) {
  const base = sanitizeTunnelName(serviceId) || 'dshsvc';
  return `${base}${sanitizeTunnelName(suffix)}`.slice(0, 24);
}

// ─────────────────────────────────────────────────────────────
// Remote port policy (field-measured, see the test report B3)
// ─────────────────────────────────────────────────────────────

/**
 * Ports OpenFrp refuses outright. Measured: `25565` → "远程端口处于系统保护端口区间".
 * The exact reserved set is not published, so we treat the well-known service
 * range as unusable and pick from the ephemeral band instead.
 */
export const PROTECTED_REMOTE_PORTS = new Set([
  20, 21, 22, 23, 25, 53, 80, 110, 135, 137, 138, 139, 143, 443, 445, 465, 587,
  993, 995, 1080, 1433, 1521, 1723, 2049, 25565, 25575, 27017, 3306, 3389, 5432,
  5900, 6379, 8080, 8443, 9200,
]);

/** Would OpenFrp likely reject this remote port before even looking at the node? */
export function isLikelyProtectedRemotePort(port) {
  if (!Number.isInteger(port)) return true;
  if (port < 1024) return true;
  return PROTECTED_REMOTE_PORTS.has(port);
}

/**
 * Candidate remote ports to try, best first. We stay in the ephemeral band
 * (10000–65535) and avoid the protected list, because the per-node `allowPort`
 * range is not always populated, so the reliable strategy is "pick a plausible
 * port and retry on rejection".
 *
 * When a node DOES publish an `allowPort` range, pass it through `filter` so the
 * first candidate is already legal — that turns a blind guess into a hit.
 *
 * @param {number} count
 * @param {{random?:()=>number, filter?:(port:number)=>boolean}} [options]
 */
export function pickRemotePortCandidates(count = 8, { random = Math.random, filter } = {}) {
  const out = [];
  const seen = new Set();
  const accept = port => {
    if (seen.has(port) || isLikelyProtectedRemotePort(port)) return false;
    if (typeof filter === 'function' && filter(port) !== true) return false;
    seen.add(port);
    out.push(port);
    return true;
  };

  let guard = 0;
  const limit = Math.max(count * 50, 200);
  while (out.length < count && guard < limit) {
    guard += 1;
    accept(10000 + Math.floor(random() * (65535 - 10000)));
  }

  // A degenerate random source (or a very unlucky streak) must not leave the
  // caller short of candidates, so finish with a deterministic sweep.
  let sweep = 20000;
  let sweepGuard = 0;
  while (out.length < count && sweepGuard < 60000) {
    sweepGuard += 1;
    sweep = sweep >= 65535 ? 20000 : sweep + 1;
    accept(sweep);
  }
  return out;
}

/**
 * Interpret an OpenFrp rejection of a remote port, so the caller can decide
 * whether another candidate is worth trying.
 */
export function classifyRemotePortError(message) {
  const text = String(message ?? '');
  if (/系统保护端口区间|保护端口/.test(text)) return 'protected';
  if (/不可用|已被占用|占用/.test(text)) return 'taken';
  if (/必须指定远程端口/.test(text)) return 'required';
  return 'unknown';
}
