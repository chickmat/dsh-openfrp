/**
 * dsh-openfrp — OpenFrp REST client.
 *
 * Design notes that came out of reading the official sources (see
 * docs/调研与技术方案.md §4–§5):
 *
 *  1. Every response carries `{ flag, msg, data }`; `flag === false` is a
 *     failure and `msg` is the human-readable reason. We surface `msg` verbatim
 *     rather than inventing our own wording — the user needs OpenFrp's words.
 *  2. Every response *may* carry a rotated `Authorization` header. If we do not
 *     persist it, the session silently dies hours later (this is the official
 *     cross-platform launcher's outstanding bug #5). So rotation is a
 *     first-class callback here, not an afterthought.
 *  3. The app must send its own User-Agent (terms requirement).
 *
 * @module dsh-openfrp/openfrp-client
 */

import { OF_API, EP, USER_AGENT, tokenTunnelListUrl } from './protocol.js';

/** Error carrying the upstream detail, so diagnosis can quote real evidence. */
export class OpenFrpError extends Error {
  constructor(message, { status, code, body, endpoint } = {}) {
    super(message);
    this.name = 'OpenFrpError';
    this.status = status ?? 0;
    this.code = code ?? 'unknown';
    this.body = body;
    this.endpoint = endpoint;
  }
}

function preview(value, max = 400) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export class OpenFrpClient {
  /**
   * @param {object} options
   * @param {string} [options.authorization] Authorization token (may be empty for public calls).
   * @param {string} [options.base] API base.
   * @param {(authorization: string) => void} [options.onAuthorizationRotated] Called when the server hands back a new token.
   * @param {typeof fetch} [options.fetchImpl]
   */
  constructor({ authorization = '', base = OF_API, onAuthorizationRotated, fetchImpl } = {}) {
    this.authorization = authorization;
    this.base = base;
    this.onAuthorizationRotated = onAuthorizationRotated;
    this.fetch = fetchImpl ?? globalThis.fetch;
  }

  get authenticated() {
    return typeof this.authorization === 'string' && this.authorization !== '';
  }

  /**
   * One API call. Never throws for `flag:false` — callers get the parsed
   * envelope so they can decide; transport/HTTP failures do throw.
   *
   * 发一次请求。业务失败不抛异常（返回信封），传输/HTTP 层失败才抛。
   *
   * @returns {Promise<{flag:boolean,msg:string,data:any,raw:any}>}
   */
  async call(pathname, { method = 'POST', body = {}, absolute = null } = {}) {
    const url = absolute ?? `${this.base}${pathname}`;
    /** @type {Record<string,string>} */
    const headers = {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    };
    if (this.authenticated) headers.Authorization = this.authorization;
    const init = { method, headers, signal: AbortSignal.timeout(30_000) };
    if (method !== 'GET' && body !== null) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await this.fetch(url, init);
    } catch (error) {
      throw new OpenFrpError(
        `请求 OpenFrp 失败（网络层）：${error?.message ?? error}`,
        { code: 'network', endpoint: pathname },
      );
    }

    // Authorization rotation: adopt it immediately.
    const rotated = response.headers.get('authorization');
    if (rotated && rotated !== this.authorization) {
      this.authorization = rotated;
      this.onAuthorizationRotated?.(rotated);
    }

    const text = await response.text();

    if (response.status === 429) {
      throw new OpenFrpError('OpenFrp 限流（HTTP 429）：请求过于频繁，请稍后再试。', {
        status: 429, code: 'rate-limited', body: text, endpoint: pathname,
      });
    }

    let parsed;
    try {
      parsed = text === '' ? {} : JSON.parse(text);
    } catch {
      throw new OpenFrpError(
        `OpenFrp 返回了非 JSON 内容（HTTP ${response.status}）：${preview(text)}`,
        { status: response.status, code: 'bad-json', body: text, endpoint: pathname },
      );
    }

    if (!response.ok) {
      throw new OpenFrpError(
        `OpenFrp HTTP ${response.status}：${preview(parsed?.msg ?? text)}`,
        { status: response.status, code: 'http-error', body: parsed, endpoint: pathname },
      );
    }

    return {
      flag: parsed?.flag === true || parsed?.success === true || parsed?.code === 200,
      msg: String(parsed?.msg ?? parsed?.message ?? ''),
      data: parsed?.data ?? null,
      raw: parsed,
    };
  }

  /**
   * Like `call`, but converts `flag:false` into a thrown, *quoted* error.
   * The message always contains OpenFrp's own words.
   *
   * 与 call 相同，但把业务失败转成异常，且异常里保留 OpenFrp 原文。
   */
  async callOrThrow(pathname, options) {
    const result = await this.call(pathname, options);
    if (!result.flag) {
      throw new OpenFrpError(
        `OpenFrp 拒绝了请求（${pathname}）：${result.msg || '未提供原因'}`,
        { code: 'api-rejected', body: result.raw, endpoint: pathname },
      );
    }
    return result;
  }

  // ── High-level endpoints ──────────────────────────────────

  /** Account info. Also the cheapest way to test whether a token is still valid. */
  getUserInfo() {
    return this.callOrThrow(EP.getUserInfo, { body: {} });
  }

  /** All tunnels of the account, with `online` / `status` / `connectAddress`. */
  getUserProxies() {
    return this.callOrThrow(EP.getUserProxies, { body: {} });
  }

  /** All nodes, with protocol support, load and user-group gating. */
  getNodeList() {
    return this.callOrThrow(EP.getNodeList, { body: {} });
  }

  getNodeConf(nodeId) {
    return this.callOrThrow(EP.getNodeConf, { body: { node_id: nodeId } });
  }

  newProxy(fields) {
    return this.callOrThrow(EP.newProxy, { body: fields });
  }

  editProxy(fields) {
    return this.callOrThrow(EP.editProxy, { body: fields });
  }

  removeProxy(proxyId) {
    return this.callOrThrow(EP.removeProxy, { body: { proxy_id: proxyId } });
  }

  /** Server-side enable/disable of a tunnel record (NOT the local frpc process). */
  changeProxy(proxyId, enabled) {
    return this.callOrThrow(EP.changeProxy, { body: { proxy_id: proxyId, proxy_do: enabled === true } });
  }

  refreshProxyStatus(proxyId) {
    return this.callOrThrow(EP.refreshProxyStatus, { body: { proxy_id: proxyId } });
  }

  /** frpc release manifest: `{ latest, latest_full, latest_ver, source[] }`. */
  getSoftware() {
    return this.callOrThrow(EP.software, { method: 'GET', body: null });
  }
}

/**
 * The token-only, login-free tunnel list. Deliberately a standalone function:
 * it needs no Authorization and returns a different shape, and it is the
 * cheapest way for the agent to answer "what are my tunnels and their public
 * addresses".
 *
 * 仅需 32 位 token、无需登录的只读隧道列表。
 */
export async function listTunnelsByToken(token, { base = OF_API, fetchImpl } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const response = await doFetch(tokenTunnelListUrl(token, base), {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new OpenFrpError(`token 隧道列表返回了非 JSON：${preview(text)}`, { status: response.status, code: 'bad-json' });
  }
  if (parsed?.success !== true) {
    throw new OpenFrpError(`token 隧道列表查询失败：${parsed?.message ?? preview(text)}`, { code: 'api-rejected', body: parsed });
  }
  return parsed;
}

// ─────────────────────────────────────────────────────────────
// Pure helpers used by tools (exported for tests)
// ─────────────────────────────────────────────────────────────

/**
 * The public address of a tunnel, as a human would type it into Minecraft.
 * Mirrors the official launcher's rule: append `remotePort` only when the
 * connect address has none of its own.
 *
 * 隧道的公网地址（照官方启动器的规则补端口）。
 */
export function publicAddressOf(proxy, { connectAddress, domain, remotePort, proxyType } = {}) {
  const host = connectAddress ?? proxy?.connectAddress ?? '';
  const port = remotePort ?? proxy?.remotePort;
  const type = String(proxyType ?? proxy?.proxyType ?? '').toLowerCase();
  if (host === '') return '';
  if (host.includes(':')) return host;
  if (port === undefined || port === null || port === 0) return host;
  // HTTP(S) tunnels are addressed by domain, not host:port.
  if (type === 'http' || type === 'https') return host;
  return `${host}:${port}`;
}

/**
 * The CNAME target a user is supposed to point their own domain at — the exact
 * thing the human in the story could not find in the panel.
 *
 * 用户在自己域名商那里要填的 CNAME 目标 —— 正是"我不知道上哪找 cname"的那个值。
 */
export function cnameTargetOf(proxy) {
  return proxy?.nodeHostname ?? proxy?.hostname ?? '';
}

/**
 * Pick the best node for a request, with the reasons attached.
 * Filters out things that would make the tunnel fail, then ranks what is left.
 *
 * Ranking rule (field report v3 §3): when the account is real-name verified,
 * **prefer the closest region first, bandwidth second**. Sorting by bandwidth
 * alone picked an overseas node for a Chinese user who could legally use the
 * mainland ones — the faster-looking number was the worse answer.
 *
 * 挑节点并给出理由。实名用户**先按区域近、再按带宽**排 —— 只按带宽排会给国内用户挑到境外节点。
 */
export function rankNodes(nodes, { protocol, userGroup, realname = false, classify, preferDomestic = false } = {}) {
  const wanted = protocol ? String(protocol).toLowerCase() : null;
  const group = userGroup ? String(userGroup) : null;
  const ranked = [];
  const rejected = [];

  for (const node of nodes ?? []) {
    const reasons = [];
    if (wanted !== null && node?.protocolSupport && node.protocolSupport[wanted] !== true) {
      reasons.push(`不支持 ${wanted} 协议`);
    }
    if (node?.fullyLoaded === true) reasons.push('节点已满载');
    if (node?.status !== undefined && node.status !== 200) reasons.push(`节点状态异常（${node.status}）`);
    if (group !== null && typeof node?.group === 'string' && node.group !== '' && !node.group.split(/[;,]/).includes(group)) {
      reasons.push(`用户组 ${group} 无权使用`);
    }
    if (realname === false && node?.needRealname === true) reasons.push('需要实名认证');
    if (classify !== undefined && node?.classify !== classify) reasons.push('区域不符');

    if (reasons.length > 0) {
      rejected.push({ id: node?.id, name: node?.name, reasons });
      continue;
    }
    ranked.push({
      id: node?.id,
      name: node?.name,
      classify: node?.classify,
      bandwidth: node?.bandwidth,
      allowPort: node?.allowPort ?? null,
      reasons: [],
    });
  }

  const byClassify = (a, b) => (a.classify ?? 9) - (b.classify ?? 9);
  const byBandwidth = (a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0);
  const byId = (a, b) => (a.id ?? 0) - (b.id ?? 0);

  if (preferDomestic) {
    // 1 = 中国大陆, 2 = 港澳台, 3 = 海外. Region first, then bandwidth.
    ranked.sort((a, b) => byClassify(a, b) || byBandwidth(a, b) || byId(a, b));
  } else {
    ranked.sort((a, b) => byBandwidth(a, b) || byClassify(a, b) || byId(a, b));
  }

  return { ranked, rejected };
}

/** A one-line explanation of why a node was chosen — the report asked for the reason, not just the pick. */
export function explainNodeChoice(node, { preferDomestic = false, protocol = '' } = {}) {
  if (node === undefined || node === null) return '';
  const region = { 1: '中国大陆', 2: '港澳台', 3: '海外' }[node.classify] ?? `区域 ${node.classify}`;
  const parts = [`${node.name}（${region}）`];
  if (preferDomestic) parts.push('实名已认证 → 优先就近区域');
  if (protocol !== '') parts.push(`支持 ${protocol}`);
  if (node.bandwidth !== undefined && node.bandwidth !== null) parts.push(`带宽 ${node.bandwidth}`);
  if (node.allowPort) parts.push(`可用端口段 ${node.allowPort}`);
  return parts.join('，');
}

/**
 * Parse a node's `allowPort` field (`null`/`""` = unrestricted, `"(50000,60000)"` = range)
 * and tell whether a remote port is acceptable.
 *
 * 解析节点的可用端口段。
 */
export function portAllowedByNode(allowPort, port) {
  if (allowPort === null || allowPort === undefined || allowPort === '') return true;
  const match = String(allowPort).match(/\(?\s*(\d+)\s*,\s*(\d+)\s*\)?/);
  if (match === null) return true;
  const low = Number(match[1]);
  const high = Number(match[2]);
  return port >= low && port <= high;
}
