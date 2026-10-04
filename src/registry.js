/**
 * dsh-openfrp — the service registry.
 *
 * This file's only reason to exist: **a new DSH session must be able to pick up
 * "what is running, on which local port, exposed at which public address"
 * without asking the human.** Without it, "diagnose it yourself" is impossible.
 *
 * 服务注册表。它存在的唯一理由：新会话的 DSH 能自己捡回"现在在跑什么、映射到哪"，
 * 不必问人。
 *
 * @module dsh-openfrp/registry
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Resolve the plugin data directory. 插件数据目录。 */
export function dataDir() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  return path.join(home, 'dsh-openfrp');
}

export function registryFile() {
  return path.join(dataDir(), 'registry.json');
}

export function credentialsFile() {
  return path.join(dataDir(), 'credentials.json');
}

/** Ensure the data dir exists. 确保数据目录存在。 */
export function ensureDataDir() {
  fs.mkdirSync(dataDir(), { recursive: true });
  return dataDir();
}

/** Read a JSON file, returning `fallback` when it is missing or corrupt. */
function readJson(file, fallback) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (text.trim() === '') return fallback;
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * The last persistence failure, if any. Persisting is a **cache, not a
 * precondition**: a read-only home directory, a full disk or a sandbox must not
 * turn "read my account info" or "remember this service" into hard failures.
 * We keep the in-memory value working and report the error separately.
 *
 * 持久化是缓存而不是前提条件。写不进去时保留内存值，并把错误单独记录下来。
 */
let lastPersistError = null;

/** Read (and clear) the last persistence failure. 读取并清空最近一次持久化错误。 */
export function takePersistError() {
  const error = lastPersistError;
  lastPersistError = null;
  return error;
}

/**
 * Write JSON atomically: temp file in the same directory + rename, so a crash
 * can never leave a half-written registry behind.
 *
 * 原子写：同目录临时文件 + rename，避免写一半崩溃留下坏文件。
 *
 * @returns {{ok:boolean, error?:string}}
 */
function writeJsonAtomic(file, value, { mode } = {}) {
  try {
    ensureDataDir();
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    const text = JSON.stringify(value, null, 2);
    fs.writeFileSync(tmp, text, mode === undefined ? {} : { mode });
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (error) {
    const message = `${file}: ${error?.code ?? ''} ${error?.message ?? error}`.trim();
    lastPersistError = message;
    return { ok: false, error: message };
  }
}

// ─────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────

const EMPTY = { version: 1, services: [] };

/** Load the whole registry. 读取注册表。 */
export function loadRegistry(file = registryFile()) {
  const raw = readJson(file, EMPTY);
  if (raw === null || typeof raw !== 'object' || !Array.isArray(raw.services)) return { ...EMPTY };
  return { version: raw.version ?? 1, services: raw.services.filter(s => s && typeof s.id === 'string') };
}

/** Persist the whole registry. 保存注册表。 */
export function saveRegistry(registry, file = registryFile()) {
  writeJsonAtomic(file, { version: registry.version ?? 1, services: registry.services ?? [] });
  return registry;
}

/** Find one service by id. 按 id 查服务。 */
export function getService(id, file = registryFile()) {
  return loadRegistry(file).services.find(s => s.id === id) ?? null;
}

/**
 * Insert or shallow-merge one service record. `patch` wins over the stored
 * record, but existing fields not present in `patch` are preserved.
 *
 * 新增或浅合并一条服务记录。
 */
export function upsertService(patch, file = registryFile()) {
  if (patch === null || typeof patch !== 'object' || typeof patch.id !== 'string' || patch.id === '') {
    throw new Error('upsertService: patch.id is required');
  }
  const registry = loadRegistry(file);
  const index = registry.services.findIndex(s => s.id === patch.id);
  const now = new Date().toISOString();
  if (index === -1) {
    registry.services.push({ ...patch, createdAt: now, updatedAt: now });
  } else {
    registry.services[index] = { ...registry.services[index], ...patch, updatedAt: now };
  }
  saveRegistry(registry, file);
  return getService(patch.id, file);
}

/** Remove one service; returns true when something was removed. */
export function removeService(id, file = registryFile()) {
  const registry = loadRegistry(file);
  const before = registry.services.length;
  registry.services = registry.services.filter(s => s.id !== id);
  if (registry.services.length === before) return false;
  saveRegistry(registry, file);
  return true;
}

// ─────────────────────────────────────────────────────────────
// Credentials
// ─────────────────────────────────────────────────────────────

/**
 * Stored credential shape. We keep the Authorization token (the 30-day
 * "third-party client" credential) and, when we learn it, the 32-bit user
 * token that frpc's `-u` needs.
 *
 * 凭据：Authorization（会话凭证）+ 32 位用户 token（frpc `-u` 需要）。
 */
export function loadCredentials(file = credentialsFile()) {
  const raw = readJson(file, {});
  return raw !== null && typeof raw === 'object' ? raw : {};
}

export function saveCredentials(patch, file = credentialsFile()) {
  const merged = { ...loadCredentials(file), ...patch };
  // Best-effort 0600; harmless (and ignored) on filesystems that do not support it.
  // The write never throws — persisting is a cache, and a failed write must not
  // turn "who am I on OpenFrp" into an error.
  const result = writeJsonAtomic(file, merged, { mode: 0o600 });
  if (result.ok !== true) writeJsonAtomic(file, merged);
  return merged;
}

export function clearCredentials(file = credentialsFile()) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Overwrite the credential store outright.
 *
 * `saveCredentials` merges, which is right for "I learned a new token" but can
 * never remove a key — so anything that needs to *drop* a field (logout, a
 * migration, cleaning up a stray key) needs this.
 *
 * 整体覆盖凭据文件。saveCredentials 是合并语义，删不掉键，需要删除时用这个。
 */
export function replaceCredentials(credentials, file = credentialsFile()) {
  const value = credentials !== null && typeof credentials === 'object' ? credentials : {};
  const result = writeJsonAtomic(file, value, { mode: 0o600 });
  if (result.ok !== true) writeJsonAtomic(file, value);
  return value;
}
