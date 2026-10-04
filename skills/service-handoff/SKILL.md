---
name: dsh-openfrp-handoff
description: 长跑服务的"脚本交接"方法论：DSH 配好并验证一次，然后把启停脚本交给用户自己双击，因为 DSH 启动的进程活不过宿主重启。含五条与版本/端无关的通用规则（可变状态锁、四态判定、进程识别顺序、就绪判定层级、优雅停止顺序）以及每一条在换服务端版本、换 Java/基岩版、换非 MC 服务时如何重新实例化。用于任何"要长期开着的本地服务 + 公网暴露"的编排。
whenToUse: 用户要开一个要长期跑的服务（游戏服、Web、数据库）、说"帮我开服"、问为什么 DSH 关了服务就没了、或需要生成启停脚本交给用户时使用。
---

# 长跑服务的脚本交接

## 一句话

**DSH 不该持有长跑进程。** 实测：DSH 重启后，`run_in_background` 起的和 `Start-Process` 起的进程**都不在了**。
只有**用户自己启动**的进程不受 DSH 开关影响。

所以正确分工是：

```
① DSH 把服务配好          （EULA、配置、端口、控制通道）
② DSH 起一次做验证         （确认真能开、能连、隧道通、端到端可达）
③ DSH 把启停脚本导出到服务目录，并告知用户
④ 用户自己双击；DSH 只负责挂靠 + 观测 + 控制，不持有进程
⑤ 出问题 DSH 照旧能读日志、发命令、诊断
```

`service_export_scripts` 生成的第 ③ 步产物是一个**具体实例**，不是规则本身。
**规则在下面，换任何服务都要用它们重新实例化一遍。**

---

## 五条通用规则（与版本、端、服务无关）

### 规则 1：同一份可变数据，任一时刻只能有一个写者

先问："**这个服务有没有一份不能被两个进程同时持有的东西？**" 那就是要保护的对象。

| 服务 | 要保护的东西 | 怎么保护 |
|---|---|---|
| Minecraft **Java 版** | 世界目录的 `session.lock`（**独占文件锁**） | 靠**进程状态**判断有没有别的写者 |
| Minecraft **基岩版（BDS）** | 世界目录本身（BDS 用目录独占，语义类似） | 同上：靠进程状态，不靠文件存在性 |
| SQLite / 大部分数据库 | 数据库文件锁 | 同上 |
| 只占端口的服务（Web 等） | **端口本身**就是互斥资源 | 端口被占=已有写者 |
| 不需要互斥的服务 | 无 | 跳过这条，但仍要判四态 |

> ⚠️ **最容易搞错的一点**：这类锁文件**平时就存在**（不是"有文件=被锁"）。
> **绝对不能**用 `Test-Path session.lock` 判断。只能从**进程状态**判断。

### 规则 2：四态判定 —— 先判状态，再决定动作

| 状态 | 怎么判定 | 正确动作 | 做错的后果 |
|---|---|---|---|
| **① 冷启动** | 端口没听 + 没有进程 | 直接启动 | — |
| **② 热重启** | **端口在听** | **先优雅停，再启动** | 跳过 → 用户以为重启了，其实没换配置 |
| **③ 启动中** | 端口没听，但**进程很年轻** | **等它就绪，绝不另起** | 另起 → 抢锁，两个都玩不转 |
| **④ 僵尸** | 端口没听，进程**很老** | 清掉再启动 | 不清 → 它一直占着锁，下次必失败 |

**"年轻"阈值 = 这类服务冷启动耗时的 2–3 倍。** 没有实测数据时先估：

| 服务 | 冷启动耗时量级 | 建议保护期 |
|---|---|---|
| 原版 MC Java | 9–12 秒绑定端口 | 60–180 秒 |
| 带 mod 的 MC（Forge/Fabric 整合包） | 40–60 秒（mod 越多越久） | 180–300 秒 |
| MC 基岩版 BDS | 通常 < 10 秒 | 60 秒 |
| 一般 Web / 数据库 | 秒级 | 60 秒 |

> 第 ③ 态是最容易漏的。用户自己写的重启脚本常常只做了 ①②④，**漏掉"启动中"**，
> 结果在服务端加载时再点一次就起了第二个实例，直接撞锁。

### 规则 3：进程识别顺序 —— PID > 命令行特征 > 模糊名

1. **按 PID**（你自己启动的，直接记 PID）
2. **按命令行特征** ← 最常用、最可靠。`*server.jar*`、`*-p <proxyId>*` 之类。
   它还能把"同类的其它进程"排除掉（例如游戏客户端的 java 命令行里没有 `server.jar`）
3. **模糊进程名**

> ❌ **绝不要用精确进程名匹配。** 实测踩过：真实 frpc 进程名是 `frpc_windows_amd64`，
> 而 `Get-Process frpc` 永远查不到 → 连续报了好几次"frpc 0 个进程"的**假阴性**，
> 结论直接建立在错误状态上。要按名字就用 `-like '*frp*'`。

### 规则 4：就绪判定层级 —— 真实请求 > 端口监听 > 解析日志

| 优先级 | 手段 | 说明 |
|---|---|---|
| **最优** | 对服务做**一次真实的最小请求** | MC 状态查询、HTTP `GET /`、TCP 连一次 |
| 次优 | 等**端口监听** | 通用，但对"端口开了、内部还没好"的服务不够 |
| 最差 | **解析日志文本** | 措辞会随版本/语言变，容易失效 |

> **日志适合当失败后的证据，不适合当成功的前置条件。**
> 实测教训：解析日志判就绪连挂两次；改成"真的去连一次"后一次通过，还顺带验证了链路。
> 如果非要用日志，**必须按本地实际版本核对措辞**（同一程序不同语言/版本会打不同的话）。

### 规则 5：优雅停止顺序 —— 控制通道 → 等 → 才强杀

| 手段 | 效果 | 何时用 |
|---|---|---|
| **控制通道**（MC 是 RCON `stop`） | 会存档、刷盘、玩家收到提示 | **首选** |
| 信号 / `Stop-Process` | 可能丢最近变更 | 兜底 |
| `taskkill /F /IM java.exe` | **会误杀同机其它 java** | **禁止** |

**换端时这条必须重新实例化**：MC **基岩版（BDS）没有 RCON**，
所以控制通道要换成别的（BDS 的 stdin、或第三方桥接），**不能照抄 Java 版的 `stop`**。
非 MC 服务就换成它的 HTTP shutdown / 信号。

---

### 规则 6：交接必须包含一个**指令控制窗口**（不能省）

服务端一旦**不在前台窗口里跑** —— 用启动器起的、后台起的、或前台窗口被关掉了 ——
用户就**没有任何地方能敲指令**了。这是交接本身的缺口，不是用户的错，必须补上。

**插件不会替你写死一个控制台**（因为它随服务与端而变），但**会拦住没有控制窗口的导出**：
`service_export_scripts` 会返回 `code: "control-window-missing"` 并拒绝导出。

你要做的是：**为手上这个服务生成一个控制窗口，然后用 `extra_files` 传进去**：

```
extra_files: [
  { path: '控制台.bat', content: '…', role: 'control-window' },
  { path: 'rcon-console.cjs', content: '…' },
]
```

**生成时必须满足的三条**（前两条是实测踩出来的）：

| # | 要求 | 为什么 |
|---|---|---|
| 1 | 端口与密码**运行时从配置文件读**，不硬编码 | 用户改密码后控制台不能失效 |
| 2 | `.bat` 里 **`chcp` 之后不得出现任何非 ASCII 字符** | cmd 会按新码页**重读批处理文件**，字节偏移错位，直接报 `The syntax of the command is incorrect`。所以 `.bat` 保持纯 ASCII，真正的内容放 `.cjs`/`.ps1` |
| 3 | 用管道喂 stdin 时，**登录完成前到达的指令必须排队、登录后补发** | `readline` 在 EOF 会立刻 `close`。不排队的话，自动化跑起来**连上了、什么都没发、直接退出** —— 人工双击永远看不出这个问题 |

**换端时要重新推导**：Minecraft Java 用 RCON；**基岩版没有 RCON**，得换 stdin 或第三方桥接；
纯 HTTP 服务用它的管理接口。**不要照抄上一份。**

#### 参考实现（RCON 版，按你的服务改造）

本机实测通过的一版，拿去改而不是直接抄：

```js
#!/usr/bin/env node
'use strict';
const fs = require('fs'); const net = require('net'); const path = require('path'); const readline = require('readline');

// ① 运行时从配置文件读，不硬编码
function readSettings() {
  const file = path.join(__dirname, 'server.properties');
  const map = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim(); if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('='); if (i === -1) continue;
    map[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  if (String(map['enable-rcon']).toLowerCase() !== 'true') { console.error('enable-rcon 不是 true，服务端没开 RCON'); process.exit(1); }
  return { host: '127.0.0.1', port: Number(map['rcon.port'] || 25575), password: map['rcon.password'] || '' };
}

// ② 组包：size 不含自身；body 后跟两个 0x00
function packet(id, type, body) {
  const p = Buffer.from(body, 'utf8');
  const b = Buffer.alloc(14 + p.length);
  b.writeInt32LE(10 + p.length, 0); b.writeInt32LE(id, 4); b.writeInt32LE(type, 8);
  p.copy(b, 12); b.writeInt8(0, 12 + p.length); b.writeInt8(0, 13 + p.length);
  return b;
}

const s = readSettings();
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let sock, authed = false, buf = Buffer.alloc(0), nextId = 1;
const pending = new Map();
// ③ 登录前到达的指令排队，不丢
const queued = []; let stdinClosed = false;

function sendExec(cmd) {
  const id = nextId++;
  return new Promise(res => {
    pending.set(id, { chunks: [], res });
    sock.write(packet(id, 2, cmd));
    // RCON 没有"响应结束"标记，短静默期就是协议惯例
    const e = pending.get(id);
    e.timer = setTimeout(() => { pending.delete(id); res(e.chunks.join('').replace(/\s+$/, '')); }, 300);
  });
}

function onPacket(id, type, body) {
  if (type === 2 && !authed) {                       // 认证响应
    if (id === -1) { console.error('RCON 认证失败：密码不对'); process.exit(1); }
    authed = true;
    console.log('已连接 ' + s.host + ':' + s.port);
    console.log('提示：进游戏后要能用 / 指令，先在这里输入  op <你的游戏ID>');
    for (const c of queued.splice(0)) void run(c);    // 补发排队指令
    return;
  }
  if (type === 0) { const e = pending.get(id); if (e) e.chunks.push(body); }  // 指令回显
}

function prompt() { if (stdinClosed) { sock.end(); return; } rl.question('> ', l => void run(l)); }

async function run(cmd) {
  const c = String(cmd || '').trim();
  if (!c) return prompt();
  if (c === 'exit' || c === 'quit') return sock.end();
  const reply = await sendExec(c);
  console.log(reply === '' ? '（无同步回显 —— 异步指令正常，去服务端日志看结果）' : reply);
  prompt();
}

sock = net.createConnection({ host: s.host, port: s.port }, () => sock.write(packet(1, 3, s.password)));
sock.on('data', chunk => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    if (buf.length < 4) return;
    const size = buf.readInt32LE(0);
    if (buf.length < 4 + size) return;
    onPacket(buf.readInt32LE(4), buf.readInt32LE(8), buf.toString('utf8', 12, 4 + size - 2));
    buf = buf.subarray(4 + size);
  }
});
sock.on('error', e => { console.error('连不上 RCON：' + e.message); process.exit(1); });
sock.on('close', () => process.exit(0));
rl.on('line', l => { if (!authed) { queued.push(l); return; } void run(l); });
rl.on('close', () => { stdinClosed = true; if (authed && pending.size === 0) sock.end(); });
```

`.bat` 壳（**纯 ASCII**，因为上面第 2 条）：

```bat
@echo off
chcp 65001 >nul
cd /d "%~dp0"
:: 注意：chcp 之后本文件不得出现任何非 ASCII 字符
set "NODE_EXE=node"
where node >nul 2>nul
if errorlevel 1 set "NODE_EXE=D:\Program Files\nodejs\node.exe"
"%NODE_EXE%" "%~dp0rcon-console.cjs"
echo.
pause >nul
```

### 规则 7：还要告诉用户"先给自己 OP"

即使控制窗口装好了，**默认没有任何人有 OP**（`ops.json` 是空的）——
任何人进服都只是普通玩家，`/` 开头的指令一条都用不了。

`tellUser` 里必须点明：**在控制窗口里输入 `op <你的游戏ID>`**。
这是"一句话开服"语义上该有的一步，不是可选项。

---

## 换版本 / 换端 / 换服务时改哪三处

这是本技能的核心。**其余部分（四态、锁规避、优雅停止、错误提示）完全复用。**

| 要改的 | 原来的 | 换成什么 |
|---|---|---|
| **① 识别特征** | `*server.jar*` / `*_launch*` | 新服务的命令行特征（BDS 是 `bedrock_server.exe`；Web 是 `*node*server.js*`） |
| **② 就绪判据** | 日志 `Done (`（**脆弱，优先换成真实请求**） | 该服务的最小真实请求（MC 用状态查询；Web 用 `GET /`） |
| **③ 启动命令** | `java -jar server.jar nogui` | 新服务的启动方式（BDS 是 `bedrock_server.exe`；Fabric/Forge 整合包**必须用它们自己的启动脚本**） |

### 具体场景

| 场景 | 关键差异 |
|---|---|
| **MC Java 原版 / Paper** | `java -jar server.jar nogui`；RCON 可用；世界用 `session.lock` |
| **MC Java + Fabric/Forge 整合包** | ⚠️ **不能** `java -jar`！必须用它自己的启动器（如 `-cp _launch Launch`），否则 mixin 类加载错位、整合包全线崩。**优先复用目录里已有的启动脚本** |
| **MC 基岩版 BDS** | 没有 RCON → 控制通道要换；世界目录独占；启动方式完全不同 |
| **非 MC 服务** | 规则 1 的"可变数据"和规则 5 的"控制通道"都要重新问一遍 |

> **通用兜底**：`service_attach` 会返回 `startPlan`（识别到的启动方式 + 依据）。
> **目录里已有启动脚本时永远优先用它** —— 脚本里往往写着必须的启动怪癖。

---

## PowerShell 5.1 的坑（Windows 检查清单）

生成/手写 `.ps1` 时逐条对：

| # | 坑 | 对策 |
|---|---|---|
| 1 | `.ps1` 被执行策略拦住 | `.bat` 壳必须带 `-ExecutionPolicy Bypass`；进程内可 `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force` |
| 2 | `.ps1` 必须是 **UTF-8 带 BOM** | 无 BOM 会按 ANSI 解码，中文注释乱码甚至语法错。**`.bat` 反过来不能带 BOM**（cmd 会把它打出来），所以 `.bat` 内容保持纯 ASCII |
| 3 | `Start-Process -RedirectStandardOutput` 会炸 | 报 `Item has already been added. Key: 'NO_PROXY'`（本机同时存在 `NO_PROXY` 与 `no_proxy`，PS 5.1 构造大小写不敏感字典）。**别用带重定向的 Start-Process**，让被调程序自己写文件 |
| 4 | `native \| Add-Content` 握着句柄不落盘 | 日志文件被锁、0 字节、外部 `EBUSY`。要边跑边看就**前台跑**一个 debug 脚本 |
| 5 | `Start-Process -ArgumentList` 不给带空格路径加引号 | 被拆成两段、子进程静默不干活。**带空格的值不要从命令行传**，让脚本自己持默认值 |
| 6 | 内联 JVM 参数被拆 | `-Djava.awt.headless=true` 被拆散，java 把 `.awt.headless=true` 当主类。**参数写成数组再 splat**：`$jvm = @(...) ; & $java @jvm` |
| 7 | 单元素数组被解包成标量 | 用 `+` 拼 `byte[]` 会炸。用 `List[byte]` + `AddRange` |
| 8 | 精确进程名匹配 | 见规则 3 |

---

## 反模式（别做）

- ❌ 让 DSH 后台任务持有服务端 —— 宿主一重启就没了，而且进程退出会反向唤起 DSH
- ❌ `taskkill /IM java.exe` / `taskkill /IM frpc.exe` 打一片 —— 误杀同机其它服务
- ❌ 用 `Test-Path <lockfile>` 判断"有没有人在跑"
- ❌ 把端口/路径/版本散落脚本多处（换一次要改一片）
- ❌ 把密钥、token 写进脚本（运行时从插件凭据读）
- ❌ 只做 ①②④ 而漏掉"启动中"（第 ③ 态）
- ❌ 把"解析日志"当成就绪的**前置条件**

---

## 怎么和插件配合

| 你要做的事 | 用哪个工具 |
|---|---|
| 挂靠服务，拿到端口/日志/控制通道/启动方式 | `service_attach` |
| 判四态、确认"现在到底能不能起" | `service_status` |
| 读日志当证据 | `service_logs` |
| 走控制通道发命令（优雅停等） | `service_exec` |
| 导出启停脚本给用户 | `service_export_scripts` |
| 把本地服务暴露到公网、拿公网地址 | `openfrp_expose` |
| 出问题时关联三方信息、给带证据的结论 | `openfrp_diagnose` |

**导出的脚本只是起点。** 换版本/换端时，按上面"改哪三处"重新实例化，
或直接按本技能的规则**为你手上的服务重新写一套** —— 不必受生成内容限制。
