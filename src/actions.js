/**
 * dsh-openfrp — actions.
 *
 * Every agent-facing capability is a plain function here, with **no DSH
 * dependency**, so it can be driven and tested from a bare `node` process
 * (`test/integration-mc.mjs` does exactly that). `tools.js` is a thin
 * registration layer on top.
 *
 * @module dsh-openfrp/actions
 */

import fs from 'node:fs';
import path from 'node:path';
import { OpenFrpClient, OpenFrpError, publicAddressOf, cnameTargetOf, rankNodes, portAllowedByNode, explainNodeChoice } from './openfrp-client.js';
import { startLogin, pollLogin, waitLogin, cancelLogin, pendingLoginCount, openInBrowser } from './openfrp-auth.js';
import { FrpcInstance, ensureFrpc, locateFrpc, readFrpcVersion, frpcCacheDir } from './frpc.js';
import {
  attachService, probeService, diagnoseFromObservations, findFreePort,
  refreshRconCredentials, detectStartPlan, startDetached, readServerProperties, findJava, planToCommand,
  detectServiceState, clearServiceProcesses, bootWaitSecondsFor, watchStart, pidsAlive, fixConfigBoms,
} from './service.js';
import { buildExportFiles, EXPORT_DIR_NAME, userInstruction } from './script-templates.js';
import { readTailLines, collectLines, waitForLine } from './logtail.js';
import { withRcon } from './rcon.js';
import {
  sanitizeTunnelName, pickRemotePortCandidates, classifyRemotePortError, tunnelNameFor, MC_DONE_RE,
} from './protocol.js';
import {
  loadCredentials, saveCredentials, clearCredentials, replaceCredentials,
  loadRegistry, upsertService, removeService, getService, dataDir,
} from './registry.js';

/** Runtime state shared by all actions. 所有 action 共享的运行时状态。 */
export function createRuntime({ config = {}, fetchImpl, logger } = {}) {
  const log = (level, message) => logger?.[level]?.(`[openfrp] ${message}`);
  const credentials = loadCredentials();

  const runtime = {
    config,
    fetchImpl,
    log,
    /** @type {Map<string, any>} attached service handles */
    handles: new Map(),
    /** @type {Map<string, FrpcInstance>} frpc processes we own */
    instances: new Map(),
    /** @type {Map<number, {localPort:number, errors:Array<{code:string,line:string}>, address:string}>} */
    tunnels: new Map(),
    credentials,
    client: null,
  };

  runtime.getClient = () => {
    const authorization = runtime.credentials.authorization ?? config.authorization ?? '';
    if (runtime.client === null || runtime.client.authorization !== authorization) {
      runtime.client = new OpenFrpClient({
        authorization,
        base: config.apiBase || undefined,
        fetchImpl,
        onAuthorizationRotated: rotated => {
          runtime.credentials = saveCredentials({ authorization: rotated });
          log('info', 'Authorization 已轮转并落盘');
        },
      });
    }
    return runtime.client;
  };

  runtime.requireAuth = () => {
    const client = runtime.getClient();
    if (!client.authenticated) {
      throw new Error('尚未登录 OpenFrp。请先执行 openfrp_account 的 login 动作，在浏览器里完成授权。');
    }
    return client;
  };

  /** Get (or lazily build) the handle for a service id, using the registry as a cache. */
  runtime.handleFor = async id => {
    if (runtime.handles.has(id)) return runtime.handles.get(id);
    const record = getService(id);
    if (record === null) throw new Error(`注册表里没有服务「${id}」。先用 service_attach 挂靠它。`);
    const handle = await attachService({ id, target: record.root, port: record.localPort ?? undefined });
    runtime.handles.set(id, handle);
    return handle;
  };

  return runtime;
}

// ─────────────────────────────────────────────────────────────
// Account
// ─────────────────────────────────────────────────────────────

export async function accountStatus(runtime) {
  const credentials = loadCredentials();
  runtime.credentials = credentials;
  const hasAuthorization = typeof credentials.authorization === 'string' && credentials.authorization !== '';

  let account = null;
  let error = '';
  if (hasAuthorization) {
    try {
      const info = (await runtime.getClient().getUserInfo()).data ?? {};
      // The 32-bit user token is what frpc's `-u` needs; capture it once we see it.
      if (typeof info.token === 'string' && info.token !== '') {
        runtime.credentials = saveCredentials({ token: info.token, username: info.username ?? '' });
      }
      account = {
        username: info.username,
        email: info.email,
        // `group` is the MACHINE key OpenFrp uses for node permissions
        // (normal / vip / svip / admin / dev); `friendlyGroup` is only a display
        // name. Keeping the display name in `group` was a real bug: the account
        // is VIP, but node filtering was told "normal" and rejected every node
        // the account could actually use.
        group: info.group,
        friendlyGroup: info.friendlyGroup ?? '',
        // Whether the account has passed real-name verification. OpenFrp
        // returns this; defaulting it to `false` silently excluded every
        // mainland node (they all carry needRealname) for verified users too.
        realname: info.realname === true,
        traffic: info.traffic,
        proxies: info.proxies,
        used: info.used,
        tokenKnown: typeof runtime.credentials.token === 'string' && runtime.credentials.token !== '',
      };
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  return {
    loggedIn: hasAuthorization && error === '',
    hasAuthorization,
    tokenKnown: typeof runtime.credentials.token === 'string' && runtime.credentials.token !== '',
    account,
    error,
    pendingLogins: pendingLoginCount(),
  };
}

/** Begin a remote login. Returns the URL the human must open. */
export async function accountLogin(runtime, { autoOpen = true } = {}) {
  const started = await startLogin({ fetchImpl: runtime.fetchImpl });
  const opened = autoOpen ? await openInBrowser(started.authorizationUrl) : { opened: false, via: 'skipped' };
  return {
    ...started,
    autoOpened: opened.opened,
    openVia: opened.via,
    instruction: opened.opened
      ? '已在浏览器中打开授权页，请在页面上确认。完成后调用 openfrp_account 的 poll（或 wait）动作。'
      : `请手动在浏览器打开这个地址完成授权：${started.authorizationUrl}`,
  };
}

export async function accountPoll(runtime, { requestUuid }) {
  const result = await pollLogin(requestUuid, { fetchImpl: runtime.fetchImpl });
  if (result.status === 'ready') {
    runtime.credentials = saveCredentials({ authorization: result.authorization });
    runtime.client = null;
    const status = await accountStatus(runtime);
    return { ...result, status };
  }
  return result;
}

export async function accountWait(runtime, { requestUuid, timeoutMs }) {
  const result = await waitLogin(requestUuid, { fetchImpl: runtime.fetchImpl, timeoutMs });
  runtime.credentials = saveCredentials({ authorization: result.authorization });
  runtime.client = null;
  const status = await accountStatus(runtime);
  return { ...result, status };
}

export function accountLogout(runtime) {
  clearCredentials();
  runtime.credentials = {};
  runtime.client = null;
  return { ok: true, message: '本地凭据已清除（OpenFrp 服务端的会话不受影响）。' };
}

// ─────────────────────────────────────────────────────────────
// Tunnels & nodes
// ─────────────────────────────────────────────────────────────

/** All tunnels, with the public address and CNAME target resolved for each. */
export async function tunnelsList(runtime) {
  const client = runtime.requireAuth();
  const { data } = await client.getUserProxies();
  const list = Array.isArray(data?.list) ? data.list : [];
  const tunnels = list.map(proxy => {
    const localPort = Number(proxy.localPort);
    // A local port of 0 is never legitimate, and it is the *earliest* visible
    // symptom of a broken create/edit. Say so here instead of waiting for frpc
    // to dial 127.0.0.1:0.
    const warning = localPort === 0
      ? '本地端口是 0 —— 这条隧道无法工作（frpc 会向 127.0.0.1:0 拨号）。请用 openfrp_tunnel 的 edit 重设 local_port，'
        + '或用 delete 删掉后重建。'
      : undefined;
    return {
      id: proxy.id,
      name: proxy.proxyName,
      type: proxy.proxyType,
      node: proxy.friendlyNode,
      nodeId: proxy.nid,
      online: proxy.online === true,
      enabled: proxy.status !== false,
      local: `${proxy.localIp ?? '?'}:${proxy.localPort ?? '?'}`,
      localPort: Number.isFinite(localPort) ? localPort : null,
      public: publicAddressOf(proxy),
      cname: cnameTargetOf(proxy),
      domains: parseDomains(proxy.domain),
      ownedByPlugin: runtime.instances.has(proxy.id) ? 'plugin' : (proxy.online === true ? 'unknown-or-other-client' : 'none'),
      ...(warning === undefined ? {} : { warning }),
    };
  });
  const broken = tunnels.filter(t => t.warning !== undefined).map(t => t.name);
  return {
    total: data?.total ?? tunnels.length,
    tunnels,
    ...(broken.length === 0 ? {} : { warnings: `${broken.length} 条隧道的本地端口是 0，不可用：${broken.join('、')}` }),
  };
}

function parseDomains(domain) {
  if (typeof domain !== 'string' || domain === '') return [];
  try {
    const parsed = JSON.parse(domain);
    return Array.isArray(parsed) ? parsed : [domain];
  } catch {
    return [domain];
  }
}

/**
 * Nodes, filtered and ranked with reasons attached.
 *
 * Node permission is checked against the account's **machine** group key, not
 * its display name. `allowPort` is passed through as-is: measured, OpenFrp
 * returns it empty, so the plugin cannot use it to choose a remote port and
 * must instead retry candidates (see `remotePortPolicy` in the result).
 */
export async function nodesList(runtime, { protocol, realname, classify } = {}) {
  const client = runtime.requireAuth();
  const { data } = await client.getNodeList();
  const nodes = Array.isArray(data?.list) ? data.list : [];
  const account = (await accountStatus(runtime)).account;
  // Default to the account's ACTUAL verification state, never to "not verified".
  const effectiveRealname = realname === undefined ? account?.realname === true : realname === true;
  const { ranked, rejected } = rankNodes(nodes, {
    protocol,
    userGroup: account?.group === undefined ? undefined : account.group,
    realname: effectiveRealname,
    classify,
    // A verified account can legally use the mainland nodes, so put them first
    // instead of letting a big overseas bandwidth number win (report v3 §3).
    preferDomestic: effectiveRealname,
  });
  const anyAllowPort = nodes.some(node => typeof node?.allowPort === 'string' && node.allowPort !== '');
  return {
    total: nodes.length,
    suitable: ranked.length,
    accountGroup: account?.group ?? null,
    realnameVerified: effectiveRealname,
    ranked: ranked.slice(0, 20).map(node => ({ ...node, reason: explainNodeChoice(node, { preferDomestic: effectiveRealname, protocol }) })),
    rejected: rejected.slice(0, 20),
    remotePortPolicy: anyAllowPort
      ? '节点的 allowPort 区间可用；请把 remote_port 选在该区间内。'
      : 'OpenFrp 未返回可用的 allowPort 区间，无法预先判断哪个端口可用。'
        + 'tcp/udp 隧道必须显式指定 remote_port，且 1024 以下与常见服务端口会被拒（实测 25565 属于"系统保护端口区间"）。'
        + '建议从 10000-65535 里挑，失败时换一个重试；openfrp_tunnel 的 create 在未指定端口时会自动这么做。',
  };
}

/**
 * Create a tunnel, then **read it back and verify it**. Never report success on
 * the strength of the API's own `msg`.
 *
 * The field bug this guards against: submitting `local_port` as the string
 * `"25566"` made OpenFrp store `0`, so the tunnel registered fine, `create`
 * said 成功, and frpc then dialled `127.0.0.1:0` forever. The only way to catch
 * that is to re-read the record and compare.
 */
export async function tunnelCreate(runtime, fields) {
  const client = runtime.requireAuth();
  return createAndVerify(runtime, client, fields);
}

/** Edit a tunnel, then read it back. `edit` can fail silently the same way. */
export async function tunnelEdit(runtime, fields) {
  const client = runtime.requireAuth();
  if (fields?.proxy_id === undefined) throw new Error('编辑隧道必须提供 proxy_id');
  const payload = normalizeProxyFields(fields, { editing: true });
  await client.editProxy(payload);
  const verification = await verifyTunnelRecord(client, { name: payload.name, localPort: payload.local_port });
  if (verification.ok !== true) {
    return {
      ok: false,
      code: 'edit-not-applied',
      message: 'OpenFrp 返回"保存成功"，但回读到的记录与提交值不一致 —— 这次编辑没有真正生效。',
      submitted: { name: payload.name, local_port: payload.local_port },
      readBack: verification.record ?? null,
      evidence: verification.detail,
    };
  }
  return { ok: true, message: '保存成功，且已回读确认。', verified: verification.record };
}

export async function tunnelDelete(runtime, { proxyId }) {
  const client = runtime.requireAuth();
  const result = await client.removeProxy(proxyId);
  runtime.instances.delete(proxyId);
  return { ok: true, message: result.msg };
}

/**
 * Enable or disable a tunnel **record** on OpenFrp's side.
 *
 * Note this flips the server-side record, not the local frpc process — a
 * distinction worth stating, because "enable the tunnel" reads like "start the
 * tunnel" and the two are different things here. To actually start forwarding,
 * use `openfrp_expose`.
 *
 * This lives in the action layer rather than inline in the tool spec so that the
 * tool layer stays pure routing — one rule, no exceptions to audit.
 */
export async function tunnelSetEnabled(runtime, { proxyId, enabled }) {
  const client = runtime.requireAuth();
  const result = await client.changeProxy(proxyId, enabled === true);
  return {
    ok: true,
    proxyId,
    enabled: enabled === true,
    message: result.msg,
    note: '⚠️ 改的是 OpenFrp 服务端的隧道「启用状态」，**不是**本机 frpc 进程。要让隧道真的开始转发，用 openfrp_expose（action=up）。',
  };
}

/**
 * Normalize the 13 documented fields.
 *
 * Two field-measured rules that the API documentation gets wrong or omits:
 *  - `local_port` must be sent as a **number**. The doc's example shows a
 *    string, and sending a string lands as `0` server-side (report B1).
 *  - `name` must match `^[a-z]+$`. Hyphens and digits are rejected with
 *    "隧道名不符合要求" (report B2).
 */
export function normalizeProxyFields(fields, { editing = false } = {}) {
  // Accept both naming styles. The tool layer camelizes every argument in one
  // place, but this function is also called directly (and from tests) with the
  // snake_case names OpenFrp itself uses. Tolerating both here means a rename can
  // never silently drop a field — the failure mode that shipped a tunnel with
  // `local_port: 0`.
  const f = { ...fields };
  for (const [key, value] of Object.entries(fields)) {
    const snake = key.replace(/[A-Z]/g, ch => `_${ch.toLowerCase()}`);
    if (snake !== key && f[snake] === undefined) f[snake] = value;
  }

  const type = String(f.type ?? 'tcp').toLowerCase();
  const localPort = Number(f.local_port);
  if (!Number.isInteger(localPort) || localPort <= 0 || localPort > 65535) {
    throw new Error(`local_port 必须是 1-65535 的整数，收到的是 ${JSON.stringify(f.local_port)}。`);
  }
  const requestedName = String(f.name ?? '');
  const name = sanitizeTunnelName(requestedName);

  const out = {
    name,
    type,
    local_addr: f.local_addr ?? '127.0.0.1',
    local_port: localPort,
    node_id: Number(f.node_id),
    autoTls: String(f.autoTls ?? 'false'),
    custom: f.custom ?? '',
    dataEncrypt: f.dataEncrypt === true,
    dataGzip: f.dataGzip === true,
    domain_bind: f.domain_bind ?? '',
    forceHttps: f.forceHttps === true,
    proxyProtocolVersion: f.proxyProtocolVersion === true,
  };
  if (editing) {
    out.proxy_id = Number(f.proxy_id);
    out.remote_port = f.remote_port === undefined || f.remote_port === '' ? '' : Number(f.remote_port);
  } else if (type === 'http' || type === 'https') {
    out.remote_port = '';
  } else {
    out.remote_port = Number(f.remote_port);
  }
  out.__nameChangedFrom = name === requestedName ? null : requestedName;
  return out;
}

/** Strip the internal marker before anything is sent to OpenFrp. */
function cleanPayload(payload) {
  const { __nameChangedFrom, ...rest } = payload;
  return rest;
}

/**
 * Create, retrying remote-port candidates when the caller did not pin one, and
 * always verifying the result by reading the record back.
 */
async function createAndVerify(runtime, client, fields, { maxPortAttempts = 6, allowPort = null } = {}) {
  const base = normalizeProxyFields(fields);
  const wantsPort = base.type !== 'http' && base.type !== 'https';
  const explicitPort = Number.isFinite(base.remote_port) && base.remote_port > 0 ? base.remote_port : null;

  const notes = [];
  if (base.__nameChangedFrom !== null && base.__nameChangedFrom !== '') {
    notes.push(`隧道名已按 OpenFrp 的规则改写：${JSON.stringify(base.__nameChangedFrom)} → ${JSON.stringify(base.name)}（只允许小写字母）。`);
  }
  if (allowPort) {
    notes.push(`节点公布了可用端口段 ${allowPort}，候选端口只从这个区间里挑（实测有的节点确实会返回这个字段）。`);
  }

  // When the node publishes an allowPort range, filter candidates through it so
  // the first attempt is already legal instead of a blind guess (report v3 §1.3).
  const inRange = allowPort ? (port => portAllowedByNode(allowPort, port)) : undefined;
  const candidates = wantsPort
    ? (explicitPort === null ? pickRemotePortCandidates(maxPortAttempts, { filter: inRange }) : [explicitPort])
    : [null];

  const attempts = [];
  for (const port of candidates) {
    const payload = { ...cleanPayload(base), ...(port === null ? {} : { remote_port: port }) };
    try {
      const result = await client.newProxy(payload);
      attempts.push({ remote_port: port, ok: true, message: result.msg });
    } catch (error) {
      const kind = classifyRemotePortError(error?.message);
      attempts.push({ remote_port: port, ok: false, reason: kind, message: error?.message });
      if (explicitPort !== null || (kind !== 'protected' && kind !== 'taken')) throw error;
      continue;
    }

    const verification = await verifyTunnelRecord(client, { name: payload.name, localPort: payload.local_port });
    if (verification.ok === true) {
      return {
        ok: true,
        message: '创建成功，且已回读确认。',
        payload,
        verified: verification.record,
        remotePort: port,
        ...(notes.length === 0 ? {} : { notes }),
      };
    }
    // Created but not usable — surface it instead of pretending it worked.
    return {
      ok: false,
      code: 'created-but-unusable',
      message: '隧道创建了，但回读发现它不可用（本地端口不是提交的值）。这条隧道是坏的，建议立刻 delete 掉重来。',
      submitted: { name: payload.name, local_port: payload.local_port, remote_port: port },
      readBack: verification.record ?? null,
      evidence: verification.detail,
      attempts,
      ...(notes.length === 0 ? {} : { notes }),
    };
  }

  if (explicitPort !== null) {
    const kind = attempts.at(-1)?.reason;
    return {
      ok: false,
      code: `remote-port-${kind ?? 'failed'}`,
      message: kind === 'protected'
        ? `远程端口 ${explicitPort} 落在 OpenFrp 的系统保护端口区间，被拒绝。`
        : `远程端口 ${explicitPort} 不可用或已被占用。`,
      attempts,
      suggestedRemotePorts: pickRemotePortCandidates(4),
      hint: '不传 remote_port 时，create 会自动从 10000-65535 里挑一个可用的端口并重试。',
    };
  }

  return { ok: false, code: 'create-failed', message: '所有候选远程端口都被拒绝。', attempts };
}

/**
 * Read the tunnel back and check the fields that silently go wrong.
 * Returns `{ ok, record, detail }`.
 */
async function verifyTunnelRecord(client, { name, localPort }) {
  const list = (await client.getUserProxies()).data?.list ?? [];
  const record = list.find(proxy => proxy.proxyName === name) ?? null;
  if (record === null) {
    return { ok: false, record: null, detail: `回读隧道列表时没有找到名为 ${name} 的隧道。` };
  }
  const actual = Number(record.localPort);
  if (actual !== Number(localPort)) {
    return {
      ok: false,
      record,
      detail: `提交的 local_port=${localPort}，回读到的 localPort=${record.localPort}（OpenFrp 把它落成了 ${actual}）。`
        + '这会让 frpc 向 127.0.0.1:0 拨号，隧道永远打不到本地服务。',
    };
  }
  return { ok: true, record, detail: '' };
}

// ─────────────────────────────────────────────────────────────
// Services
// ─────────────────────────────────────────────────────────────

/** Attach to a local service by directory or port, and remember it. */
export async function serviceAttach(runtime, { id, target, port, kind } = {}) {
  const resolvedId = id ?? (target !== undefined && target !== null ? path.basename(path.resolve(target)) : `port-${port}`);
  const handle = await attachService({ id: resolvedId, target: target ?? process.cwd(), port, kindHint: kind });
  runtime.handles.set(resolvedId, handle);
  upsertService({
    id: resolvedId,
    kind: handle.kind,
    root: handle.root,
    localPort: handle.localPort,
    logs: handle.logs,
    exec: handle.exec === null ? null : { kind: 'rcon', host: handle.exec.host, port: handle.exec.port, passwordRef: `svc:${resolvedId}:rcon` },
  });
  return {
    id: resolvedId,
    kind: handle.kind,
    root: handle.root,
    localPort: handle.localPort,
    localPortSource: handle.localPortSource,
    logFile: handle.logs?.path ?? null,
    commandChannel: handle.exec === null ? '无（未启用 RCON）' : `RCON ${handle.exec.host}:${handle.exec.port}（来源：${handle.exec.source}）`,
    // Never surface server.properties verbatim: it carries rcon.password and
    // management-server-secret, which would land in the model context and the
    // session transcript. Only the key names are safe to show.
    detection: redactDetection(handle.detection),
    observed: handle.observed,
    configHints: handle.configHints,
  };
}

/** Drop secret-bearing values from a detection record. 脱敏。 */
function redactDetection(detection) {
  if (detection === undefined || detection === null) return detection;
  const { properties, ...rest } = detection;
  return {
    ...rest,
    propertyKeys: properties === undefined || properties === null ? [] : Object.keys(properties),
  };
}

/**
 * Forget a service in the registry.
 *
 * The registry could only ever grow: test entries and abandoned services piled
 * up with no way to remove them (report v4, finding 2). This removes the
 * plugin's own record and nothing else — no files, no processes, no tunnels.
 *
 * 从注册表移除一条服务记录。只动插件自己的记录，不碰磁盘、进程和隧道。
 */
export function serviceDetach(runtime, { id } = {}) {
  if (typeof id !== 'string' || id === '') throw new Error('service_detach 需要 id');
  const existed = removeService(id);
  runtime.handles.delete(id);
  return {
    ok: true,
    id,
    removed: existed,
    message: existed
      ? `已从注册表移除「${id}」。磁盘上的服务、正在跑的进程、以及 OpenFrp 上的隧道都没有被改动。`
      : `注册表里本来就没有「${id}」。`,
    note: '如果这个服务还有隧道记录，那条隧道仍然存在于 OpenFrp；要删隧道请用 openfrp_tunnel 的 delete。',
  };
}

export async function serviceList(runtime) {
  const registry = loadRegistry();

  // Cross-check the stored tunnel ids against the account. A tunnel deleted in
  // the web panel leaves a stale proxyId behind, and every later `expose up`
  // would then report nonsense instead of "that tunnel no longer exists"
  // (report v3 D6).
  let liveIds = null;
  try {
    const client = runtime.getClient();
    if (client.authenticated) {
      liveIds = new Set(((await client.getUserProxies()).data?.list ?? []).map(p => Number(p.id)));
    }
  } catch {
    /* not logged in / offline: skip the cross-check rather than failing the call */
  }

  return {
    services: registry.services.map(record => {
      const handle = runtime.handles.get(record.id);
      const proxyId = record.tunnel?.proxyId;
      const instance = proxyId === undefined ? null : runtime.instances.get(proxyId);
      const stale = liveIds !== null && proxyId !== undefined && !liveIds.has(Number(proxyId));
      return {
        id: record.id,
        kind: record.kind,
        root: record.root,
        localPort: handle?.localPort ?? record.localPort ?? null,
        tunnel: record.tunnel ?? null,
        frpcRunning: instance?.running === true,
        ...(stale ? {
          stale: true,
          warning: `记录的隧道 ${proxyId} 在 OpenFrp 上已经不存在（可能被删了）。`
            + '用 openfrp_tunnel 重新建一条，然后重新 service_export_scripts 更新脚本里的地址。',
        } : {}),
        updatedAt: record.updatedAt,
      };
    }),
    ...(liveIds === null ? { accountCheck: '未登录 OpenFrp，没有核对隧道记录是否仍然存在。' } : {}),
  };
}

export async function serviceStatus(runtime, { id } = {}) {
  const handle = await runtime.handleFor(id);
  const status = await probeService(handle);
  return { id, ...status };
}

/**
 * Start a service and follow its log to readiness.
 *
 * Two deliberate properties:
 *  - **Detached from the DSH process tree.** A Minecraft server runs for hours;
 *    a DSH child is killed when the host stops, and its exit wakes the agent
 *    with a result nobody asked for. `stdio: 'ignore'` is also the only spawn
 *    mode that works inside a confined sandbox — the log file is the
 *    observation channel, so no pipe is needed.
 *  - **It refuses to start a second copy.** If the port is already listening or
 *    RCON already answers, it reports `alreadyRunning` instead of doubling up.
 */
export async function serviceStart(runtime, { id, script, waitMs = 180_000 } = {}) {
  const handle = await runtime.handleFor(id);

  // Four-state check BEFORE starting anything. This is the world-lock guard:
  // "port quiet" is NOT "not running" — a server that is still loading holds
  // session.lock already, so starting a second copy makes both fail.
  const plan = (script !== undefined && script !== '')
    ? { ok: true, kind: 'script', script: path.resolve(script), evidence: '调用方显式指定的启动脚本' }
    : detectStartPlan(handle.root);
  const state = await detectServiceState(handle, { plan });
  if (state.state === 'running') {
    return {
      ok: true,
      alreadyRunning: true,
      state: state.state,
      id: handle.id,
      localPort: handle.localPort,
      message: '该服务已经在运行，没有重复启动。',
      evidence: state.evidence,
      action: state.action,
    };
  }

  if (state.state === 'starting') {
    // Wait for the instance that is already loading. Never start a second one.
    const logPath = handle.logs?.path ?? null;
    if (logPath !== null) {
      try {
        const ready = await waitForLine(logPath, MC_DONE_RE, { timeoutMs: waitMs, fromOffset: -1 });
        return {
          ok: true,
          alreadyRunning: true,
          adopted: true,
          state: 'starting',
          id: handle.id,
          localPort: handle.localPort,
          message: '检测到实例正在启动中，等它就绪，没有重复启动。',
          evidence: state.evidence,
          readyLine: ready.line,
        };
      } catch (error) {
        return {
          ok: false,
          code: 'starting-not-ready',
          state: 'starting',
          id: handle.id,
          message: `实例在启动中，但等不到就绪标志：${error.message}`,
          evidence: state.evidence,
          processes: state.processes,
          hint: '不要重复启动（会抢世界锁）。先看 service_logs 判断它卡在哪。',
        };
      }
    }
    return {
      ok: false,
      code: 'starting-unknown',
      state: 'starting',
      id: handle.id,
      message: '实例正在启动中，且该服务没有可跟读的日志，无法确认就绪 —— 不重复启动。',
      evidence: state.evidence,
    };
  }

  let cleared = null;
  if (state.state === 'zombie') {
    // A stuck/timed-out instance still holds session.lock, so the next start
    // would fail. Clear it first, and say exactly what was cleared.
    cleared = await clearServiceProcesses(handle);
  }

  if (plan.ok !== true) {
    return { ok: false, code: 'no-start-plan', message: plan.reason, hint: '可以用 script 参数显式指定启动脚本。' };
  }

  let invocation;
  try {
    invocation = planToCommand(plan, { java: plan.kind === 'java-jar' ? findJava() : '' });
  } catch (error) {
    return { ok: false, code: 'no-java', message: error.message };
  }

  // A UTF-8 BOM on eula.txt is invisible and fatal: the server reads the first
  // line as "\uFEFFeula=true" and refuses to run. Measured cause of two silently
  // failed starts (report v3 D7), so we verify the bytes and fix them here.
  const bom = fixConfigBoms(handle.root);
  const bomNote = bom.found.length === 0 ? null : {
    found: bom.found.map(hit => `${hit.file}(${hit.bytes})`),
    fixed: bom.fixed.filter(hit => hit.fixed === true).map(hit => hit.file),
    why: 'UTF-8 BOM 会让服务端读不懂第一行（eula.txt 尤其致命），已就地去掉。',
  };

  // Remember where the log ended, so readiness cannot be satisfied by a stale
  // "Done" line from a previous run. (tailFile also survives log rotation.)
  const logPath = handle.logs?.path ?? null;
  const startOffset = logPath !== null && fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;

  // Capture the child's own output into a file. Without it, "never spawned" and
  // "spawned and died immediately" are indistinguishable (report v3 D1).
  const spawnLog = path.join(dataDir(), 'logs', `start-${handle.id}.log`);
  const started = startDetached({
    command: invocation.command,
    args: invocation.args,
    cwd: handle.root,
    logFile: spawnLog,
  });

  const result = {
    ok: true,
    id: handle.id,
    spawnedPid: started.pid,
    stateBefore: state.state,
    ...(cleared === null ? {} : { clearedZombies: cleared }),
    ...(bomNote === null ? {} : { bomRepair: bomNote }),
    command: [invocation.command, ...invocation.args].join(' '),
    cwd: handle.root,
    spawnLog,
    startPlan: { kind: plan.kind, evidence: plan.evidence, ...(plan.caveat === undefined ? {} : { caveat: plan.caveat }) },
    // The honest statement, and it matters. Measured (report v2 §2.1): a process
    // started by DSH — whether a background job or `Start-Process` — is GONE
    // after the DSH host restarts. Only a process the USER launched survives.
    lifecycle: {
      ownedBy: 'dsh-session',
      survivesHostRestart: false,
      evidence: '实测：DSH 重启后，后台任务与 Start-Process 启动的进程都已不存在。',
      forLongRunning: '要长期开着的服务，请用 service_export_scripts 导出脚本并自己双击运行 —— 由用户启动的进程不受 DSH 开关影响。',
    },
  };

  if (started.pid === null) {
    return {
      ...result,
      ok: false,
      code: 'spawn-failed',
      message: `无法派生进程：${[invocation.command, ...invocation.args].join(' ')}`,
      stderr: readTailLines(spawnLog, 20),
    };
  }

  // Watch it. This is the part that was missing: previously we only waited on
  // the log, so a process that died instantly looked identical to one that was
  // still loading, and we burned the whole guard window before giving up.
  const watch = await watchStart(started.pid, {
    port: handle.localPort ?? null,
    host: handle.host ?? '127.0.0.1',
    timeoutMs: Math.min(waitMs, 30_000),
  });
  if (watch.outcome === 'exited') {
    refreshRconCredentials(handle);
    return {
      ...result,
      ok: false,
      code: 'start-failed',
      outcome: 'exited',
      message: `进程 PID ${started.pid} 已退出，端口 ${handle.localPort} 始终没有监听 —— 启动失败。`,
      spawnOutput: readTailLines(spawnLog, 30),
      hint: '看 spawnOutput 的第一段报错：EULA 未接受 / Java 版本不对 / 内存不足 / 端口被占，都会在这里直接写出来。',
    };
  }
  if (watch.outcome === 'timeout') {
    return {
      ...result,
      ok: false,
      code: 'start-timeout',
      outcome: 'timeout',
      message: `进程 PID ${started.pid} 仍在运行，但 ${Math.min(waitMs, 30_000)}ms 内端口 ${handle.localPort} 没有监听。`,
      spawnOutput: readTailLines(spawnLog, 30),
      hint: '可能还在加载（大整合包正常），也可能是卡住了。用 service_logs 或 spawnOutput 判断。',
    };
  }

  // Listening. Now wait for the application-level readiness marker.
  result.portListening = true;
  if (logPath === null) {
    return { ...result, ready: null, message: '端口已监听；但这个服务没有可跟读的日志，无法确认应用层就绪。' };
  }
  try {
    const ready = await waitForLine(logPath, MC_DONE_RE, { timeoutMs: waitMs, fromOffset: startOffset });
    return { ...result, ready: true, readyLine: ready.line, message: '已启动，端口已监听，应用层已就绪。' };
  } catch (error) {
    const recent = readTailLines(logPath, 25);
    refreshRconCredentials(handle);
    return {
      ...result,
      ok: false,
      code: 'started-not-ready',
      ready: false,
      message: `端口已监听，但在 ${waitMs}ms 内没有等到应用层就绪标志：${error.message}`,
      logTail: recent,
      hint: '端口开了但应用层没就绪：看 logTail 里最后的报错。',
    };
  }
}

/**
 * Stop a service: control channel first, force only as a fallback.
 *
 * This is the missing step in the hand-off order — a DSH-started verification
 * instance must be shut down **before** the user takes over, or the user's own
 * double-click will fight it for the world lock.
 *
 * 优雅停止：控制通道优先，强杀只作兜底。交接前必须先关掉验证用实例。
 */
export async function serviceStop(runtime, { id, graceSeconds = 30, force = false } = {}) {
  const handle = await runtime.handleFor(id);
  refreshRconCredentials(handle);

  const before = await detectServiceState(handle, { plan: detectStartPlan(handle.root) });
  const processes = before.processes;
  if (processes.length === 0 && before.listening === false) {
    return { ok: true, id: handle.id, alreadyStopped: true, message: '该服务本来就没有在运行。' };
  }

  const steps = [];
  let rconReply = null;
  if (handle.exec?.kind === 'rcon' && handle.exec.password) {
    try {
      rconReply = await withRcon(handle.exec, connection => connection.exec('stop'));
      steps.push({ step: 'rcon-stop', ok: true, reply: String(rconReply).trim() });
    } catch (error) {
      steps.push({ step: 'rcon-stop', ok: false, error: String(error?.message ?? error) });
    }
  } else {
    steps.push({ step: 'rcon-stop', ok: false, error: '没有可用的 RCON 通道，无法优雅停止。' });
  }

  // Wait for it to leave on its own — a graceful stop saves the world.
  const deadline = Date.now() + Math.max(0, graceSeconds) * 1000;
  let alive = processes;
  while (alive.length > 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    alive = await pidsAlive(processes.map(p => p.pid));
  }
  steps.push({ step: 'graceful-wait', ok: alive.length === 0, remaining: alive.map(p => p.pid) });

  if (alive.length > 0) {
    const cleared = await clearServiceProcesses(handle, { plan: detectStartPlan(handle.root) });
    steps.push({ step: 'force-kill', ok: true, killed: cleared.killed, forced: force === true });
  }

  const after = await detectServiceState(handle, { plan: detectStartPlan(handle.root) });
  const remaining = await pidsAlive(processes.map(p => p.pid));
  return {
    id: handle.id,
    ok: remaining.length === 0 && after.listening === false,
    stoppedPids: processes.map(p => p.pid).filter(pid => !remaining.some(r => r.pid === pid)),
    remainingPids: remaining.map(p => p.pid),
    portStillListening: after.listening,
    graceful: rconReply !== null,
    steps,
    message: remaining.length === 0 && after.listening === false
      ? (rconReply === null ? '已强制停止（没有 RCON 通道，无法优雅停）。' : '已优雅停止。')
      : '仍有进程或端口仍在监听，请看 steps。',
  };
}

/**
 * Export start/stop scripts into the service directory — **the hand-off**.
 *
 * This is the compensation for the hard constraint that a DSH child process
 * does not outlive the host (measured, report v2 §2.1). DSH configures, verifies
 * once, then writes the scripts the user will run from now on, and the result
 * carries the sentence the agent must say out loud.
 *
 * Idempotent: re-exporting overwrites our own files in `_dsh/` and touches
 * nothing else in the service directory.
 *
 * 把启停脚本导出到服务目录 —— 这是"子进程活不长"的补偿方案。
 * 幂等：重复导出只覆盖 `_dsh/` 里我们自己的文件。
 */
export async function serviceExportScripts(runtime, { id, dir, proxyId, memory, bootWaitSeconds, force = false, extraFiles = [], controlWindowNotNeeded = false } = {}) {
  const handle = await runtime.handleFor(id);
  const outDir = (dir !== undefined && dir !== '')
    ? path.resolve(dir)
    : path.join(handle.root, EXPORT_DIR_NAME);

  const record = getService(id);
  const resolvedProxyId = proxyId ?? record?.tunnel?.proxyId ?? null;
  const publicAddress = record?.tunnel?.public ?? '';
  const properties = readServerProperties(handle.root) ?? {};
  const plan = detectStartPlan(handle.root);
  const frpcBinary = locateFrpc({ configured: runtime.config.frpcPath ?? '' }) ?? '';

  // ── Enforce the hand-off ORDER, because getting it wrong is what made the
  //    first export useless in the field (report v3 §2.2):
  //      create the tunnel RECORD first (it needs no frpc), then export once.
  //    Exporting before that produces scripts without an address, and the user
  //    may double-click them before the second export ever happens.
  //
  //    v4: the cross-check must be the SAME one `service_list` uses. Guarding
  //    only against `null` let a STALE record through — `service_list` correctly
  //    called that record stale while this tool baked its dead address into the
  //    scripts. One record, two contradictory answers.
  const state = await detectServiceState(handle, { plan });
  const verificationRunning = state.state === 'running' || state.state === 'starting';

  // ── The command window is a REQUIRED step, not a nice-to-have ────────────
  // Report v4 §3: with the server running outside a visible window there was no
  // place at all to type a command. That is a gap in the hand-off, so the plugin
  // refuses to finish one that does not cover it.
  //
  // The plugin deliberately does NOT ship a fixed console: the control channel
  // depends on the service and the edition (Minecraft Bedrock has no RCON), so
  // the content has to be derived for the service in front of you — the skill
  // `dsh-openfrp-handoff` carries the rules and a reference implementation. What
  // the plugin enforces is that the step HAPPENS.
  const acceptedExtras = (Array.isArray(extraFiles) ? extraFiles : [])
    .filter(file => file !== null && typeof file === 'object' && typeof file.path === 'string' && file.path !== '');
  const controlWindowFiles = acceptedExtras.filter(file => file.role === 'control-window');
  const controlChannel = handle.exec === null ? null : (handle.exec.kind ?? 'unknown');
  const controlWindowRequired = controlWindowNotNeeded !== true
    && (handle.exec !== null || handle.kind === 'minecraft-java');
  const controlWindowOk = controlWindowFiles.length > 0 || controlWindowNotNeeded === true;

  let tunnelStillExists = null;
  if (resolvedProxyId !== null) {
    try {
      const client = runtime.getClient();
      if (client.authenticated) {
        const listed = (await client.getUserProxies()).data?.list ?? [];
        tunnelStillExists = listed.some(p => Number(p.id) === Number(resolvedProxyId));
      }
    } catch {
      /* offline / not logged in: report "unknown" rather than pretending */
    }
  }

  const handoff = {
    verificationInstanceRunning: verificationRunning,
    verificationState: state.state,
    tunnelRecord: resolvedProxyId === null ? null : { proxyId: resolvedProxyId, public: publicAddress },
    tunnelStillExists,
    scriptsHaveAddress: publicAddress !== '',
    controlWindow: {
      required: controlWindowRequired,
      provided: controlWindowFiles.length > 0,
      files: controlWindowFiles.map(file => file.path),
      channel: controlChannel,
      why: controlWindowRequired
        ? '这个服务有指令通道，但服务端一旦不在前台窗口里跑（启动器起的、后台起的、前台窗口被关了），就没有地方敲指令了。'
        : '这个服务看起来不需要指令控制窗口。',
    },
    // One field that means "nothing is stopping you", so a bare `false` cannot
    // be misread as a clean bill of health (report v4, finding 3).
    readyForHandoff: !verificationRunning && resolvedProxyId !== null
      && tunnelStillExists !== false && controlWindowOk,
    // Say what was NOT checked, instead of leaving silence to be read as OK.
    notVerified: [
      ...(resolvedProxyId !== null && tunnelStillExists === null ? ['隧道记录是否仍然存在（未登录 OpenFrp，无法核对）'] : []),
      ...(resolvedProxyId === null ? ['隧道记录（还没有）'] : []),
    ],
  };

  if (force !== true) {
    if (verificationRunning) {
      return {
        ok: false,
        code: 'verification-instance-running',
        blocking: true,
        id: handle.id,
        handoff,
        message: `验证用的实例还在运行（${state.state}：${state.evidence}）。`
          + '先把验证实例关掉再导出，否则用户双击启动脚本时会和它抢世界锁。',
        mustDoFirst: '先调用 service_stop 关掉验证实例，然后再导出。',
        forceHint: '确实要先导出（例如只是想预览文件）时，传 force=true 跳过这个检查。',
      };
    }
    if (resolvedProxyId === null) {
      return {
        ok: false,
        code: 'no-tunnel-record',
        blocking: true,
        id: handle.id,
        handoff,
        message: '这个服务还没有绑定隧道记录，导出的脚本里不会有公网地址 —— 用户双击后拿不到可连的地址。',
        mustDoFirst: '先 openfrp_tunnel 的 create 建一条隧道记录（只写 OpenFrp 服务端记录，不启动 frpc、不占进程），然后再导出；这样只需要导出一次。',
        forceHint: '确实要先导出时传 force=true；脚本会打印"本次导出时隧道还没拿到公网地址"。',
      };
    }
    if (tunnelStillExists === false) {
      return {
        ok: false,
        code: 'tunnel-record-stale',
        blocking: true,
        id: handle.id,
        handoff,
        message: `记录里的隧道 ${resolvedProxyId} 在 OpenFrp 上已经不存在了（可能被删了）。`
          + `照这样导出，脚本会把一个失效地址（${publicAddress === '' ? '无' : publicAddress}）烧进去，用户双击后连不上。`,
        mustDoFirst: '先 openfrp_tunnel 的 create 建一条新隧道，再 openfrp_expose up 让它把新记录写回来，然后再导出；'
          + '或者直接用 proxy_id 传一条确认还存在的隧道。',
        forceHint: '确实要先导出时传 force=true。',
      };
    }
  }

  // ── Deliberately OUTSIDE the `force` gate ────────────────────────────────
  // `force` means "the ORDER is wrong but I want the files anyway". A missing
  // command window is not an ordering problem — it is an incomplete hand-off,
  // and the user only discovers it when the server is running somewhere they
  // cannot type into. So it is not bypassable by `force`; the explicit escape
  // hatch is `control_window_not_needed`, which states a fact rather than
  // waiving a requirement.
  if (controlWindowRequired && controlWindowFiles.length === 0) {
    return {
      ok: false,
      code: 'control-window-missing',
      blocking: true,
      id: handle.id,
      handoff,
      message: `这个服务有指令通道（${controlChannel ?? '未知'}），但本次导出没有带上**指令控制窗口**的文件。`
        + '服务端一旦不在前台窗口里跑（用启动器起的、后台起的、前台窗口被关了），用户就没有任何地方能敲指令 —— '
        + '而"给自己 OP"这一步也只能靠它完成。这一步不能省。'
        + '（注意：force 不能跳过这一条 —— 它管的是顺序，不是"交接是否完整"。）',
      mustDoFirst: '**现在为这个服务生成一个指令控制窗口**，然后连同其它生成物一起用 extra_files 传进来，'
        + '其中那个控制窗口的条目要带 role="control-window"。',
      howToGenerate: [
        '先读技能 dsh-openfrp-handoff（~/.dsh/skills/dsh-openfrp-handoff/SKILL.md），里面有"规则 6：交接必须包含一个指令控制窗口"，并附一份可改造的 RCON 参考实现。',
        '按**你手上这个服务**的控制通道来生成，不要照抄：Minecraft Java 用 RCON；**基岩版没有 RCON，必须换通道**（stdin / 第三方桥接）；非 MC 服务用它自己的 HTTP shutdown / 信号 / 管理接口。',
        '生成的脚本必须：端口与密码**运行时从配置文件读**（不硬编码）、`.bat` 在 `chcp` 之后**不得出现非 ASCII**、'
          + '用管道喂指令时**登录完成前到达的指令要排队后补发**（否则自动化场景会静默吞掉全部指令）。',
        '传参形状：extra_files: [{ path: "控制台.bat", content: "...", role: "control-window" }, { path: "rcon-console.cjs", content: "..." }]',
        '换服务端版本或端（例如换基岩版）时要**重新生成**，不要沿用上一份。',
      ],
      ifTrulyNotNeeded: '如果这个服务确实没有需要暴露给用户的指令通道（例如纯 HTTP 服务），传 control_window_not_needed=true 说明这个事实。',
    };
  }

  const files = buildExportFiles({
    root: handle.root,
    port: String(handle.localPort ?? ''),
    rconPort: String(properties['rcon.port'] ?? 25575),
    proxyId: resolvedProxyId,
    publicAddress,
    frpcPath: frpcBinary,
    startPlanKind: plan.ok === true ? plan.kind : 'java-jar',
    existingStartScript: plan.ok === true && plan.kind === 'script' ? path.basename(plan.script) : '',
    javaPath: findJava(),
    memory: memory ?? '2G',
    bootWaitSeconds: bootWaitSeconds ?? 180,
    // Files DSH generated for THIS service — the plugin does not author the
    // command window, it only insists that one exists.
    extraFiles: acceptedExtras,
  });

  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const file of files) {
    const target = path.join(outDir, file.path);
    // PowerShell 5.1 reads UTF-8 without a BOM as ANSI — Chinese comments turn
    // into mojibake and can even break parsing. .bat must NOT have one (cmd
    // would print it), which is why those files are ASCII-only.
    //
    // Files DSH generated are the exception: they are written byte-for-byte. The
    // BOM rule exists for OUR PowerShell templates; content authored for a
    // specific service already carries whatever encoding it needs, and silently
    // rewriting it would be exactly the "plugin knows better" move we avoid.
    const isBatch = file.path.toLowerCase().endsWith('.bat');
    const verbatim = file.generated === true;
    const text = (isBatch || verbatim) ? file.content : `\uFEFF${file.content}`;
    fs.writeFileSync(target, text, 'utf8');
    written.push({
      file: file.path,
      purpose: file.note,
      bytes: Buffer.byteLength(text, 'utf8'),
      bom: !isBatch && !verbatim,
      ...(verbatim ? { generatedBy: 'dsh' } : {}),
    });
  }

  if (typeof properties['rcon.password'] === 'string' && properties['rcon.password'] !== '') {
    const passwordFile = path.join(outDir, 'rcon-password.txt');
    fs.writeFileSync(passwordFile, properties['rcon.password'], 'utf8');
    written.push({ file: 'rcon-password.txt', purpose: 'RCON 密码（明文，仅供本地脚本使用；不要提交到版本库）', bytes: Buffer.byteLength(properties['rcon.password'], 'utf8'), bom: false });
  }

  upsertService({ id: handle.id, exportedScripts: { dir: outDir, at: new Date().toISOString(), proxyId: resolvedProxyId } });

  return {
    ok: true,
    id: handle.id,
    directory: outDir,
    files: written,
    startPlan: plan.ok === true
      ? { kind: plan.kind, evidence: plan.evidence, ...(plan.caveat === undefined ? {} : { caveat: plan.caveat }) }
      : { kind: 'unknown', evidence: plan.reason },
    localPort: handle.localPort,
    rcon: handle.exec === null ? null : `${handle.exec.host}:${handle.exec.port}`,
    tunnel: resolvedProxyId === null ? null : { proxyId: resolvedProxyId, public: publicAddress },
    handoff,
    // ── The sentence the agent MUST relay. Do not bury this. ──
    tellUser: userInstruction({
      dir: outDir,
      startFile: '启动.bat',
      stopFile: '停止.bat',
      consoleFiles: controlWindowFiles.map(file => file.path),
      publicAddress,
    }),
    agentMustSay: `必须明确告诉用户：（1）以后要开服就双击 ${outDir}\\启动.bat、关服双击 停止.bat；`
      + (controlWindowFiles.length > 0
        ? `（2）**要敲指令就双击 ${outDir}\\${controlWindowFiles[0].path}**（服务端不在前台窗口里跑时，这是唯一能敲指令的地方）；`
        : '（2）要敲指令可以跟 DSH 说，DSH 用 service_exec 代发；')
      + '（3）请他双击打开一次并回你一句"已打开"。不要只写进结果里，要真的说出来。',
    // The order matters, and it is not obvious. Say it explicitly.
    handoffOrder: [
      '① 配好服务（EULA/配置/端口/RCON）',
      '② **为这个服务生成指令控制窗口**（服务端不在前台窗口里跑时，用户唯一能敲指令的地方；也靠它给自己 OP）',
      '③ DSH 起一次临时实例做验证',
      '④ openfrp_tunnel create —— 只拿公网地址，不起 frpc、不占进程',
      '⑤ service_export_scripts —— 把控制窗口一并传进来，此时地址也在手上，导出这一次就是完整的',
      '⑥ service_stop —— 关掉验证用实例（必须在用户接手之前）',
      '⑦ 明确告知用户：以后双击哪个开、哪个关、哪个敲指令',
      '⑧ 用户亲手打开并回报"已打开"',
      '⑨ openfrp_expose up（起 frpc）→ 公网端到端验证 → 交付地址',
    ],
    // The scripts are ONE INSTANCE of the rules, not the rules. Say so, and say
    // which three things to re-derive when the server version/edition/service
    // changes — otherwise the next change leaves everyone stuck.
    methodology: {
      skill: 'dsh-openfrp-handoff',
      where: '~/.dsh/skills/dsh-openfrp-handoff/SKILL.md',
      howToRead: '这些脚本只是"五条通用规则"的一个具体实例。换服务端版本、换端（例如基岩版没有 RCON）、换服务时，不要照抄脚本，按技能里的规则重新实例化。',
      reInstantiateThese: [
        `① 识别特征：现在是 ${plan.ok === true && plan.kind === 'java-jar' ? '按 jar 名匹配命令行' : '按启动脚本名匹配命令行'} —— 换服务要换成新服务的命令行特征`,
        `② 就绪判据：现在等日志里的 Minecraft 就绪行 —— 日志措辞随版本/语言变，优先换成"对服务做一次真实的最小请求"`,
        '③ 启动命令：见上面 startPlan —— Fabric/Forge 整合包必须用它们自己的启动器，不能 java -jar',
      ],
      unchangedWhenAdapting: ['四态判定与启动中等待', '可变状态锁的规避思路', '进程识别顺序', '优雅停止顺序', '参数集中与错误提示'],
    },
    lifecycle: {
      ownedBy: 'user',
      why: 'DSH 启动的进程会随 DSH 结束；由用户双击启动的服务器不受影响。',
      dshStillCan: ['service_logs 读日志', 'service_exec 发命令（RCON）', 'service_status 探活', 'openfrp_diagnose 诊断'],
    },
    notes: [
      publicAddress === ''
        ? '这次导出时该服务还没有绑定隧道，启动脚本里没有公网地址。先用 openfrp_expose 把隧道开起来，再重新导出一次即可。'
        : '公网地址已写进脚本，重启 DSH 也不会变。',
      '脚本可重复导出覆盖；它们只动 `_dsh/` 目录，不会碰服务端本身的文件。',
      // The command window is part of the hand-off (report v4 §3.4). Note what
      // was supplied rather than what the plugin "usually" writes — the plugin
      // has no fixed console to point at.
      controlWindowFiles.length > 0
        ? `指令控制窗口由本次生成：${controlWindowFiles.map(f => `${outDir}\\${f.path}`).join('、')}。`
          + '服务端不在前台窗口里跑时，这是唯一能敲指令的地方。'
        : (controlWindowNotNeeded === true
          ? '本次声明该服务不需要指令控制窗口。'
          : '⚠️ 本次没有带指令控制窗口（已用 force 跳过检查）。'),
      '⚠️ **进游戏后要能用 `/` 指令，必须先给自己 OP**：在指令控制窗口里输入 `op <你的游戏ID>`。'
        + '默认 ops.json 是空的，谁进来都只能用普通玩家的功能。',
    ],
  };
}

/**
 * Read the log: recent history, plus optionally a short live observation.
 *
 * The `followApplied` field exists because of a real misdiagnosis (report v4
 * §2.5). The tool used to always return "an idle server writes no logs", which
 * is good advice when following works — but when following was *broken* (the
 * `follow_ms` parameter never reached this function) that same sentence turned
 * our own bug into an apparent property of the server, and the reader concluded
 * "the server is idle" with no error anywhere. A reassuring note that happens to
 * cover up a silent failure is the worst combination.
 *
 * So the two cases are now distinguishable: `followMs > 0` and zero new lines
 * means we really did watch and nothing was written; `followApplied: false`
 * means the follow was not requested at all.
 */
export async function serviceLogs(runtime, { id, lines = 60, followMs = 0 } = {}) {
  const handle = await runtime.handleFor(id);
  if (handle.logs === null) throw new Error(`服务「${id}」没有可读的日志文件。`);
  const history = readTailLines(handle.logs.path, lines);
  const followApplied = Number(followMs) > 0;
  const watchedMs = followApplied ? Number(followMs) : 0;
  const live = followApplied ? await collectLines(handle.logs.path, { durationMs: watchedMs }) : [];

  const note = followApplied
    ? (live.length === 0
      ? `已跟读 ${watchedMs}ms，这期间日志**零新增**。（空闲服务端不写日志 —— 日志不动不代表服务端死了。）`
      : `已跟读 ${watchedMs}ms，捕获 ${live.length} 行新增。`)
    : '没有请求跟读（follow_ms 未给或为 0），只返回了历史尾部。';

  return {
    id,
    logFile: handle.logs.path,
    logExists: handle.logs.exists !== false && fs.existsSync(handle.logs.path),
    history,
    live,
    // Explicit, so an empty `live` can never again be read as "the server is idle"
    // when the truth is "we never watched".
    followApplied,
    watchedMs,
    followMsReceived: followMs,
    note,
  };
}

/** Send a command through the service's command channel and return its own words. */
export async function serviceExec(runtime, { id, command }) {
  const handle = await runtime.handleFor(id);
  if (handle.exec === null || handle.exec.kind !== 'rcon') {
    throw new Error(`服务「${id}」没有命令通道。Minecraft 需要先在 server.properties 里设 enable-rcon=true 和 rcon.password。`);
  }
  // Re-read server.properties first: if the user changed rcon.password while
  // the server was down, the attached handle still holds the old one and every
  // command would fail with auth-failed.
  await refreshRconCredentials(handle);
  const commands = Array.isArray(command) ? command : [command];
  const replies = await withRcon(
    { host: handle.exec.host, port: handle.exec.port, password: handle.exec.password },
    async connection => {
      const out = [];
      for (const one of commands) out.push({ command: one, reply: await connection.exec(one) });
      return out;
    },
  );
  const emptyReplies = replies.filter(r => r.reply.trim() === '').map(r => r.command);
  return {
    id,
    replies,
    // RCON only carries a command's *synchronous* output. Commands that answer
    // later (or asynchronously) legitimately return an empty string — measured:
    // `list` and `seed` answer inline, `spark tps` does not. An empty reply is
    // NOT a failure; look in the log for the rest.
    ...(emptyReplies.length === 0 ? {} : {
      note: `这些命令没有同步回复：${emptyReplies.join('、')}。RCON 只带同步输出，异步命令（如 spark 系列）会把结果写进服务端日志 —— 用 service_logs 去读，不要当成失败。`,
    }),
  };
}

/**
 * The whole point: bring a service up on the public internet and hand back the
 * address, without the human touching a panel.
 *
 * 核心动作：把本地服务暴露到公网并返回地址，全程不需要人碰面板。
 */
export async function exposeUp(runtime, { id, proxyId, mode = 'tcp', autoCreate = false, fields, nodeId = null, waitMs = 90_000 } = {}) {
  const client = runtime.requireAuth();
  const handle = await runtime.handleFor(id);
  if (handle.localPort === null || handle.localPort === undefined) {
    throw new Error(`服务「${id}」的本地端口未知：日志里没有绑定记录，也读不到 server.properties。请显式提供端口。`);
  }

  // Decide which tunnel to use.
  let targetProxyId = proxyId ?? null;
  let proxy = null;
  let createdNodeReason = '';
  const listed = (await client.getUserProxies()).data?.list ?? [];

  if (targetProxyId === null) {
    proxy = listed.find(p => Number(p.localPort) === Number(handle.localPort) && p.status !== false) ?? null;
    if (proxy !== null) targetProxyId = proxy.id;
  } else {
    proxy = listed.find(p => Number(p.id) === Number(targetProxyId)) ?? null;
  }

  if (targetProxyId === null) {
    if (autoCreate !== true) {
      return {
        ok: false,
        code: 'no-tunnel',
        message: `没有找到指向本地端口 ${handle.localPort} 的隧道。`,
        suggestion: '用 openfrp_tunnel 的 create 动作新建一条（先用 nodes 动作挑一个支持该协议的节点），或显式指定 proxyId。',
        available: listed.map(p => ({ id: p.id, name: p.proxyName, local: `${p.localIp}:${p.localPort}`, type: p.proxyType, online: p.online === true })),
      };
    }
    const created = await createTunnelFor(runtime, { handle, mode, fields, nodeId });
    targetProxyId = created.proxyId;
    proxy = created.proxy;
    createdNodeReason = created.nodeReason ?? '';
  }

  // The iron rule: never start a tunnel that is already online somewhere else.
  if (proxy === null) proxy = listed.find(p => Number(p.id) === Number(targetProxyId)) ?? null;
  if (proxy !== null && proxy.online === true) {
    const ours = runtime.instances.get(targetProxyId);
    const oursRunning = ours?.running === true;
    return {
      ok: false,
      code: 'already-online',
      message: oursRunning
        ? `隧道「${proxy.proxyName}」已经由本插件运行中（frpc pid=${String(ours.pid)}）。要重开请先执行 openfrp_expose 的 down 动作。`
        : `隧道「${proxy.proxyName}」已被插件之外的进程占用（通常是官方启动器，也可能是别处残留的 frpc）。`
          + '插件不会重复开启它，以免撞上 proxy conflict。',
      occupiedBy: oursRunning ? 'plugin' : 'external-or-unknown',
      public: publicAddressOf(proxy),
      suggestion: oursRunning
        ? '先 openfrp_expose action=down 停掉插件自己那个，再 up。'
        : '在别处关掉它，或新建一条专供插件使用的隧道。',
    };
  }

  if (runtime.instances.has(targetProxyId)) {
    const running = runtime.instances.get(targetProxyId);
    if (running.running) {
      return { ok: true, alreadyRunning: true, public: running.publicAddress, message: '该隧道已经由插件运行中。' };
    }
  }

  // Locate frpc (reuse the user's copy when there is one).
  const credentials = loadCredentials();
  const token = credentials.token ?? '';
  if (token === '') throw new Error('缺少 32 位用户 token（frpc 的 -u 需要它）。请先执行 openfrp_account 的 status 动作以获取。');
  const located = await ensureFrpc({ binary: runtime.config.frpcPath ?? '', fetchImpl: runtime.fetchImpl });

  const instance = new FrpcInstance({
    binary: located.binary,
    token,
    proxyIds: [targetProxyId],
    onLine: line => runtime.log('info', `frpc: ${line}`),
  });
  runtime.instances.set(targetProxyId, instance);
  runtime.tunnels.set(targetProxyId, { localPort: handle.localPort, errors: instance.errors, address: '' });
  instance.start();

  let ready;
  try {
    ready = await instance.waitReady(waitMs);
  } catch (error) {
    // We started this frpc; if it never reported ready, do not leave it behind.
    // A leaked process makes the next `up` see the tunnel as "already online"
    // and the message would blame the official launcher for our own leftover.
    const recent = instance.recentLines(20);
    await instance.stop().catch(() => {});
    runtime.instances.delete(targetProxyId);
    return {
      ok: false,
      code: 'not-ready',
      message: error?.message ?? String(error),
      proxyId: targetProxyId,
      proxyName: proxy?.proxyName ?? '',
      localPort: handle.localPort,
      frpcLog: recent,
      note: '插件已回收它自己启动的 frpc（避免残留进程把隧道占住）。'
        + '若这条隧道随后仍显示在线，说明占用者在别处；若 frpcLog 里出现 127.0.0.1:0，说明隧道记录的本地端口是坏的。',
    };
  }
  runtime.tunnels.get(targetProxyId).address = ready.address;

  upsertService({
    id: handle.id,
    tunnel: {
      provider: 'openfrp',
      proxyId: targetProxyId,
      proxyName: proxy?.proxyName ?? fields?.name ?? '',
      public: ready.address,
      frpcPid: instance.pid,
      ownedBy: 'plugin',
    },
    state: 'running',
  });

  return {
    ok: true,
    public: ready.address,
    proxyId: targetProxyId,
    proxyName: proxy?.proxyName ?? '',
    node: proxy?.friendlyNode ?? '',
    // Say WHY this node, not just which one — the report asked for the reason and
    // for an override; both are here.
    nodeReason: createdNodeReason !== ''
      ? createdNodeReason
      : explainNodeChoice({ name: proxy?.friendlyNode, classify: proxy?.classify, bandwidth: proxy?.bandwidth, allowPort: proxy?.allowPort }, { protocol: mode }),
    nodeOverrideHint: '想换节点：用 openfrp_tunnel 的 nodes 挑一个，再 openfrp_expose 带 node_id（配合 auto_create）。',
    localPort: handle.localPort,
    frpcPid: instance.pid,
    frpcVersion: located.version,
    evidence: ready.line,
    howToConnect: `把 ${ready.address} 填进游戏的「多人游戏 → 添加服务器」。`,
  };
}

async function createTunnelFor(runtime, { handle, mode, fields, nodeId = null }) {
  const client = runtime.requireAuth();
  const account = (await accountStatus(runtime)).account;
  const { data } = await client.getNodeList();
  // Use the account's REAL verification state and machine group key. Passing
  // `realname: false` here excluded every mainland node (they all carry
  // needRealname) even for verified accounts — a real bug reported from the field.
  const realnameVerified = account?.realname === true;
  const { ranked, rejected } = rankNodes(data?.list ?? [], {
    protocol: mode,
    realname: realnameVerified,
    userGroup: account?.group,
    preferDomestic: realnameVerified,
  });
  if (ranked.length === 0) {
    throw new Error(
      `没有可用于 ${mode} 协议的节点。账号用户组 ${account?.group ?? '未知'}，实名认证 ${realnameVerified ? '已完成' : '未完成'}。`
      + `被排除的原因：${rejected.slice(0, 5).map(r => `${r.name}(${r.reasons.join('、')})`).join('；')}`,
    );
  }

  // An explicit node_id always wins — the report asked for an override.
  let node = ranked[0];
  let nodeReason = explainNodeChoice(node, { preferDomestic: realnameVerified, protocol: mode }) + '（自动挑选）';
  if (nodeId !== undefined && nodeId !== null) {
    const forced = ranked.find(n => Number(n.id) === Number(nodeId));
    if (forced === undefined) {
      throw new Error(
        `指定的节点 ${nodeId} 不在可用列表里。可用节点：${ranked.slice(0, 8).map(n => `${n.name}(${n.id})`).join('、')}`,
      );
    }
    node = forced;
    nodeReason = `${explainNodeChoice(node, { protocol: mode })}（调用方指定 node_id=${nodeId}）`;
  }

  const created = await createAndVerify(runtime, client, {
    name: tunnelNameFor(fields?.name ?? handle.id),
    type: mode,
    local_addr: '127.0.0.1',
    local_port: handle.localPort,
    node_id: node.id,
    ...(fields?.remote_port === undefined ? {} : { remote_port: fields.remote_port }),
  }, { allowPort: node.allowPort ?? null });
  if (created.ok !== true) {
    throw new Error(`自动创建隧道失败：${created.message ?? '未知原因'} ${JSON.stringify(created.attempts ?? created.suggestedRemotePorts ?? [])}`);
  }
  runtime.log('info', `已创建隧道 ${created.verified.proxyName} (id=${created.verified.id})，${nodeReason}；用户组 ${account?.group ?? '未知'}`);
  return { proxyId: created.verified.id, proxy: created.verified, node, nodeReason };
}

/** Stop the tunnel we own. Never touches a tunnel we did not start. */
export async function exposeDown(runtime, { id, proxyId } = {}) {
  let targetProxyId = proxyId ?? null;
  let handle = null;
  if (targetProxyId === null && id !== undefined) {
    handle = await runtime.handleFor(id);
    const record = getService(id);
    targetProxyId = record?.tunnel?.proxyId ?? null;
    if (targetProxyId === null) {
      const candidates = [...runtime.instances.keys()].filter(pid => {
        const t = runtime.tunnels.get(pid);
        return t !== undefined && Number(t.localPort) === Number(handle.localPort);
      });
      targetProxyId = candidates[0] ?? null;
    }
  }
  if (targetProxyId === null) return { ok: false, code: 'nothing-to-stop', message: '没有找到由插件运行的隧道。' };

  const instance = runtime.instances.get(targetProxyId);
  if (instance === undefined) {
    return { ok: false, code: 'not-ours', message: `隧道 ${targetProxyId} 不是由插件启动的，插件不会去关别人的隧道。` };
  }
  await instance.stop();
  runtime.instances.delete(targetProxyId);
  if (id !== undefined) upsertService({ id, state: 'stopped', tunnel: { ...(getService(id)?.tunnel ?? {}), frpcPid: null } });
  return { ok: true, proxyId: targetProxyId, message: '插件自己启动的 frpc 已停止。' };
}

/** Correlate everything we know into evidence-backed findings. */
export async function diagnose(runtime, { id } = {}) {
  const handle = await runtime.handleFor(id);
  const status = await probeService(handle);
  const record = getService(id);
  const proxyId = record?.tunnel?.proxyId;
  const instance = proxyId === undefined ? null : runtime.instances.get(proxyId);
  let proxy = null;
  try {
    const listed = (await runtime.getClient().getUserProxies()).data?.list ?? [];
    proxy = listed.find(p => Number(p.id) === Number(proxyId)) ?? null;
  } catch {
    /* not logged in — diagnosis still works locally */
  }

  const tunnel = instance === undefined || instance === null
    ? null
    : { localPort: runtime.tunnels.get(proxyId)?.localPort, errors: instance.errors, address: instance.publicAddress, running: instance.running };

  const { findings } = diagnoseFromObservations({ status, handle, tunnel });
  if (proxy !== null && proxy.online !== true) {
    findings.push({
      code: 'tunnel-offline',
      severity: 'high',
      problem: 'OpenFrp 服务端认为这条隧道不在线',
      evidence: `proxy ${proxy.proxyName}(id=${proxy.id}) online=${proxy.online} status=${proxy.status}`,
      fix: '检查 frpc 是否在运行；若在运行，看它的日志（openfrp 的 expose 动作会保留最近日志）。',
    });
  }
  return { id, findings, status, tunnel: proxy === null ? null : { id: proxy.id, name: proxy.proxyName, online: proxy.online, public: publicAddressOf(proxy), cname: cnameTargetOf(proxy) } };
}

// ─────────────────────────────────────────────────────────────
// Misc
// ─────────────────────────────────────────────────────────────

/** Environment facts worth showing the agent once. */
export async function environmentInfo(runtime) {
  const located = locateFrpc({ configured: runtime.config.frpcPath ?? '' });
  const info = located === null ? { found: false } : { found: true, path: located, ...(await readFrpcVersion(located)) };
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    frpc: info,
    frpcCacheDir: frpcCacheDir(),
    freePortExample: await findFreePort(),
  };
}

export { OpenFrpError };
