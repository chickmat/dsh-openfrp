/**
 * dsh-openfrp — tool specifications, as plain data.
 *
 * Kept free of any `@deepseek-ai/dsh-tools` import on purpose: this module is
 * the part a test can load in a bare `node` process and validate against the
 * Host's real `defineTool`. That matters, because the first version of this
 * plugin shipped specs without an `output` field, `defineTool` threw on the
 * very first tool, and the whole registration was silently lost — the agent saw
 * the plugin's guidance text but had none of its tools. A contract test is the
 * only thing that reliably catches that class of mistake.
 *
 * Spec contract (measured against the Host's own `defineTool`):
 *  - `output` is **required**, and `output.render` must be a function.
 *  - `render` must return ContentBlock[], not a bare string, because the
 *    post-execute consumers expect blocks.
 *  - The value schema DSL rejects `{ type: 'object' }` (it demands an explicit
 *    `additionalProperties`) and rejects `required`. So the only portable shape
 *    for heterogeneous results is `{ type: 'object', additionalProperties: true }`.
 *
 * @module dsh-openfrp/tool-specs
 */

import * as realActions from './actions.js';

/**
 * The value schema every tool declares. Our tools return different shapes per
 * action, so the portable choice is an open object; the greeting is that the
 * *content* still carries the evidence.
 */
const VALUE_SCHEMA = { type: 'object', additionalProperties: true };

/** Render any tool result as text for the model. */
export function renderValue(value) {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** The `output` block shared by every tool. */
const OUTPUT = {
  schema: VALUE_SCHEMA,
  render: (_args, value) => [{ type: 'text', text: renderValue(value) }],
};

/**
 * Wrap an action so a thrown error becomes an evidence-bearing *result* rather
 * than a crash: the tool must never take down registration or the turn.
 */
function guarded(fn) {
  return async args => {
    try {
      return await fn(args ?? {});
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        ...(error?.code === undefined ? {} : { code: error.code }),
      };
    }
  };
}

/**
 * Camel-case every argument key, once, for every tool.
 *
 * Why this exists: the tool layer declared `follow_ms` while the action layer
 * destructured `followMs`, and nothing renamed in between — so the value was
 * silently dropped, `service_logs` never actually followed the log, and the
 * return still said "an idle server writes no logs", which made our own bug look
 * like a property of the server. `service_stop`'s `grace_seconds` had the same
 * defect. Three naming strategies coexisted (explicit rename / passthrough +
 * snake-aware action / passthrough + camel-aware action), so a miss was
 * invisible by inspection.
 *
 * Now there is exactly ONE rule: **the tool layer camelizes; the action layer
 * only ever sees camelCase.** `normalizeProxyFields` still tolerates snake_case
 * so a direct call cannot silently lose a field either.
 *
 * 把参数名统一转成驼峰。此前工具层用 `follow_ms`、动作层解构 `followMs`，中间没人转名，
 * 值被静默丢弃。现在只有一条规则：**工具层统一转名，动作层只见驼峰**。
 */
export function camelizeArgs(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return args;
  const out = {};
  for (const [key, value] of Object.entries(args)) {
    out[key.includes('_') ? key.replace(/_([a-z0-9])/g, (_, ch) => ch.toUpperCase()) : key] = value;
  }
  return out;
}

/**
 * Build every tool spec. `resolveRuntime` is called lazily so each invocation
 * sees the current credentials and attachments.
 *
 * Every spec's `execute` is wrapped so arguments are camelized before the action
 * layer sees them — one rule, applied in one place, so a rename can never be
 * forgotten again.
 *
 * @param {() => object} resolveRuntime
 */
export function buildToolSpecs(resolveRuntime, actionsOverride = null) {
  const specs = buildRawSpecs(resolveRuntime, actionsOverride);
  return specs.map(spec => ({
    ...spec,
    execute: async args => spec.execute(camelizeArgs(args)),
  }));
}

/**
 * @param {() => object} resolveRuntime
 * @param {object|null} [actionsOverride] injectable action layer, so a test can
 *   assert that a parameter's VALUE actually reaches the action. That check is
 *   the one this plugin was missing: the schema-shape tests all passed while
 *   `follow_ms` was being dropped on the floor.
 */
function buildRawSpecs(resolveRuntime, actionsOverride = null) {
  // Shadowing the module import on purpose: every `actions.X` below then resolves
  // to the injected stub when a test provides one.
  const actions = actionsOverride ?? realActions;
  return [
    // ── Account ─────────────────────────────────────────────
    {
      name: 'openfrp_account',
      description: 'Manage the OpenFrp account session. action=login starts the official remote-login flow (returns a URL the user must open, valid 5 minutes); action=poll or action=wait finishes it and stores the credential; action=status reports login state, account info and whether the 32-bit user token (needed by frpc) is known; action=logout clears local credentials. Call status first when you need to know whether you can act on OpenFrp at all.',
      parameters: {
        action: { type: 'string', enum: ['status', 'login', 'poll', 'wait', 'logout'], required: true, description: 'What to do.' },
        request_uuid: { type: 'string', description: 'For poll/wait: the uuid returned by login.' },
        auto_open: { type: 'boolean', description: 'For login: try to open the authorization page in the browser (default true).' },
        timeout_ms: { type: 'number', description: 'For wait: how long to poll before giving up (max 300000).' },
      },
      output: OUTPUT,
      execute: guarded(async args => {
        const runtime = resolveRuntime();
        switch (args.action) {
          case 'status': return actions.accountStatus(runtime);
          case 'login': return actions.accountLogin(runtime, { autoOpen: args.autoOpen !== false });
          case 'poll': return actions.accountPoll(runtime, { requestUuid: args.requestUuid });
          case 'wait': return actions.accountWait(runtime, { requestUuid: args.requestUuid, timeoutMs: args.timeoutMs });
          case 'logout': return actions.accountLogout(runtime);
          default: throw new Error(`未知 action：${args.action}`);
        }
      }),
    },

    // ── Tunnels & nodes ─────────────────────────────────────
    {
      name: 'openfrp_tunnel',
      description: 'Inspect and manage OpenFrp tunnels and nodes. action=list returns every tunnel with its PUBLIC ADDRESS and CNAME target already resolved (this is how you avoid asking the user to find them in the web panel); action=nodes filters and ranks nodes for a protocol with the rejection reasons attached; action=create/edit/delete change tunnel records; action=enable/disable flips the server-side record. Note: enabling a tunnel record is NOT the same as starting the local frpc process — use openfrp_expose for that.',
      parameters: {
        action: { type: 'string', enum: ['list', 'nodes', 'create', 'edit', 'delete', 'enable', 'disable'], required: true, description: 'What to do.' },
        protocol: { type: 'string', description: 'For nodes: required protocol (tcp/udp/http/https/stcp/xtcp).' },
        classify: { type: 'number', description: 'For nodes: 1=Chinese mainland, 2=HK/MO/TW, 3=overseas.' },
        proxy_id: { type: 'number', description: 'For edit/delete/enable/disable.' },
        name: { type: 'string', description: 'For create/edit: tunnel name. OpenFrp accepts ONLY lowercase ASCII letters (^[a-z]+$) — measured: "dsh-mc-262" is rejected with "隧道名不符合要求", "dshmc" is accepted. Any other character is stripped automatically and the rename is reported back.' },
        type: { type: 'string', description: 'For create/edit: tcp/udp/http/https.' },
        local_addr: { type: 'string', description: 'For create/edit: default 127.0.0.1.' },
        local_port: { type: 'number', description: 'For create/edit: the local port to forward. Must be a number — sending it as a string makes OpenFrp store 0.' },
        node_id: { type: 'number', description: 'For create/edit: node id from action=nodes.' },
        remote_port: { type: 'number', description: 'For tcp/udp only (required by OpenFrp). Ports below 1024 and well-known service ports are refused (measured: 25565 → "系统保护端口区间"), and so are ports already in use. Omit it and create will pick a free port from 10000-65535 itself, retrying several candidates; pass it and create tries only that one, then returns classified suggestions.' },
        domain_bind: { type: 'string', description: 'For http/https: the domain to bind.' },
      },
      output: OUTPUT,
      execute: guarded(async args => {
        const runtime = resolveRuntime();
        switch (args.action) {
          case 'list': return actions.tunnelsList(runtime);
          case 'nodes': return actions.nodesList(runtime, { protocol: args.protocol, classify: args.classify });
          case 'create': return actions.tunnelCreate(runtime, args);
          case 'edit': return actions.tunnelEdit(runtime, args);
          case 'delete': return actions.tunnelDelete(runtime, { proxyId: args.proxyId });
          case 'enable':
          case 'disable': return actions.tunnelSetEnabled(runtime, { proxyId: args.proxyId, enabled: args.action === 'enable' });
          default: throw new Error(`未知 action：${args.action}`);
        }
      }),
    },

    // ── Services ────────────────────────────────────────────
    {
      name: 'service_attach',
      description: 'Attach to a local service so the agent can observe it. Point it at a directory (auto-detects a Minecraft server from server.properties / logs/) or at a bare port. Attaching starts nothing and changes nothing — it only records where the service lives, which port it actually uses, where its log is, and how to send it commands. Attach before using service_logs / service_exec / service_status.',
      parameters: {
        id: { type: 'string', description: 'Short id to refer to this service later. Defaults to the directory name.' },
        target: { type: 'string', description: 'Absolute path to the service directory.' },
        port: { type: 'number', description: 'Explicit local port, when it cannot be detected.' },
        kind: { type: 'string', description: 'Force an adapter, e.g. minecraft-java.' },
      },
      output: OUTPUT,
      execute: guarded(args => actions.serviceAttach(resolveRuntime(), args)),
    },
    {
      name: 'service_list',
      description: 'List every service the plugin has been told about, with its local port, its tunnel and whether the frpc the plugin owns is running. Call this FIRST in a new session — it is how you recover "what is running right now" without asking the user.',
      parameters: {},
      output: OUTPUT,
      execute: guarded(() => actions.serviceList(resolveRuntime())),
    },
    {
      name: 'service_status',
      description: 'Probe a service for real and report each check separately: is its port actually listening, does it answer on RCON, what does the log look like. Never infers liveness from log activity — an idle Minecraft server writes nothing at all, so "log quiet" is not "dead".',
      parameters: { id: { type: 'string', required: true, description: 'Service id from service_attach / service_list.' } },
      output: OUTPUT,
      execute: guarded(args => actions.serviceStatus(resolveRuntime(), args)),
    },
    {
      name: 'service_logs',
      description: 'Read a service log. Returns recent history and optionally a short live window. This is the agent\'s eyes on a running server — use it instead of asking the user to copy a console window or take a screenshot.',
      parameters: {
        id: { type: 'string', required: true, description: 'Service id.' },
        lines: { type: 'number', description: 'How many recent lines to return (default 60, max 500).' },
        follow_ms: { type: 'number', description: 'If > 0, also watch the live log for this many milliseconds.' },
      },
      output: OUTPUT,
      execute: guarded(args => actions.serviceLogs(resolveRuntime(), args)),
    },
    {
      name: 'service_exec',
      description: 'Send one or more commands to a running service and return the SERVER\'S OWN REPLY verbatim. For Minecraft this uses RCON (requires enable-rcon=true + rcon.password in server.properties). **RCON carries only a command\'s synchronous output: an asynchronous command (e.g. `spark tps`) legitimately returns an empty string — an empty reply is NOT a failure.** When that happens the result carries a note telling you to read the log instead. Use it to investigate instead of instructing the user: ask the server "list", "spark health show --memory" and read the answer yourself.',
      parameters: {
        id: { type: 'string', required: true, description: 'Service id.' },
        command: { type: 'array', items: { type: 'string' }, required: true, description: 'Command(s) to run, without a leading slash.' },
      },
      output: OUTPUT,
      execute: guarded(args => actions.serviceExec(resolveRuntime(), args)),
    },
    {
      name: 'service_start',
      description: 'Start a local service and follow its log until it reports ready — **for verification only**. Measured: a process started by DSH does NOT survive the DSH host restarting (a background job and Start-Process were both gone afterwards), so **never promise the user that this keeps a server alive**. For a server that stays up, use service_export_scripts and have the user run the scripts. '
        + 'It performs a four-state check first (cold / already running / still starting / zombie) and refuses to start a second copy while one is still loading, because a second copy fights over the world lock. It prefers a start script found in the directory over guessing a java command, because scripts often encode required launch quirks. '
        + 'Returns `spawnedPid`, and on failure the exit code plus the child\'s own output — so "never spawned" and "spawned and died" become different answers instead of the same silence.',
      parameters: {
        id: { type: 'string', required: true, description: 'Service id (attach first if you have not).' },
        script: { type: 'string', description: 'Explicit start script path. Omit to auto-detect one in the service directory.' },
        wait_ms: { type: 'number', description: 'How long to wait for the readiness marker (default 180000).' },
      },
      output: OUTPUT,
      execute: guarded(args => actions.serviceStart(resolveRuntime(), args)),
    },
    {
      name: 'service_detach',
      description: 'Forget a service in the plugin registry. The registry could previously only grow — abandoned or test entries piled up with no way to clear them. Detaching touches **only the plugin\'s own record**: it never deletes, stops or modifies the service on disk, and it never touches a tunnel on OpenFrp.',
      parameters: {
        id: { type: 'string', required: true, description: 'Service id to forget (see service_list).' },
      },
      output: OUTPUT,
      execute: guarded(args => actions.serviceDetach(resolveRuntime(), args)),
    },
    {
      name: 'service_stop',
      description: 'Stop a local service: control channel first (for Minecraft, RCON `stop`, which saves the world), force-kill only as a fallback. This is the step the hand-off order depends on — a DSH-started verification instance MUST be shut down before the user takes over, otherwise the user\'s own double-click fights it for the world lock. Reports which pids stopped, whether the stop was graceful, and whether the port is finally free.',
      parameters: {
        id: { type: 'string', required: true, description: 'Service id.' },
        grace_seconds: { type: 'number', description: 'How long to wait for a graceful exit before forcing (default 30).' },
      },
      output: OUTPUT,
      execute: guarded(args => actions.serviceStop(resolveRuntime(), args)),
    },
    {
      name: 'service_export_scripts',
      description: 'Export start/stop scripts into the service directory — the durable way to run a long-lived service, and the ONLY one. Measured: a process started by DSH (a background job OR Start-Process) is gone after the DSH host restarts; only a process the USER launched survives. So the division of labour is: DSH configures and verifies, then writes the scripts, then THE USER double-clicks them. '
        + 'The result carries a `tellUser` block and an `agentMustSay` line — **you must state that instruction to the user in your reply; do not merely leave it in the tool result.** Re-exporting is idempotent and only touches a `_dsh/` subdirectory. '
        + 'The generated PowerShell encodes the hard-won rules: four-state start (cold / hot-restart / wait-while-starting / clear-zombie) so a second click never fights over session.lock, process identification by command line instead of process name, readiness by a real connect instead of log parsing, RCON graceful stop before any force-kill, and the PowerShell 5.1 traps (BOM, execution policy, no Start-Process redirection). '
        + '**A command window is required.** The plugin refuses to export one that does not cover it, because with the server running outside a visible window there would be no place at all to type a command (and no way to give yourself OP). The plugin deliberately does NOT ship a fixed console — the control channel differs per service and per edition (Minecraft Bedrock has no RCON), so you generate it for the service in front of you and pass it here as `extra_files` with `role: "control-window"`; the rules and a reference implementation are in the `dsh-openfrp-handoff` skill.',
      parameters: {
        id: { type: 'string', required: true, description: 'Service id.' },
        dir: { type: 'string', description: 'Where to write the scripts. Defaults to <service dir>/_dsh.' },
        proxy_id: { type: 'number', description: 'Tunnel id to bake into the tunnel scripts. Defaults to the one recorded for this service.' },
        memory: { type: 'string', description: "Heap for the generated start script, e.g. '2G'." },
        boot_wait_seconds: { type: 'number', description: 'Readiness guard. Formula: 2-3x this kind of service\'s cold-start time — vanilla MC binds its port in ~9-12s, a 110-mod Fabric pack needs 40-60s, so the default is 180.' },
        extra_files: {
          type: 'array',
          description: 'Files YOU generated for this service, written verbatim into the export directory. The command/control window goes here (mark it role="control-window"). Shape: [{ path: "控制台.bat", content: "...", role: "control-window", note: "..." }]. '
            + 'Read the dsh-openfrp-handoff skill first for the rules and a reference RCON implementation, and adapt it to THIS service\'s control channel — do not copy a fixed console, and re-derive it if the server version or edition changes.',
        },
        control_window_not_needed: { type: 'boolean', description: 'Set true only when this service genuinely has no command channel to expose (e.g. a plain HTTP service). Otherwise a command window is required and the export is refused without one.' },
        force: { type: 'boolean', description: 'Export even when the order is wrong (a verification instance is still running, no tunnel record yet, or no command window supplied). Those cases produce a hand-off the user may act on prematurely, so they are refused by default.' },
      },
      output: OUTPUT,
      execute: guarded(args => actions.serviceExportScripts(resolveRuntime(), {
        id: args.id,
        dir: args.dir,
        proxyId: args.proxyId,
        memory: args.memory,
        bootWaitSeconds: args.bootWaitSeconds,
        extraFiles: args.extraFiles,
        controlWindowNotNeeded: args.controlWindowNotNeeded === true,
        force: args.force === true,
      })),
    },

    // ── Exposure ────────────────────────────────────────────
    {
      name: 'openfrp_expose',
      description: 'Put a local service on the public internet through OpenFrp and return the address to give players, or take it back down. action=up picks the tunnel whose local port matches the service (or creates one when auto_create is true), REFUSES to start a tunnel that is already online, waits for frpc to report the public address, and records it. action=down stops only the frpc the plugin started — it never touches the user\'s other tunnels, so the official launcher keeps working alongside.',
      parameters: {
        action: { type: 'string', enum: ['up', 'down'], required: true, description: 'up = start, down = stop.' },
        id: { type: 'string', description: 'Service id.' },
        proxy_id: { type: 'number', description: 'Explicit tunnel id to start (up) or stop (down).' },
        auto_create: { type: 'boolean', description: 'When no tunnel matches the port, create one automatically (picks a node itself).' },
        node_id: { type: 'number', description: 'For auto-create: force a specific node instead of the automatic pick (use openfrp_tunnel action=nodes to choose). Real-name-verified accounts get the closest region first by default, not the highest bandwidth.' },
        mode: { type: 'string', description: 'For auto-create: tcp (default, needed for Minecraft) or udp/http/https.' },
        wait_ms: { type: 'number', description: 'How long to wait for the public address (default 90000).' },
      },
      output: OUTPUT,
      execute: guarded(async args => {
        const runtime = resolveRuntime();
        return args.action === 'down'
          ? actions.exposeDown(runtime, { id: args.id, proxyId: args.proxyId })
          : actions.exposeUp(runtime, {
            id: args.id,
            proxyId: args.proxyId,
            autoCreate: args.autoCreate === true,
            mode: args.mode ?? 'tcp',
            nodeId: args.nodeId ?? null,
            waitMs: args.waitMs,
          });
      }),
    },

    // ── Diagnosis ───────────────────────────────────────────
    {
      name: 'openfrp_diagnose',
      description: 'Correlate the service, the tunnel and the OpenFrp API into findings that each carry their evidence (the exact log line, exit code or API field). Use this before telling the user anything is wrong: it exists so the agent can say "the tunnel\'s local_port is 25566 but the server bound 25565" instead of "it might be a port problem".',
      parameters: { id: { type: 'string', required: true, description: 'Service id.' } },
      output: OUTPUT,
      execute: guarded(args => actions.diagnose(resolveRuntime(), args)),
    },
    {
      name: 'openfrp_environment',
      description: 'Report the environment facts the other tools depend on: platform, whether an frpc binary was found and its version, where the plugin caches downloads, and a free local port. Call it once when something behaves unexpectedly (missing frpc, version mismatch).',
      parameters: {},
      output: OUTPUT,
      execute: guarded(() => actions.environmentInfo(resolveRuntime())),
    },
  ];
}
