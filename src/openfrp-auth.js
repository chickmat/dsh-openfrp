/**
 * dsh-openfrp — OpenFrp "remote login" (argoAccess) in Node.
 *
 * The official flow, reconstructed from the OpenFrp API doc and the official
 * cross-platform launcher's Rust implementation:
 *
 *   1. Generate an X25519 key pair. Send the **public** key (base64, URL_SAFE,
 *      padded) to `POST {OF_ACCESS}/argoAccess/requestLogin`.
 *   2. The response carries an `authorization_url` the human must open, plus a
 *      `request_uuid` valid for 5 minutes.
 *   3. Poll `GET {OF_ACCESS}/argoAccess/pollLogin?request_uuid=…` at 5s intervals
 *      (the service hard-429s beyond a threshold). 204 = consent not given yet.
 *   4. On success the body has `authorization_data`, and the **response header**
 *      `x-request-public-key` holds the server's public key.
 *   5. `authorization_data` decodes to `nonce(24 bytes) || ciphertext`; decrypt
 *      it with NaCl box (X25519 + XSalsa20-Poly1305) to get the plaintext
 *      Authorization token.
 *
 * Node's built-in `crypto` has X25519 but **no XSalsa20-Poly1305** (measured on
 * v24.18.1), so we use `tweetnacl` — the canonical NaCl implementation. The
 * dependency is imported lazily so the rest of the plugin keeps working if it
 * is missing; only the login flow needs it.
 *
 * @module dsh-openfrp/openfrp-auth
 */

import crypto from 'node:crypto';
import { OF_ACCESS } from './protocol.js';

/** Stable, reusable errors. */
export class ArgoError extends Error {
  constructor(message, { code = 'argo', status = 0, body } = {}) {
    super(message);
    this.name = 'ArgoError';
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

// ─────────────────────────────────────────────────────────────
// base64 tolerance
// ─────────────────────────────────────────────────────────────

/** Encode bytes as URL_SAFE base64 **with** padding (what the service expects). */
export function b64urlPadded(buffer) {
  const raw = Buffer.from(buffer).toString('base64url');
  const remainder = raw.length % 4;
  return remainder === 0 ? raw : raw + '='.repeat(4 - remainder);
}

/**
 * Decode base64 in whatever dialect the server chose this time. The official
 * launcher needed the same four-way tolerance, which tells us the server's
 * encoding is not stable across responses.
 *
 * 四种 base64 变体都试一遍 —— 服务端返回的编码并不稳定。
 */
export function b64DecodeAny(text) {
  const value = String(text ?? '').trim();
  if (value === '') throw new ArgoError('base64 内容为空', { code: 'b64' });
  for (const encoding of ['base64url', 'base64']) {
    try {
      const decoded = Buffer.from(value, encoding);
      if (decoded.length > 0) return decoded;
    } catch {
      /* try next */
    }
  }
  const padded = value + '='.repeat((4 - (value.length % 4)) % 4);
  for (const encoding of ['base64url', 'base64']) {
    try {
      const decoded = Buffer.from(padded, encoding);
      if (decoded.length > 0) return decoded;
    } catch {
      /* try next */
    }
  }
  throw new ArgoError(`base64 解码失败：${value.slice(0, 32)}…`, { code: 'b64' });
}

// ─────────────────────────────────────────────────────────────
// Session bookkeeping (in-process; one login at a time per uuid)
// ─────────────────────────────────────────────────────────────

/** @type {Map<string, {secretKey: Uint8Array, publicKey: Uint8Array, createdAt: number, authorizationUrl: string}>} */
const pendingLogins = new Map();

/** How long a request_uuid stays valid, per the official docs. */
export const LOGIN_TTL_MS = 5 * 60 * 1000;
/** Recommended poll interval (1 / 5s) and the ceiling the service enforces. */
export const POLL_INTERVAL_MS = 5000;
export const MAX_POLLS = 60;

function pruneExpired(now = Date.now()) {
  for (const [uuid, session] of pendingLogins) {
    if (now - session.createdAt > LOGIN_TTL_MS) pendingLogins.delete(uuid);
  }
}

// ─────────────────────────────────────────────────────────────
// Step 1 — request consent
// ─────────────────────────────────────────────────────────────

/**
 * Start a remote login. Returns the URL the human must open plus the uuid to
 * poll with — but does NOT block.
 *
 * 发起远程登录：返回需要人打开的授权 URL 和用于轮询的 uuid（不阻塞）。
 */
export async function startLogin({ fetchImpl, access = OF_ACCESS } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const { loadNacl } = await import('./nacl.js');
  const nacl = await loadNacl();

  pruneExpired();

  const keyPair = nacl.box.keyPair();
  const publicKeyB64 = b64urlPadded(keyPair.publicKey);

  const response = await doFetch(`${access}/argoAccess/requestLogin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ public_key: publicKeyB64 }),
    signal: AbortSignal.timeout(30_000),
  });

  if (response.status === 429) {
    throw new ArgoError('OpenFrp 限流（429）：请求过于频繁，请等待后再试。', { code: 'rate-limited', status: 429 });
  }

  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ArgoError(`requestLogin 返回非 JSON：${text.slice(0, 200)}`, { code: 'bad-json', status: response.status, body: text });
  }

  const code = Number(parsed?.code ?? response.status);
  if (code !== 200) {
    throw new ArgoError(`请求授权失败（code=${code}）：${parsed?.msg ?? '未知原因'}`, { code: 'request-failed', status: code, body: parsed });
  }

  const data = parsed?.data ?? {};
  if (typeof data.authorization_url !== 'string' || typeof data.request_uuid !== 'string') {
    throw new ArgoError('requestLogin 响应缺少 authorization_url / request_uuid', { code: 'bad-shape', body: parsed });
  }

  pendingLogins.set(data.request_uuid, {
    secretKey: keyPair.secretKey,
    publicKey: keyPair.publicKey,
    createdAt: Date.now(),
    authorizationUrl: data.authorization_url,
  });

  return {
    authorizationUrl: data.authorization_url,
    requestUuid: data.request_uuid,
    expiresAt: new Date(Date.now() + LOGIN_TTL_MS).toISOString(),
    pollIntervalMs: POLL_INTERVAL_MS,
  };
}

// ─────────────────────────────────────────────────────────────
// Step 2 — poll and decrypt
// ─────────────────────────────────────────────────────────────

/**
 * One poll attempt.
 *
 * @returns {Promise<{status:'pending'|'ready', authorization?:string, message:string}>}
 *   `pending` means "keep polling" (204, or 429 which we treat as back-off).
 */
export async function pollLogin(requestUuid, { fetchImpl, access = OF_ACCESS } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const session = pendingLogins.get(requestUuid);
  if (session === undefined) {
    throw new ArgoError('找不到该登录请求的密钥（可能已过期或插件已重启），请重新发起登录。', { code: 'no-session' });
  }
  if (Date.now() - session.createdAt > LOGIN_TTL_MS) {
    pendingLogins.delete(requestUuid);
    throw new ArgoError('登录请求已超过 5 分钟有效期，请重新发起。', { code: 'expired' });
  }

  const url = `${access}/argoAccess/pollLogin?request_uuid=${encodeURIComponent(requestUuid)}`;
  const response = await doFetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });

  if (response.status === 204) return { status: 'pending', message: '尚未在浏览器中完成授权' };
  if (response.status === 429) return { status: 'pending', message: '命中限流（429），继续等待' };
  if (response.status !== 200) {
    const text = await response.text();
    throw new ArgoError(`轮询失败：HTTP ${response.status} ${text.slice(0, 200)}`, { code: 'poll-failed', status: response.status, body: text });
  }

  const serverPublicKeyB64 = response.headers.get('x-request-public-key');
  if (serverPublicKeyB64 === null || serverPublicKeyB64 === '') {
    throw new ArgoError('响应缺少 x-request-public-key，无法解密授权数据。', { code: 'no-server-key' });
  }

  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ArgoError(`pollLogin 返回非 JSON：${text.slice(0, 200)}`, { code: 'bad-json', body: text });
  }
  const code = Number(parsed?.code ?? 200);
  if (code !== 200) {
    throw new ArgoError(`轮询失败（code=${code}）：${parsed?.msg ?? '未知原因'}`, { code: 'poll-failed', body: parsed });
  }

  const authorizationData = parsed?.data?.authorization_data;
  if (typeof authorizationData !== 'string' || authorizationData === '') {
    throw new ArgoError('轮询响应缺少 authorization_data。', { code: 'bad-shape', body: parsed });
  }

  const { loadNacl } = await import('./nacl.js');
  const nacl = await loadNacl();

  const serverPublicKey = b64DecodeAny(serverPublicKeyB64);
  if (serverPublicKey.length !== 32) {
    throw new ArgoError(`服务器公钥长度错误（期望 32 字节，实际 ${serverPublicKey.length}）。`, { code: 'bad-server-key' });
  }

  const cipherAll = b64DecodeAny(authorizationData);
  if (cipherAll.length < 24) {
    throw new ArgoError('授权密文长度不合法（不足 24 字节 nonce）。', { code: 'bad-cipher' });
  }
  const nonce = cipherAll.subarray(0, 24);
  const cipher = cipherAll.subarray(24);

  const opened = nacl.box.open(cipher, nonce, serverPublicKey, session.secretKey);
  if (opened === null || opened === undefined) {
    throw new ArgoError('授权数据解密失败（密钥不匹配或数据损坏）。', { code: 'decrypt-failed' });
  }

  pendingLogins.delete(requestUuid);
  return {
    status: 'ready',
    authorization: Buffer.from(opened).toString('utf8'),
    message: '授权成功',
  };
}

/**
 * Poll until the human finishes in the browser, or we run out of budget.
 * Kept as a loop so the agent can also drive polling step by step if it
 * prefers; both paths use the same `pollLogin`.
 *
 * 轮询直到人类在浏览器里完成授权，或超出预算。
 */
export async function waitLogin(requestUuid, { fetchImpl, access = OF_ACCESS, timeoutMs = LOGIN_TTL_MS, onTick } = {}) {
  const deadline = Date.now() + Math.min(timeoutMs, LOGIN_TTL_MS);
  let attempts = 0;
  for (;;) {
    attempts += 1;
    if (attempts > MAX_POLLS) {
      pendingLogins.delete(requestUuid);
      throw new ArgoError('轮询次数超限（60 次 / 5 分钟），请重新发起登录。', { code: 'too-many-polls' });
    }
    const result = await pollLogin(requestUuid, { fetchImpl, access });
    if (result.status === 'ready') return { ...result, attempts };
    onTick?.({ attempts, message: result.message });
    if (Date.now() >= deadline) {
      pendingLogins.delete(requestUuid);
      throw new ArgoError('等待授权超时（5 分钟），请重新发起登录。', { code: 'timeout' });
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/** Forget a pending login (user cancelled). */
export function cancelLogin(requestUuid) {
  return pendingLogins.delete(requestUuid);
}

/** Introspection for tests / status tooling. */
export function pendingLoginCount() {
  pruneExpired();
  return pendingLogins.size;
}

/**
 * Best-effort "open this URL in the user's browser".
 * Returns which strategy was used so the agent can tell the human what to do
 * if nothing opened.
 *
 * 尽力帮用户打开浏览器；返回用了哪种方式，便于 Agent 在失败时告诉人怎么办。
 */
export async function openInBrowser(url, { platform = process.platform, spawnImpl } = {}) {
  const { spawn } = spawnImpl !== undefined ? { spawn: spawnImpl } : await import('node:child_process');
  const command = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref?.();
    return { opened: true, via: command };
  } catch (error) {
    return { opened: false, via: command, error: String(error?.message ?? error) };
  }
}

/** A fresh random state value — kept for future use (login CSRF hardening). */
export function randomState() {
  return crypto.randomBytes(16).toString('hex');
}
