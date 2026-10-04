/**
 * dsh-openfrp — host half.
 *
 * Registers the agent tools and writes a short guidance section into the system
 * prompt, so a fresh session knows these capabilities exist. There is
 * deliberately **no browser half and no GUI**: the interface to this plugin is
 * the agent itself (the user's own words: "插件不是围绕 dsh，让 dsh 进行操作吗").
 *
 * 宿主侧入口。注册 Agent 工具，并往系统提示里写一段说明。
 * **刻意不做浏览器侧、不做 GUI** —— 插件的界面就是 DSH 自己。
 *
 * @module dsh-openfrp
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createRuntime } from './actions.js';
import { registerOpenFrpTools } from './tools.js';

/**
 * Copy the bundled skills into the user's skill root.
 *
 * The plugin's knowledge lives in a **skill**, not in hard-coded scripts: the
 * rules (four-state start, mutable-state locking, readiness hierarchy, process
 * identification, graceful stop) have to be re-instantiated whenever the server
 * version, edition or service changes — a Bedrock server has no RCON, a Fabric
 * pack cannot be launched with `java -jar`. Baking today's Minecraft answers
 * into a template would leave DSH helpless the moment any of that changes, so
 * the methodology is handed over as a skill and the generated scripts are just
 * one concrete instance of it.
 *
 * Only missing files are created; user edits are never overwritten. Any failure
 * is a warning, never a plugin failure.
 *
 * 把随包分发的技能同步到 `~/.dsh/skills/`。只补缺、不覆盖用户改动；失败只告警。
 */
function syncBundledSkills() {
  try {
    const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const sourceRoot = path.join(packageRoot, 'skills');
    if (fs.existsSync(sourceRoot) !== true) return [];
    const dshHome = process.env.DSH_HOME ?? path.join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.dsh');
    const targetRoot = path.join(dshHome, 'skills');
    const installed = [];
    for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
      if (entry.isDirectory() !== true) continue;
      const sourceFile = path.join(sourceRoot, entry.name, 'SKILL.md');
      if (fs.existsSync(sourceFile) !== true) continue;
      const targetDir = path.join(targetRoot, entry.name);
      const targetFile = path.join(targetDir, 'SKILL.md');
      if (fs.existsSync(targetFile)) continue;
      fs.mkdirSync(targetDir, { recursive: true });
      fs.copyFileSync(sourceFile, targetFile);
      installed.push(entry.name);
    }
    return installed;
  } catch {
    return [];
  }
}

/** Stable cordis plugin name. */
export const name = 'openfrp';

/**
 * Services that must exist before the tools can mount.
 *
 * NOTE: `tools` is deliberately NOT listed here. Both reference plugins
 * (dsh-audiogen, dsh-free-search) only list their *own* services here and pull
 * `tools` in with an explicit `ctx.inject(['tools'], …)` at apply time. Declaring
 * `tools` as a module-level requirement makes activation depend on service
 * ordering at startup, which is exactly the kind of thing that leaves a plugin
 * "loaded but toolless".
 */
export const inject = ['systemPrompt'];

/** How late in the system prompt our section appears. */
const SECTION_ORDER = 170;

export const Config = Schema.object({
  enabled: Schema.boolean().default(true),

  /** Announce the plugin to the agent in the system prompt. */
  announceToAgent: Schema.boolean().default(true),

  /**
   * Path to an frpc binary. Empty means "find one": the official launcher's
   * copy is reused when present, otherwise the plugin downloads its own into
   * `$DSH_HOME/dsh-openfrp/frpc/`.
   *
   * frpc 路径。留空 = 自动寻找（优先复用官方启动器自带的那个，找不到再自己下载）。
   */
  frpcPath: Schema.string().default(''),

  /** OpenFrp API base. Empty means the official `https://api.openfrp.net`. */
  apiBase: Schema.string().default(''),

  /** Try to open the authorization page in the browser during login. */
  autoOpenBrowser: Schema.boolean().default(true),

  /** How long `openfrp_expose` waits for the public address, in ms. */
  exposeTimeoutMs: Schema.number().default(90_000),

  /** How long to wait for a Minecraft server to print its readiness line. */
  serviceReadyTimeoutMs: Schema.number().default(180_000),
});

/**
 * The guidance the agent sees. It has one job: make the agent reach for these
 * tools instead of telling the user to go click something in a web panel —
 * which is exactly the failure this plugin exists to remove.
 */
export const GUIDANCE = [
  '本机已安装 dsh-openfrp 插件（DSH × OpenFrp）。它让 DSH 自己能看见和操作「本地服务 + 公网隧道」，不必让用户当数据中转。',
  '能力：挂靠本地服务（自动识别 Minecraft 服务端）、读实时日志、通过 RCON 发命令并拿到服务端原始回复、登录 OpenFrp、查/建/改/删隧道（自动解析公网地址与 CNAME）、把本地端口暴露到公网、以及基于证据的故障定位。',
  '**使用原则**：',
  '1. 需要 OpenFrp 的账号信息（隧道、节点、公网地址、CNAME）时，调 `openfrp_tunnel` / `openfrp_account`，**不要让用户去网页面板里找再念给你**。',
  '2. 需要了解运行中的服务端状态时，用 `service_logs` 读日志、用 `service_exec` 发命令（如 `list`、`spark tps`、`spark health show --memory`）**自己取证**，不要让用户截图或复制控制台。',
  '3. 用户说"卡"、"连不上"、"崩了"时，先 `openfrp_diagnose` 拿到带证据的结论，再回答。',
  '4. 新会话先 `service_list`，恢复"现在在跑什么、映射到哪"。',
  '5. 服务端进程由用户自己的启动脚本持有（关掉 DSH 会杀掉 DSH 的子进程，所以不要把长跑服务端做成 DSH 的子进程）。插件只挂靠、不接管；启动隧道时只拥有它自己启动的那些，**不会去动官方启动器正在用的隧道**。',
  '尚未登录 OpenFrp：请先调 `openfrp_account` 的 `status` 查看状态，必要时用 `login` 拉起授权页。',
].join('\n');

/** Effective config with defaults applied. */
function resolveConfig(config) {
  const value = config ?? {};
  return {
    enabled: value.enabled !== false,
    announceToAgent: value.announceToAgent !== false,
    frpcPath: typeof value.frpcPath === 'string' ? value.frpcPath : '',
    apiBase: typeof value.apiBase === 'string' ? value.apiBase : '',
    autoOpenBrowser: value.autoOpenBrowser !== false,
    exposeTimeoutMs: Number(value.exposeTimeoutMs ?? 90_000),
    serviceReadyTimeoutMs: Number(value.serviceReadyTimeoutMs ?? 180_000),
  };
}

export function apply(ctx, config) {
  const effective = resolveConfig(config);
  if (!effective.enabled) return;

  // Hand the methodology over as a skill before anything else: it is what lets
  // DSH adapt the hand-off rules to a different server version, a different
  // edition (Bedrock has no RCON), or a completely different service.
  const installedSkills = syncBundledSkills();
  if (installedSkills.length > 0) {
    ctx.logger?.info?.(`[openfrp] 已安装技能：${installedSkills.join('、')}`);
  }

  const runtime = createRuntime({
    config: effective,
    logger: {
      info: message => ctx.logger?.info?.(message),
      warn: message => ctx.logger?.warn?.(message),
      error: message => ctx.logger?.error?.(message),
    },
  });

  // ── Tools ──────────────────────────────────────────────────
  //
  // Fail LOUDLY. The first version of this plugin lost its entire tool surface
  // silently: `defineTool` threw on the first spec, cordis swallowed it inside
  // the effect, and the plugin still announced itself in the system prompt — so
  // it looked loaded while the agent had nothing to call. Logging here means the
  // host log names the problem instead of leaving us to guess.
  ctx.inject(['tools'], toolsCtx => {
    toolsCtx.effect(() => {
      try {
        return registerOpenFrpTools(toolsCtx, () => runtime, defineTool);
      } catch (error) {
        ctx.logger?.error?.(`[openfrp] 工具注册失败，插件将没有可用工具：${error?.message ?? error}`);
        throw error;
      }
    }, 'dsh-openfrp: agent tools');
  });

  // ── System prompt guidance ────────────────────────────────
  if (effective.announceToAgent) {
    ctx.inject(['systemPrompt'], promptCtx => {
      promptCtx.effect(
        () => promptCtx.systemPrompt.section({ name: 'plugin:dsh-openfrp', order: SECTION_ORDER, text: GUIDANCE }),
        'dsh-openfrp: guidance section',
      );
    });
  }
}
