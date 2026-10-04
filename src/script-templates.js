/**
 * dsh-openfrp — the hand-off script templates.
 *
 * ## Why this module exists
 *
 * A long-running service must NOT be owned by DSH. Measured (report v2 §2.1):
 * DSH child processes die when the host restarts — both a background job **and**
 * `Start-Process` were gone after a restart. So "DSH holds the server for you"
 * is never a valid design; it only hides the problem until the user closes DSH
 * and the server vanishes.
 *
 * The correct division of labour, verified in the field:
 *
 *   ① DSH configures the service (EULA, properties, ports, RCON)
 *   ② DSH starts it once to verify the whole chain
 *   ③ DSH exports start/stop scripts into the service directory
 *   ④ **DSH tells the user: from now on, double-click this**
 *   ⑤ The user runs it; DSH only attaches, observes and commands
 *
 * These templates are that deliverable. They deliberately hard-code the
 * hard-won lessons so the user's script does not have to rediscover them:
 *
 *  - **Four-state machine.** Cold / hot-restart / starting / zombie. The gap in
 *    the user's own `restart-server.ps1` was "starting": clicking again while the
 *    server loads starts a second copy and both fight over `session.lock`.
 *  - **`session.lock` is always present.** The file existing means nothing; only
 *    "can the lock be acquired" matters, and that can only be inferred from
 *    process state — never from `Test-Path session.lock`.
 *  - **Readiness threshold formula.** Vanilla MC 26.2 binds its port ~9–12 s
 *    after launch; a 110-mod Fabric pack takes 40–60 s. So the guard is 2–3×
 *    that, default 180 s.
 *  - **Process identification order.** By PID, then by command line
 *    (`*server.jar*`, `*-p <proxyId>*`), then fuzzy name. Exact name matching
 *    fails: the real frpc process is `frpc_windows_amd64`, so `Get-Process frpc`
 *    reports zero forever.
 *  - **Readiness by real request.** "Connect once" beats "port is listening",
 *    which beats "parse the log". Logs are evidence *after* a failure, not a
 *    precondition for success.
 *  - **Graceful stop first.** Control channel (RCON `stop`) → wait → force kill.
 *  - **PowerShell 5.1 traps.** UTF-8 **with BOM** (no BOM ⇒ mojibake and syntax
 *    errors); `-ExecutionPolicy Bypass` in the `.bat`; never
 *    `Start-Process -RedirectStandardOutput` (it rebuilds an env dictionary that
 *    already has both `NO_PROXY` and `no_proxy` and throws); JVM args as an array
 *    then splatted (inline `-Dfoo=bar` gets split and java reads it as the main
 *    class).
 *
 * @module dsh-openfrp/script-templates
 */

/** Files we own inside the service directory. */
export const EXPORT_DIR_NAME = '_dsh';


/** The one line the agent must relay to the user. Built per export. */
export function userInstruction({ dir, startFile, stopFile, consoleFiles = [], publicAddress }) {
  return [
    '════════ 请把下面这段话告诉用户（不要只贴在结果里，要明确说出来）════════',
    '',
    `以后要开服，**双击这个文件**：${dir}\\${startFile}`,
    `要关服，双击：${dir}\\${stopFile}`,
    ...(consoleFiles.length > 0
      ? [`**要敲指令**（给自己 OP、查玩家、改天气），双击：${consoleFiles.map(f => `${dir}\\${f}`).join(' 或 ')}`]
      : ['⚠️ 指令控制窗口还没生成 —— 服务端不在前台窗口里跑时就没有地方敲指令，我会补上。']),
    publicAddress === '' || publicAddress === null
      ? '（外网地址会在启动后由脚本打印出来）'
      : `外网地址（固定在脚本里，重启 DSH 也不会变）：${publicAddress}`,
    '',
    '⚠️ **进游戏后想用 / 开头的指令，必须先给自己 OP。**',
    ...(consoleFiles.length > 0
      ? [`   打开 ${consoleFiles[0]}，然后输入：op <你的游戏ID>`]
      : ['   让 DSH 用 service_exec 发：op <你的游戏ID>']),
    '   不给自己 OP 的话，任何人进服都只是普通玩家，一条指令都用不了。',
    '',
    '请**亲手双击打开一次**，然后回我一句「已打开」—— 在你回报之前，我不会去建隧道。',
    '',
    '为什么必须你自己点：DSH 启动的进程会随 DSH 一起结束，所以服务器不能由 DSH 托管。',
    '由你双击启动的服务器不受 DSH 开关影响。DSH 仍然可以读它的日志、发命令、排查问题。',
    '════════════════════════════════════════════════════════════════════',
  ].join('\n');
}

const psHeader = (title, purpose) => `<#
  ${title}
  ${purpose}

  本文件由 dsh-openfrp 生成（可重复导出覆盖）。手改前请先看同目录的 README.md。
  重要：本文件必须保存为 UTF-8 带 BOM，否则 PowerShell 5.1 会把中文读成乱码甚至报语法错。
#>
`;

/**
 * Build every file for one service export.
 *
 * @param {object} ctx
 * @param {string} ctx.root Service directory
 * @param {string} ctx.port Local port the service listens on
 * @param {string} ctx.rconPort
 * @param {string} ctx.rconPasswordRef how the generated script should get the password
 * @param {number|null} ctx.proxyId
 * @param {string} ctx.publicAddress
 * @param {string} ctx.frpcPath
 * @param {string} ctx.startCommand the detected way to launch the service
 * @param {string} ctx.startPlanKind 'script' | 'java-jar'
 * @param {string} ctx.existingStartScript relative path when kind === 'script'
 * @param {string} ctx.javaPath
 * @param {string} ctx.memory
 * @param {Array<{path:string, content:string, note?:string}>} [ctx.extraFiles]
 *   Files **DSH generated for this service** (typically the command/control
 *   window). They are written verbatim into `_dsh/`. The plugin does not ship a
 *   fixed console: the control channel differs per service and per edition
 *   (Minecraft Bedrock has no RCON at all), so the content has to be derived for
 *   the service actually in front of you. The plugin's job is to make sure the
 *   step is never skipped — see `service_export_scripts`' control-window check.
 * @returns {Array<{path:string, content:string, note:string}>}
 */
export function buildExportFiles(ctx) {
  const {
    port, rconPort, proxyId, publicAddress, frpcPath,
    startPlanKind, existingStartScript, javaPath, memory = '2G', bootWaitSeconds = 180,
    extraFiles = [],
  } = ctx;

  const launchService = startPlanKind === 'script' && existingStartScript !== ''
    // Never re-invent a launch the user already worked out; a Fabric modpack must
    // use its own launcher (`-cp _launch Launch`), not `java -jar`.
    ? `& (Join-Path $Root '${existingStartScript}')`
    : `$jvm = @('-Xms${memory}', '-Xmx${memory}', '-XX:+UseG1GC', '-jar', $ServerJar, 'nogui')\n& $Java @jvm   # 数组 + splat：内联的 -D 参数会被拆开，java 会把它当主类`;

  return [
    {
      path: 'start-server.ps1',
      note: '四态状态机 + 世界锁规避 + 就绪等待',
      content: `${psHeader('start-server.ps1 — 启动服务端', '四态：冷启动 / 热重启 / 启动中等待 / 僵尸清理')}
param(
  [int]$Port = ${port},
  # -Memory 与 -Java 只在"本脚本自己启动 java"时生效（见文件末尾的分支）。
  # 如果走的是你自己已有的启动脚本，这些参数不会传给它 —— 那个脚本的参数由它自己决定。
  [string]$Memory = '${memory}',
  [string]$Java = '${javaPath}',
  # 就绪保护期。公式：这类服务冷启动耗时的 2-3 倍。
  # 实测参考：原版 MC 26.2 约 9-12 秒绑定端口；110 个 mod 的 Fabric 包要 40-60 秒。
  [int]$BootWaitSeconds = ${bootWaitSeconds}
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$ServerJar = Join-Path $Root 'server.jar'

function Test-PortListening([int]$p) {
  try { return (New-Object Net.Sockets.TcpClient).ConnectAsync('127.0.0.1', $p).Wait(500) } catch { return $false }
}

# ══════════════════════════════════════════════════════════════════════
#  世界锁（session.lock）规避 —— 本脚本的第一职责不是"启动"，而是
#  "先确认没有别的写者"。
#
#  机制：服务端启动时对世界目录的 session.lock 加**独占文件锁**，拿不到就启动失败。
#  关键：这个文件**平时就存在**（不是"有文件=被锁"），
#        所以**不能**用 Test-Path session.lock 判断，
#        只能靠**进程状态**判断。
#
#  两种撞锁方式，都在下面被拦掉：
#    ② 在跑的还没停就起新的   → 下面 $listening 分支：先优雅停
#    ③ 启动中的被当成没跑，又起一个 → 下面 $procs 分支的"启动中"：等它就绪，绝不另起
#  （卡死/超时的实例同样持锁 → 那就是"僵尸"，必须清）
#
#  通用规则：同一份可变数据（世界/存档/数据库）任一时刻只能有一个写者。
# ══════════════════════════════════════════════════════════════════════

# ── 进程识别（§5.4）：按 PID > 按命令行特征 > 模糊名字 ───────────────
# 不要用 Get-Process <精确名>：真实名字可能带后缀（frpc_windows_amd64），会永远查不到。
function Get-ServiceProcesses {
  Get-CimInstance Win32_Process -Filter "Name like '%java%'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*server.jar*' -or $_.CommandLine -like '*_launch*' }
}

$procs = @(Get-ServiceProcesses)
$listening = Test-PortListening $Port

if ($listening) {
  # ② 热重启：端口在听 → 先优雅停，再启动（跳过就会"以为重启了其实没换配置"）
  Write-Host '[重启] 端口 '$Port' 已在监听，先优雅停止现有实例…' -ForegroundColor Yellow
  & (Join-Path $Root 'stop-server.ps1') -Port $Port
  Start-Sleep -Seconds 3
} elseif ($procs.Count -gt 0) {
  $age = (New-TimeSpan -Start $procs[0].CreationDate).TotalSeconds
  if ($age -lt $BootWaitSeconds) {
    # ③ 启动中：绝不另起 —— 另起会抢 session.lock，两个都玩不转
    Write-Host ('[等待] 检测到实例正在启动中（已 ' + [int]$age + ' 秒），等它就绪，不重复启动…') -ForegroundColor Cyan
    $deadline = (Get-Date).AddSeconds($BootWaitSeconds)
    while ((Get-Date) -lt $deadline) {
      if (Test-PortListening $Port) { Write-Host '[就绪] 服务端已监听，未重复启动。' -ForegroundColor Green; exit 0 }
      Start-Sleep -Seconds 2
    }
    Write-Host '[超时] 等了 '$BootWaitSeconds' 秒仍未监听，请查看 logs\\latest.log。' -ForegroundColor Red
    exit 1
  }
  # ④ 僵尸：没在听、进程又很老（卡死/超时的实例同样持锁）→ 清掉再启动
  Write-Host ('[清理] 发现僵死实例（PID ' + $procs[0].ProcessId + '，已 ' + [int]$age + ' 秒），先清掉…') -ForegroundColor Yellow
  $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
}

# ① 冷启动
if (-not $Java -or -not (Test-Path $Java)) {
  $Java = (Get-Command java -ErrorAction SilentlyContinue).Source
}
if (-not $Java) { Write-Host '[错误] 找不到 Java。MC 26.x 需要 Java 25+。' -ForegroundColor Red; exit 1 }
if (-not (Test-Path $ServerJar)) { Write-Host ('[错误] 找不到 ' + $ServerJar) -ForegroundColor Red; exit 1 }

Write-Host '[启动] 正在启动服务端…' -ForegroundColor Green
# 注意：不要用 Start-Process 的 -RedirectStandardOutput。
# PowerShell 5.1 在带重定向时会重建环境字典，而本机同时存在 NO_PROXY 与 no_proxy，
# 会抛 "Item has already been added. Key: 'NO_PROXY'"。让服务端自己写 logs\\latest.log 即可。
${launchService}

Write-Host ('[就绪] 服务端退出。日志：' + (Join-Path $Root 'logs\\latest.log'))
`,
    },
    {
      path: 'stop-server.ps1',
      note: 'RCON 优雅停 → 超时强杀 → 僵尸清理',
      content: `${psHeader('stop-server.ps1 — 优雅停止服务端', '控制通道优先，强杀只作兜底')}
param(
  [int]$Port = ${port},
  [int]$RconPort = ${rconPort},
  [string]$RconPassword = '',
  [int]$GraceSeconds = 30
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot

# 密码来源：同目录的 rcon-password.txt（由服务端配置生成，不进脚本、不进版本库）
if (-not $RconPassword) {
  $pwFile = Join-Path $Root 'rcon-password.txt'
  if (Test-Path $pwFile) { $RconPassword = (Get-Content $pwFile -Raw).Trim() }
}

function Invoke-Rcon([string]$Command) {
  if (-not $RconPassword) { return $null }
  $client = New-Object Net.Sockets.TcpClient
  try {
    $client.Connect('127.0.0.1', $RconPort)
    $stream = $client.GetStream()
    function Send-Packet([int]$id, [int]$type, [string]$body) {
      $bodyBytes = [Text.Encoding]::ASCII.GetBytes($body)
      $len = 4 + 4 + $bodyBytes.Length + 2
      $buf = New-Object 'System.Collections.Generic.List[byte]'
      $buf.AddRange([BitConverter]::GetBytes([int]$len))
      $buf.AddRange([BitConverter]::GetBytes([int]$id))
      $buf.AddRange([BitConverter]::GetBytes([int]$type))
      $buf.AddRange($bodyBytes)
      $buf.Add(0); $buf.Add(0)
      $bytes = $buf.ToArray()   # 不要用 + 拼数组：单元素数组会被解包成标量
      $stream.Write($bytes, 0, $bytes.Length); $stream.Flush()
    }
    Send-Packet 1 3 $RconPassword
    Start-Sleep -Milliseconds 120
    Send-Packet 2 2 $Command
    Start-Sleep -Milliseconds 300
    $read = New-Object byte[] 4096
    $n = $stream.Read($read, 0, 4096)
    return [Text.Encoding]::ASCII.GetString($read, 0, [Math]::Max(0, $n))
  } catch {
    return $null
  } finally { $client.Close() }
}

Write-Host '[停止] 通过 RCON 请求优雅停止（会存档、刷盘）…' -ForegroundColor Yellow
$reply = Invoke-Rcon 'stop'
if ($null -eq $reply) { Write-Host '  RCON 不可用（未开或密码不对），将直接结束进程。' -ForegroundColor DarkYellow }

# 等它自己退出；控制通道能解决的就不要强杀（可能丢最近变更）
$deadline = (Get-Date).AddSeconds($GraceSeconds)
while ((Get-Date) -lt $deadline) {
  $still = @(Get-CimInstance Win32_Process -Filter "Name like '%java%'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*server.jar*' -or $_.CommandLine -like '*_launch*' })
  if ($still.Count -eq 0) { Write-Host '[完成] 服务端已自行退出。' -ForegroundColor Green; exit 0 }
  Start-Sleep -Seconds 1
}

Write-Host '[兜底] 超时未退出，强制结束。' -ForegroundColor Red
Get-CimInstance Win32_Process -Filter "Name like '%java%'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*server.jar*' -or $_.CommandLine -like '*_launch*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Write-Host '[完成] 已强制结束。' -ForegroundColor Green
`,
    },
    {
      path: 'start-tunnel.ps1',
      note: '起 frpc；就绪 = 真实连一次公网地址',
      content: `${psHeader('start-tunnel.ps1 — 启动隧道', '就绪判定用真实连接，而不是解析日志')}
param(
  [int]$ProxyId = ${proxyId ?? 0},
  [string]$Token = '',
  [string]$Frpc = '${frpcPath}',
  [string]$PublicAddress = '${publicAddress}',
  [int]$WaitSeconds = 30
)

$ErrorActionPreference = 'Stop'

if (-not $Token) {
  # 令牌不写进脚本：运行时从插件凭据里读
  $cred = Join-Path $env:USERPROFILE '.dsh\\dsh-openfrp\\credentials.json'
  if (Test-Path $cred) { $Token = (Get-Content $cred -Raw | ConvertFrom-Json).token }
}
if (-not $Token) { Write-Host '[错误] 拿不到用户 token（先让 DSH 登录 OpenFrp）。' -ForegroundColor Red; exit 1 }
if (-not $ProxyId) { Write-Host '[错误] 没指定隧道 id（-ProxyId）。' -ForegroundColor Red; exit 1 }
if (-not (Test-Path $Frpc)) { Write-Host ('[错误] 找不到 frpc：' + $Frpc) -ForegroundColor Red; exit 1 }

# 按命令行特征识别"我们这条隧道的 frpc"，不要按进程名（真实名字是 frpc_windows_amd64）
$mine = @(Get-CimInstance Win32_Process -Filter "Name like '%frpc%'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like ('*-p ' + $ProxyId + '*') -or $_.CommandLine -like ('*-p ' + $ProxyId + ',*') })
if ($mine.Count -gt 0) { Write-Host ('[已在运行] frpc PID ' + $mine[0].ProcessId) -ForegroundColor Cyan; exit 0 }

Write-Host '[启动] 正在启动 frpc…' -ForegroundColor Green
Start-Process -FilePath $Frpc -ArgumentList @('-u', $Token, '-p', "$ProxyId", '--disable-log-color', '--noupdate') -WindowStyle Hidden

# 就绪判定（§5.5）：最优 = 对服务做一次真实的最小请求；次优 = 等端口；最差 = 解析日志。
# 日志只用来当失败后的证据。
if ($PublicAddress) {
  $host_, $port_ = $PublicAddress.Split(':')
  Write-Host ('[等待] 真的连一次 ' + $PublicAddress + ' …') -ForegroundColor Cyan
  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $c = New-Object Net.Sockets.TcpClient
      if ($c.ConnectAsync($host_, [int]$port_).Wait(1500)) { $c.Close(); Write-Host ('[就绪] 隧道已通：' + $PublicAddress) -ForegroundColor Green; exit 0 }
      $c.Close()
    } catch { }
    Start-Sleep -Seconds 1
  }
  Write-Host '[超时] 公网地址还连不上。用 debug-tunnel.ps1 前台跑 frpc 看输出。' -ForegroundColor Red
  exit 1
}
Write-Host '[完成] frpc 已启动（没有公网地址可比对，无法自动确认就绪）。' -ForegroundColor Green
`,
    },
    {
      path: 'stop-tunnel.ps1',
      note: '只杀本隧道那条 frpc',
      content: `${psHeader('stop-tunnel.ps1 — 停止隧道', '只按 -p <proxyId> 精确匹配，绝不打一片')}
param([int]$ProxyId = ${proxyId ?? 0})

$ErrorActionPreference = 'Stop'
if (-not $ProxyId) { Write-Host '[错误] 没指定隧道 id（-ProxyId）。' -ForegroundColor Red; exit 1 }

# 只杀命令行里带这条隧道 id 的 frpc。
# 反例（要避免）：taskkill /IM frpc.exe —— 会把官方启动器在用的其它隧道一起打死。
$mine = @(Get-CimInstance Win32_Process -Filter "Name like '%frpc%'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like ('*-p ' + $ProxyId + '*') })

if ($mine.Count -eq 0) { Write-Host '[无需操作] 没找到这条隧道的 frpc。' -ForegroundColor Cyan; exit 0 }
$mine | ForEach-Object { Write-Host ('[停止] frpc PID ' + $_.ProcessId) -ForegroundColor Yellow; Stop-Process -Id $_.ProcessId -Force }
Write-Host '[完成] 已停止本隧道。其它隧道不受影响。' -ForegroundColor Green
`,
    },
    {
      path: 'start-all.ps1',
      note: '先起隧道（独立进程）→ 前台跑服务端 → 打印可连地址',
      content: `${psHeader('start-all.ps1 — 一键开服 + 开隧道', '入口层，与实现解耦')}
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot

# 顺序很重要：start-server.ps1 是**前台**运行（关窗口 = 停服），
# 所以隧道脚本必须在它**之前**以独立进程起起来；
# 否则「起服务端」这一行会一直占着，后面的隧道脚本永远不会执行。
$tunnelScript = Join-Path $Root 'start-tunnel.ps1'
Write-Host '[1/2] 启动隧道（另开一个最小化窗口）…' -ForegroundColor Cyan
Start-Process -FilePath 'powershell' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $tunnelScript) -WindowStyle Minimized

Write-Host ''
Write-Host '  ════════ 把下面这个地址发给要联机的朋友 ════════' -ForegroundColor Green
${publicAddress === '' || publicAddress === null
    ? "Write-Host '  （本次导出时隧道还没有公网地址 —— 让 DSH 建好隧道记录后重新导出一次）' -ForegroundColor Yellow"
    : `Write-Host '  ${publicAddress}' -ForegroundColor Green`}
Write-Host '  ═════════════════════════════════════════════' -ForegroundColor Green
Write-Host ''

Write-Host '[2/2] 启动服务端（前台运行）…' -ForegroundColor Green
Write-Host '      ⚠️ 本窗口要一直开着；关掉本窗口 = 服务端停止。' -ForegroundColor Yellow
Write-Host ''
& (Join-Path $Root 'start-server.ps1')

Write-Host ''
Write-Host '  服务端已退出。' -ForegroundColor Yellow
`,
    },
    {
      path: 'stop-all.ps1',
      note: '先关隧道再关服',
      content: `${psHeader('stop-all.ps1 — 一键关服', '先断公网入口，再优雅停服')}
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot

& (Join-Path $Root 'stop-tunnel.ps1')
& (Join-Path $Root 'stop-server.ps1')
Write-Host '[完成] 隧道与服务端都已停止。' -ForegroundColor Green
`,
    },
    {
      path: 'debug-tunnel.ps1',
      note: '前台跑 frpc 看输出（后台看不到输出的补偿）',
      content: `${psHeader('debug-tunnel.ps1 — 前台看隧道日志', '隧道连不上时的第一手段')}
param([int]$ProxyId = ${proxyId ?? 0}, [string]$Frpc = '${frpcPath}')

$Root = $PSScriptRoot
$Token = ''
$cred = Join-Path $env:USERPROFILE '.dsh\\dsh-openfrp\\credentials.json'
if (Test-Path $cred) { $Token = (Get-Content $cred -Raw | ConvertFrom-Json).token }
if (-not $Token) { Write-Host '[错误] 拿不到 token。' -ForegroundColor Red; exit 1 }

Write-Host '前台运行 frpc（Ctrl+C 结束）。下面每一行就是隧道自己的说法。' -ForegroundColor Cyan
& $Frpc -u $Token -p "$ProxyId" --disable-log-color --noupdate
`,
    },
    {
      path: '启动.bat',
      note: '双击壳（带执行策略绕过）',
      // NOTE: .bat content is deliberately ASCII-only. cmd.exe reads batch files
      // byte-wise and a UTF-8 BOM shows up as stray characters, so only the
      // .ps1/.md files get a BOM.
      content: `@echo off
chcp 65001 >nul
cd /d "%~dp0"
:: This machine's .ps1 files are blocked by the execution policy,
:: so the -ExecutionPolicy Bypass flag is required here.
::
:: KEEP THIS WINDOW OPEN. The server runs in the FOREGROUND of this window,
:: so closing it stops the server.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-all.ps1"
echo.
echo Server stopped. This window can be closed now.
pause >nul
`,
    },
    {
      path: '停止.bat',
      note: '双击壳',
      content: `@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-all.ps1"
echo.
pause >nul
`,
    },
    {
      path: 'README.md',
      note: '用法 + 三个"别优化掉"的坑',
      content: `# ${EXPORT_DIR_NAME} — 由 dsh-openfrp 生成的启停脚本

## 怎么用

| 我要… | 双击 |
|---|---|
| 开服（含隧道） | \`启动.bat\` |
| 关服（含隧道） | \`停止.bat\` |
${(ctx.extraFiles ?? []).filter(f => f !== null && typeof f === 'object' && f.role === 'control-window').map(f => f.path).length > 0
    ? '| **敲指令**（给自己 OP、查玩家、改天气、看 TPS） | **'
      + (ctx.extraFiles ?? []).filter(f => f !== null && typeof f === 'object' && f.role === 'control-window')
        .map(f => '`' + f.path + '`').join(' / ')
      + '** |'
    : '| 敲指令 | 让 DSH 用 `service_exec` 代发（本次没有生成指令控制窗口） |'}
| 隧道连不上，想看它到底说了什么 | \`debug-tunnel.ps1\`（前台运行） |

### 关于指令控制窗口

服务端**不在前台窗口里跑**的时候（用启动器起的、后台起的、或者前台窗口被关了），
你需要一个地方敲指令。这个东西**由 DSH 按你手上这个服务来生成**，不是插件里写死的。

- 它走服务的**控制通道**（Minecraft Java 是 RCON；**基岩版没有 RCON，必须换别的通道**），
  所以和"谁持有进程"无关 —— 不管服务端是谁启动的、前台还是后台，都能用。
- 生成要求写在技能 \`dsh-openfrp-handoff\` 里（含一个可改造的 RCON 参考实现）：
  **端口与密码运行时从 \`server.properties\` 读**、**\`.bat\` 在 \`chcp\` 之后不得出现非 ASCII**、
  **登录完成前到达的指令要排队后补发**。
- 如果你换了服务端版本/端，DSH 应该重新生成它，而不是照抄上一份。

### ⚠️ 进游戏后要能用 \`/\` 指令，必须先给自己 OP

**默认 \`ops.json\` 是空的 —— 谁进来都只是普通玩家，一条 \`/\` 指令都用不了。**

在指令控制窗口里输入：

\`\`\`
op 你的游戏ID
\`\`\`

（也可以让 DSH 用 \`service_exec\` 发这条指令。权限等级由 \`op-permission-level\` 决定，默认 4。）

**为什么要你自己双击**：DSH 启动的进程会随 DSH 一起结束（实测：DSH 重启后，后台任务与
\`Start-Process\` 起的进程都不在了）。由你双击启动的服务器不受 DSH 开关影响；
DSH 依然可以读它的日志、发命令、排查问题。

## 参数只在一处

| 想改什么 | 改哪里 |
|---|---|
| 本地端口 | \`start-server.ps1\` 的 \`-Port\` |
| 内存 / GC | \`start-server.ps1\` 的 \`-Memory\` |
| Java 路径 | \`start-server.ps1\` 的 \`-Java\` |
| 服务端版本 | **只换 \`server.jar\`，脚本一行都不用动** |
| 换隧道 | \`-ProxyId\`；公网地址从插件记录取，不硬编码 |

## 三个"别优化掉"的坑

1. **启动中不要另起一个。** 服务端在加载时再点一次，会起第二个实例抢 \`session.lock\`，
   两个都玩不转。脚本里的"启动中 → 等它就绪"就是补这个缺口。
2. **\`session.lock\` 平时就存在**，不是"有文件=被锁"。
   能不能拿到锁只能从**进程状态**判断，**不要**用 \`Test-Path session.lock\`。
3. **别用 \`Start-Process -RedirectStandardOutput\`。** PowerShell 5.1 在带重定向时会重建
   环境字典，而本机同时有 \`NO_PROXY\` 和 \`no_proxy\`，会抛
   \`Item has already been added. Key: 'NO_PROXY'\`。让服务端自己写 \`logs/latest.log\` 就行。

## 世界锁（\`session.lock\`）与四态判定

服务端启动时对世界目录加**独占文件锁**。谁先拿到谁能跑，另一个直接启动失败。
所以启动脚本的第一职责**不是"启动"，而是"先确认没有别的写者"**。四个状态：

| 状态 | 怎么判定 | 正确动作 | 做错的后果 |
|---|---|---|---|
| **① 冷启动** | 端口没听 + 没有进程 | 直接启动 | — |
| **② 热重启** | **端口在听** | 先优雅停，再启动 | 跳过 → 你以为重启了，其实没换配置 |
| **③ 启动中** | 端口没听，但**进程很年轻** | **等它就绪，绝不另起** | 另起 → 抢锁，两个都玩不转 |
| **④ 僵尸** | 端口没听，进程**很老** | 清掉再启动 | 不清 → 它一直占着锁，下次开服必失败 |

**"年轻"的阈值**：取这类服务冷启动耗时的 **2–3 倍**，本脚本默认 180 秒。
实测参考：原版 MC 26.2 约 9–12 秒绑定端口；110 个 mod 的 Fabric 包要 40–60 秒。

**怎么认进程**（顺序很重要）：① 按 PID；② 按**命令行特征**（\`*server.jar*\` / \`*_launch*\`，
最可靠，也能把游戏客户端排除掉）；③ 模糊进程名。
**不要**用精确进程名 —— 真实名字常常带后缀（例如 frpc 的进程名是 \`frpc_windows_amd64\`，
\`Get-Process frpc\` 会永远查不到，得出"没在跑"的**假阴性**）。

## 与 DSH 插件的关系

- 插件**不会**去动这些脚本启动的进程之外的任何东西；它只挂靠、观测、发命令。
- 插件自己启动 frpc 时只拥有**它启动的那一条**隧道，不会碰官方启动器在用的隧道。
- **同一条隧道不要两边同时开**，否则会 \`proxy conflict\`。

## 文件必须 UTF-8 带 BOM

PowerShell 5.1 读无 BOM 的 UTF-8 会按 ANSI 解码，中文注释会乱码甚至报语法错。
用记事本"另存为 → UTF-8"时请确认带 BOM；本目录下的文件由插件生成，已带 BOM。
`,
    },

    // Everything DSH generated for this service (typically the command window).
    // Appended last so the fixed scripts above keep stable positions, and written
    // verbatim — the plugin does not second-guess content it did not author.
    ...extraFiles
      .filter(file => file !== null && typeof file === 'object' && typeof file.path === 'string' && file.path !== '')
      .map(file => ({
        path: file.path,
        content: typeof file.content === 'string' ? file.content : '',
        note: typeof file.note === 'string' && file.note !== '' ? file.note : '由 DSH 为该服务生成',
        // Marks a file we did not author: written byte-for-byte, no BOM added.
        // The BOM rule exists for OUR PowerShell templates; a file DSH wrote for
        // this particular service already has whatever encoding it needs.
        generated: true,
      })),
  ];
}
