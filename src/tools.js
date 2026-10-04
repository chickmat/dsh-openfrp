/**
 * dsh-openfrp — tool registration (the only place that touches the Host's tool
 * registry).
 *
 * The specs themselves live in `tool-specs.js` as plain data, so a test can
 * validate them without importing this module's `@deepseek-ai/dsh-tools`
 * dependency (which is not resolvable from the plugin directory in a bare
 * `node` run — only inside the Host).
 *
 * Registration compiles every spec BEFORE registering anything, and throws with
 * the offending tool named. The first version of this plugin registered tools
 * one by one, `defineTool` threw on the first spec (a missing `output` field),
 * and the result was a plugin that announced itself to the agent but had no
 * tools at all. Failing loudly beats that.
 *
 * @module dsh-openfrp/tools
 */

import { buildToolSpecs } from './tool-specs.js';

/**
 * Register every tool. Returns a disposer that unregisters them all.
 *
 * `defineTool` is injected by the composition root (`index.js`) instead of being
 * imported here, for one concrete reason: `@deepseek-ai/dsh-tools` only resolves
 * inside the Host, so a static import would make this module — the layer where
 * the original silent failure lived — untestable from a bare `node` process.
 *
 * @param {object} ctx cordis context carrying the `tools` service
 * @param {() => object} resolveRuntime
 * @param {Function} defineToolImpl the Host's `defineTool`
 */
export function registerOpenFrpTools(ctx, resolveRuntime, defineToolImpl) {
  if (typeof defineToolImpl !== 'function') {
    throw new Error('dsh-openfrp: 缺少 defineTool —— 应由宿主入口从 @deepseek-ai/dsh-tools 注入。');
  }
  const specs = buildToolSpecs(resolveRuntime);

  const compiled = specs.map(spec => {
    try {
      return defineToolImpl(spec);
    } catch (error) {
      throw new Error(
        `dsh-openfrp: 工具 "${spec?.name ?? '(未命名)'}" 的定义被宿主拒绝：${error?.message ?? error}。`
        + 'defineTool 要求 output { schema, render }，且值 schema 必须显式声明 additionalProperties（不支持 required）。',
      );
    }
  });

  const disposers = compiled.map(tool => ctx.tools.register(tool));
  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch {
        /* best effort */
      }
    }
  };
}
