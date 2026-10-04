/**
 * dsh-openfrp — the one place that touches tweetnacl.
 *
 * Node ships X25519 but **not** XSalsa20-Poly1305 (measured on v24.18.1), so the
 * OpenFrp remote-login flow needs a NaCl implementation. `tweetnacl` is the
 * canonical one. We import it dynamically and turn a missing dependency into a
 * clear, actionable message instead of a module-resolution stack trace.
 *
 * 唯一接触 tweetnacl 的地方。Node 有 X25519 但没有 XSalsa20-Poly1305，
 * 所以 argo 登录需要它；缺失时给出可操作的提示，而不是一堆模块解析报错。
 *
 * @module dsh-openfrp/nacl
 */

let cached = null;

/** Load tweetnacl, or explain precisely how to fix the situation. */
export async function loadNacl() {
  if (cached !== null) return cached;
  try {
    const mod = await import('tweetnacl');
    cached = mod.default ?? mod;
    if (typeof cached?.box?.open !== 'function' || typeof cached?.box?.keyPair !== 'function') {
      throw new Error('tweetnacl 的形状不符合预期（缺少 box.keyPair / box.open）');
    }
    return cached;
  } catch (error) {
    cached = null;
    throw new Error(
      '缺少依赖 tweetnacl，无法完成 OpenFrp 远程登录（Node 内置 crypto 没有 XSalsa20-Poly1305）。'
      + `请在插件目录执行：npm install tweetnacl。原始错误：${error?.message ?? error}`,
    );
  }
}

/** Test seam. 测试用。 */
export function __setNaclForTests(value) {
  cached = value;
}
