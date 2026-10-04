# dsh-openfrp

**让 DeepSeek Harness 拥有自己的眼睛和手 —— OpenFrp 隧道 + 本地服务，全程不需要人当数据中转站。**

> Let DeepSeek Harness see and drive OpenFrp tunnels and local services by itself:
> tunnel lifecycle, live service logs, RCON commands, and evidence-backed
> diagnosis — no "please click this in the panel and read me what it says".

---

## ⚠️ 开发中，**尚未做好**（v0.1.0）

这是一个**能用的早期版本，不是成品**。核心链路都经过实测，但下面这些**还没做完**，
请照着"会碰到坑"的预期来用：

| 未完成 | 具体状态 |
|---|---|
| **指令控制窗口** | 刚改成"由 DSH 为每个服务实时生成"（插件不再自带一份），**这条路径还没有在真实服务上端到端跑通过**。插件会强制这一步不被遗漏，但生成物本身的质量取决于当时那次生成 |
| **完整 9 步交接流程** | **没有一次性端到端跑过**。每一步单独验过，串起来走全程还没做 |
| **平台** | **只在 Windows 上验证过**。POSIX 路径有代码分支，但没实测 |
| **发布** | 还没发到 npm，只能从源码 `link:` 安装 |
| **真实服务端矩阵** | 只实测过 **Minecraft Java 原版 26.2**。Fabric/Forge 整合包、基岩版、非 MC 服务**都没实测** |

**已经实测过的**（可以信的）：隧道增删改查与回读、节点排序、frpc 起停与就绪判定、
服务挂靠与四态判定、日志跟读、RCON 收发、脚本导出的顺序门禁 —— 见下方各节，
以及 `npm test` 里的 349 项（含真实账号端到端与真实服务端集成）。

发现问题和缺口是**预期内**的：请开 issue。

---

## 它解决的是什么问题

Agent 早就"能开服"了：提炼客户端、选版本、挑 mod、写启动脚本，不需要插件。

**卡住的是后面这一段：**

| 现状 | 结果 |
|---|---|
| 隧道设置（端口/节点/CNAME）只活在网页面板里，DSH 看不见 | DSH 只能**指挥用户操作**，再听用户复述 |
| frpc 的日志只在官方启动器的 GUI 里 | 连不上时**没有证据**，只能猜 |
| 服务端日志只活在控制台窗口里 | 排查要靠"你截个图给我" |

于是"连不上 → 找错 → 找不出来"可以烧掉几个小时。

**这个插件把这些信息全都搬到 DSH 能读能写的地方。**

---

## 能力

| 工具 | 做什么 |
|---|---|
| `openfrp_account` | 远程安全登录（浏览器授权，X25519 + XSalsa20-Poly1305）、登录状态、登出 |
| `openfrp_tunnel` | 列出/新建/编辑/删除隧道；**自动解析公网地址与 CNAME**；按协议筛选并排序节点（附排除理由） |
| `service_attach` | 挂靠一个本地服务（指向目录即自动识别 Minecraft），**不启动、不修改任何东西** |
| `service_list` | 新会话第一件事：恢复"现在在跑什么、映射到哪" |
| `service_status` | 逐项核实：端口有人在听吗、RCON 应答吗、日志长什么样 |
| `service_logs` | 读实时日志 —— 这是 Agent 的眼睛 |
| `service_exec` | 发命令并拿到**服务端原话**（Minecraft 走 RCON） |
| `service_start` | 启动本地服务并跟日志到就绪（**只用于当场验证**；返回值带 `spawnedPid` + 退出码 + 子进程输出，并明说它活不过宿主重启） |
| `service_stop` | 优雅停止：控制通道优先（Minecraft 走 RCON `stop`，会存档），强杀只作兜底。**交接前必须先关掉验证实例** |
| `service_detach` | 从插件注册表里移除一条记录。**只动插件自己的记录** —— 不删磁盘上的服务、不停进程、不动 OpenFrp 上的隧道 |
| `service_export_scripts` | **把启停脚本导出到服务目录并交给用户** —— 长跑服务唯一可行的持有方式。强制正确顺序（验证实例在跑 / 没有隧道记录 / **隧道记录已失效**，三种会**拒绝导出**）；**强制带上指令控制窗口**（`extra_files`，`force` 也跳不过）；返回值带 `tellUser` / `agentMustSay` / `handoffOrder` / `handoff.readyForHandoff` |
| `openfrp_expose` | 把本地服务暴露到公网并返回地址；**只停自己启动的 frpc** |
| `openfrp_diagnose` | 把服务、隧道、API 三方信息关联成**带证据的结论** |
| `openfrp_environment` | 平台、frpc 版本、缓存目录等环境事实 |

## 谁持有长跑进程：**用户**，不是 DSH

实测：**DSH 派生的一切进程都活不过宿主重启** —— `run_in_background` 起的、`Start-Process` 起的，
宿主重启后**都不在了**。只有**用户自己启动**的进程不受 DSH 开关影响。

所以分工是：

```
① DSH 把服务配好        （EULA、配置、端口、控制通道）
② DSH 起一次做验证       （确认真能开、能连、隧道通）
③ DSH 把启停脚本导出到服务目录
④ DSH 明确告知用户：以后双击这个
⑤ 用户自己点；DSH 只负责挂靠 + 观测 + 控制，不持有进程
```

`service_export_scripts` 生成第 ③ 步，返回值里的 `tellUser` / `agentMustSay` 就是第 ④ 步要说的原话。

> ⚠️ **生成的脚本只是"规则的一个实例"，不是规则本身。**
> 换服务端版本、换端（**基岩版没有 RCON**）、换服务时，请按随插件分发的技能
> **`dsh-openfrp-handoff`** 重新实例化 —— 那里讲的是**方法论**：
> 可变状态锁怎么找、四态（冷启动/热重启/启动中/僵尸）怎么判、进程怎么认、
> 就绪怎么验、优雅停止怎么排，以及**换服务时只需改三处**（识别特征 / 就绪判据 / 启动命令），
> 其余全部复用。
>
> 技能在插件加载时同步到 `~/.dsh/skills/dsh-openfrp-handoff/SKILL.md`（只补缺，不覆盖你的改动）。

### 世界锁（`session.lock`）怎么规避

启动脚本的第一职责**不是"启动"，而是"先确认没有别的写者"**：

| 状态 | 判定 | 正确动作 | 做错的后果 |
|---|---|---|---|
| ① 冷启动 | 端口没听 + 没有进程 | 直接启动 | — |
| ② 热重启 | **端口在听** | 先优雅停，再启动 | 跳过 → 以为重启了，其实没换配置 |
| ③ 启动中 | 端口没听，但**进程很年轻** | **等它就绪，绝不另起** | 另起 → 抢锁，两个都玩不转 |
| ④ 僵尸 | 端口没听，进程**很老** | 清掉再启动 | 不清 → 它一直占着锁，下次必失败 |

**"年轻"阈值 = 冷启动耗时的 2–3 倍**（原版 MC 约 9–12 秒，110 mod 的 Fabric 包 40–60 秒 → 默认 180 秒）。

> ⚠️ **`session.lock` 平时就存在**，不是"有文件=被锁"。
> **不能用 `Test-Path session.lock` 判断**，只能从**进程状态**判断。
> 这条规则插件自己也遵守：`service_start` 先判四态，第 ③ 态只等不另起。

## 实测过、并已修掉的问题

这些问题都不是推测出来的，是一次真实「从零开服 + 一次穿透」实测报告里的原文（含 frpc 日志与 API 回读）。

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| **B1** | 新建/编辑的隧道本地端口变成 `0`，frpc 向 `127.0.0.1:0` 拨号，隧道永远打不到服务 | `local_port` 被当成**字符串**提交（官方文档示例就是字符串） | 提交数字；**创建/编辑后一律回读记录**，不一致就直接报错并给出原始记录，不再静默"成功" |
| **B2** | `auto_create` 生成的隧道名被拒：`隧道名不符合要求` | OpenFrp 隧道名**只接受 `^[a-z]+$`**（连字符、数字都不行），文档没写 | 自动规整为纯小写字母并**回报改写**；参数说明写明规则；自动生成器只产合法名 |
| **B3** | `nodes` 的 `allowPort` 全为空，只能盲试远程端口 | OpenFrp 不返回可用端口区间 | 未指定端口时自动从 10000-65535 挑并**重试多个候选**；指定端口失败时给出分类理由与建议端口 |
| **B4** | frpc 明明打了成功行，`expose up` 仍等 90 秒超时；超时后 frpc 不被回收，下次 up 被误报"已被官方启动器占用" | 只匹配英文成功行，而 OF 版 frpc 打的是**中文**：`隧道 [x] 启动成功, 请使用 [addr] 来连接服务` | 两种措辞都匹配；超时**回收自己启动的 frpc**；`already-online` 区分"插件自己残留"与"外部占用" |
| **M5** | 账号是 VIP，却被按 `normal` 过滤节点 | 取了展示名 `普通会员(VIP)` 当机器键用 | 保留 `group`(机器键) 与 `friendlyGroup`(展示名)，节点过滤只用机器键 |
| **M5b** | **已实名**，大陆节点仍被"未实名"全部拒绝 | `realname` 写死 `false`，从没读过 `getUserInfo` 的 `realname` | 用账号真实实名状态。实测：大陆可选节点 **0/41 → 16/41** |
| **M6** | `service_attach` 把 `server.properties` 原文回显，含 `rcon.password` / `management-server-secret` | 整个 properties 被塞进返回值 | 只回显键名，不返回值 |
| **M7** | 改了 `rcon.password` 后 RCON 一直 `auth-failed`，必须重新挂靠 | 挂靠时读的密码被缓存，不会重读 | RCON 前自动重读 `server.properties` 刷新凭据并重试一次；错误里直接说明原因 |
| **M8** | 没有"启动服务"的能力，开服的隐性知识全靠人给 | 只有挂靠，没有启动 | **v2 重新定性**：加 `service_start` 是错的路（DSH 派生进程活不过宿主重启）。改为加 **`service_export_scripts`**：导出启停脚本 + **明确告知用户以后自己双击**；同时把方法论做成技能 **`dsh-openfrp-handoff`**，换版本/换端时按规则重新实例化，而不是照抄脚本 |
| **M8b** | 生成的脚本把 Minecraft 的答案写死了，换端（基岩版无 RCON）就不成立 | 知识被硬编进模板 | 知识**上移到技能**；脚本只是"规则的一个实例"。导出结果里回 `methodology.reInstantiateThese`，明说换服务只需改哪三处 |
| **M7b** | `service_exec` 发 `spark tps` 返回空串，容易被当成失败 | RCON 只带**同步**输出，异步命令把结果写进日志 | 空回复时明确提示"这不是失败，去 service_logs 读" |
| **B3b** | `allowPort` 其实**有值**（如 `(50000,60000)`），但挑端口时没用上 | v1 误判为"永远为空" | 有区间时把区间作为过滤条件，让首个候选就是合法端口；仍然保留重试 |
| **L9** | `tunnel list` 只显示 `127.0.0.1:0`，不告警 | 与 B1 同源 | 该端口为 0 时直接给出 warning 与修法 |

另外修掉一个**健壮性问题**：写凭据/注册表失败（只读家目录、磁盘满、沙箱）会让 `openfrp_account status` 整个失败。
现在**持久化是缓存而不是前提条件** —— 写不进去只记录错误，内存值照常可用。

## v3 实测修掉的问题（全新空目录冷启动）

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| **D1** 阻塞 | `service_start` 连挂两次，等满 180 秒，事后查证**根本没有 java 进程** | **根因是 D2**：假阳性进程匹配 → 被判成"启动中" → 于是**根本没去 spawn**，只在等一个不存在的实例 | `service_start` 改为**真 spawn + 输出落盘 + 返回 `spawnedPid`**，并区分三种结局：`start-failed`（附退出码与输出）/ `start-timeout` / `started-not-ready` |
| **D2** 阻塞 | 进程匹配把**插件自己的探测进程**也算进去了 | 命令行标记用了裸名 `server.jar`，而探测脚本的命令行里就含这个字符串 | 标记改成**绝对路径**（jar / 脚本 / 服务目录），并**排除自身与全部祖先进程**，再按进程名收窄 |
| **D3** 阻塞 | 生成的 `启动.bat` 写着"窗口可以关闭"，但服务端是**前台**运行的 —— 照做就停服 | 文案与实现不符（数据丢失级） | 文案改为 **KEEP THIS WINDOW OPEN**；并修掉它连带的顺序错误：`start-all.ps1` 里隧道脚本曾排在"前台跑的服务端"后面、**永远不会执行**，现改为先用独立进程起隧道 |
| **D4** | 冷启动没有 `logs/` 目录 → `service_attach` 说"没有日志"，第一次启动完全无法诊断 | 把"日志文件此刻不存在"当成了"没有日志" | Minecraft 的日志路径是**约定**而非发现：始终带上推断路径 + `exists` 标记，并等待文件出现 |
| **D5** | "端口没听 + 进程早没了"被含糊地归成"启动中/未知" | 只看日志，不看进程死没死 | 见 D1：现在回报退出码与子进程输出，明确区分 `start-failed` 与 `starting` |
| **D6** | `service_list` 里的隧道记录可能已被删除，仍显示为有效 | 没有和账号对账 | `service_list` 核对 `proxyId` 是否仍存在，标 `stale` 并给出修法 |
| **D7** | EULA 写成了 **UTF-8 带 BOM**，服务端读成 `\uFEFFeula=true` 一直拒绝启动（两次启动失败都源于此） | `Set-Content -Encoding UTF8`（PS 5.1）会写 BOM，且肉眼不可见 | 从**字节**核实 `eula.txt` / `server.properties` 等是否带 BOM，发现即就地去掉并在返回值里报告；生成的启动脚本也内置这个修复 |
| **§3** | 实名用户被分到**境外**节点 | 排序只按带宽、没按区域；实名信息明明拿到了却没用上 | 实名账号**先按区域近（大陆→港澳台→海外）、再按带宽**；`nodes` / `expose` 返回**选择理由**，并支持 `node_id` 手动覆盖。实测：韩国-首尔 → **义乌电信家宽（区域 1）** |
| **§2** | 第一次导出的脚本**没有公网地址**（要导两次） | 导出时隧道记录还没建，顺序错了 | `service_export_scripts` **强制正确顺序**：验证实例还在跑 → 拒绝导出（提示先 `service_stop`）；没有隧道记录 → 拒绝导出（提示先 `openfrp_tunnel create`，它不启动 frpc、不占进程）。可用 `force` 跳过。返回值带 8 步 `handoffOrder` |
| **§2.3** | `tellUser` 只说了用哪个文件，没说"请你亲手打开并回报" | — | 明确要求：**请亲手双击打开一次，然后回我一句「已打开」；在你回报之前，我不会去建隧道** |
| **新工具** | 顺序里第 ⑤ 步"关掉验证实例"没有工具可用 | — | 新增 **`service_stop`**：控制通道优先（Minecraft 走 RCON `stop`，会存档），强杀只作兜底，报告哪些 pid 停了、是否优雅、端口是否释放 |
| **E1** 健壮性 | 受限沙箱下 `openfrp_expose` 直接 `spawn EPERM` 抛错 | `frpc.js` 里还在用 `execFile` 的**管道 stdio** | 抽成 `src/exec.js`：**一律用文件 fd 捕获输出**，全项目不再有管道 stdio |
| **E2** 健壮性 | 插件数据目录不可写时，`expose up` 因写不了日志文件而整个失败 | 落盘被当成前提 | `prepareLogFile` 降级到临时目录；再不行就**不捕获输出照常启动** —— 落盘是缓存不是前提 |

## v4 实测修掉的问题（复验）

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| **D6 补完** ⚠️ | **同一份记录，两个工具给出互相矛盾的判断**：`service_list` 说 `stale: true`「隧道 1224790 已不存在」，`service_export_scripts` 却照旧导出、把失效地址 `kr-se-cncn-1.ofalias.net:29319` 烧进脚本 | 交叉校验**只写在了 `service_list` 里**；导出工具读的是 registry 原始值，只挡了两种（记录为 `null`、验证实例在跑）—— **`null` 挡住了，`stale` 漏过去了** | 导出工具改用**和 `service_list` 完全相同的实时核对**，新增 `tunnel-record-stale` 拒绝分支。另加 `handoff.tunnelStillExists` 与 `handoff.readyForHandoff`，**用一个字段明确表达"没有任何东西在拦你"**，避免 `verificationInstanceRunning: false` 被误读成"一切正常"（实际隧道早没了）。再加 `handoff.notVerified`，把"没核对什么"写出来，而不是留白让人当 OK |
| **F1** ★★ | `service_start` 的**工具描述与自己的返回值打架**：描述说 "DETACHED from the DSH process tree (so closing DSH does not kill the server)"，返回值却说 `survivesHostRestart: false` | 描述是旧的，没跟上 v2 的实测结论 | **返回值是对的**（宿主重启后 java 与 frpc 全都没了）。改为以返回值口径为准：明说**"只用于验证，绝不要向用户承诺这能让服务器活着"**。这类矛盾最危险 —— agent 会照着描述向用户做出错误承诺 |
| **F2** ★★ | **注册表只能增不能删**：条目里混着测试遗留，永远累积 | 没有任何工具能清除记录 | 新增 **`service_detach`**（第 14 个工具）：只删插件自己的记录，**不碰磁盘上的服务、不碰进程、不碰 OpenFrp 上的隧道**。并且**让测试自己善后** —— 测试跑完不再往注册表里留东西 |
| **F3** ★ | 复验时 `handoff.verificationInstanceRunning: false` 被读成"一切就绪"，而实际隧道早已不存在 | 缺一个总的判断字段 | 见 D6 补完：`readyForHandoff` + `notVerified` |
| **C-5** | `service_exec` 回空串容易被当失败 | 只在运行时结果里加了提示，**工具描述里没写** | 描述里也写明：**RCON 只带同步输出，异步命令（如 `spark tps`）回空串是正常的，不是失败** |

## v4 实测修掉的问题（指令与日志）

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| **G1** ★★★ | `service_logs` 的 `follow_ms` **被静默忽略** —— 请求跟读 15 秒，2.8 秒就返回，`live` 恒为 `[]`，而同一窗口内日志确实新增了 3 行 | **工具层参数名 `follow_ms` 与动作层解构的 `followMs` 不匹配，中间没有转名** → `followMs` 永远是 `undefined` → 既不等待也不采集 | 统一成**一条规则**：**工具层 `camelizeArgs()` 一次性把参数转驼峰，动作层只见驼峰**。原来的三种命名策略（显式转名 / 透传+动作层认下划线 / 透传+动作层认驼峰）全部收敛。`normalizeProxyFields` 两种都认，避免直接调用时再丢字段 |
| **G2** ★★★ | `service_stop` 的 `grace_seconds` **同款缺陷**，永远走默认 30 秒 | 同上 | 同上。并顺手发现 `openfrp_tunnel` 的 enable/disable **完全不走动作层**、在工具层直接构造 client —— 已移进 `tunnelSetEnabled`，工具层从此保持纯路由 |
| **G3** ★★★ | 上面这个 bug **活着通过了 85 条测试** | 现有测试只校验 schema **形状**（`defineTool` 收不收、`render` 返不返 ContentBlock），**没校验参数的值有没有到达动作层** | 新增 `test/param-delivery.test.mjs`（56 项）：注入假的动作层，**逐个参数断言它的值真的到达了动作层**；再对路由工具逐个 action 断言派发与参数；最后静态核对**声明的参数名与动作层解构名一一对得上**。这条测试就是为"下次还会漏"准备的 |
| **G4** ★★ | 跟读失效时，返回里仍带着"**空闲服务端不写日志**" | 那句提示在跟读正常时是好设计，但跟读**已经坏掉**时它把「工具没跟到」说成了「服务端没写日志」—— **静默失败 + 一句恰好掩盖它的提示**，agent 会据此得出"服务端空闲"的错误结论，且无任何报错 | 返回 `followApplied` / `watchedMs` / `followMsReceived`，并区分两种情形：**"跟读了 N 毫秒，零新增"** vs **"跟读压根没生效"**。空 `live` 再也不会被读成"服务端空闲" |
| **G5** ★★ | **没有任何地方能敲指令**：玩家侧没人有 OP（`ops.json=[]`），服主侧前台黑窗口能用但交付文档一个字没提，服务端跑在后台时**是真空** | 交接缺一环 | **指令控制窗口成为交接的必需步骤**（见下） |
| **G6** ★★ | 交付文档没提"进游戏后要先给自己 OP" | — | `tellUser` / `agentMustSay` / 生成的 README / `notes` 全都点明：**先给自己 OP，否则 `ops.json` 是空的、谁进来都用不了 `/` 指令** |

### 指令控制窗口：**DSH 生成，插件强制不遗漏**

「服务端跑在后台时没地方敲指令」是**交接本身的缺口**，不是用户的错。所以：

- **插件不硬编码控制台。** 控制通道随服务与端而变（**基岩版根本没有 RCON**），
  所以内容必须**按手上的服务重新推导**。规则与一份可改造的 RCON 参考实现放在技能
  `dsh-openfrp-handoff` 的「规则 6」里。
- **DSH 生成，用 `extra_files` 传进来**（那条带 `role: "control-window"`），
  插件**逐字写入、不改写、不加 BOM**（BOM 规则只针对插件自己的 PowerShell 模板）。
- **插件强制这个步骤发生**：服务有指令通道却没带控制窗口 → **拒绝导出**
  （`code: "control-window-missing"`），并返回 `howToGenerate` 说明该按什么规则生成。
- ⚠️ **这条不受 `force` 影响**：`force` 管的是"顺序不对但我要文件"，
  而"交接不完整"是另一回事 —— 用户只会在服务端跑在他敲不动的地方时才发现。
  真不需要时用 `control_window_not_needed=true` **陈述事实**，而不是绕过要求。
- `handoff.controlWindow = { required, provided, files, channel }`，并计入 `readyForHandoff`。

生成控制窗口时必须满足的三条（前两条是实测踩出来的）：端口/密码**运行时从配置文件读**；
`.bat` 在 `chcp` 之后**不得出现任何非 ASCII**（cmd 会按新码页重读批处理文件、字节偏移错位，
直接报 `The syntax of the command is incorrect`）；用管道喂 stdin 时**登录完成前到达的指令
必须排队、登录后补发**（否则自动化场景连上了却什么都不发、直接退出）。

## 一句话开服的正确顺序（v4）

```text
① 配好服务            EULA / server.properties / 端口 / RCON / 在线模式
② 为这个服务生成指令控制窗口   ← v4：不能忘，忘了导出会被拒（force 也跳不过）
③ DSH 起一次临时实例做验证     （能开、本地能连、RCON 能答）
④ openfrp_tunnel create       ← 只写 OpenFrp 服务端记录，不起 frpc、不占进程
⑤ service_export_scripts      ← 把控制窗口传进来，地址也在手上 → 这一次导出就完整
⑥ service_stop                ← 关掉验证用临时实例（必须在用户接手之前）
⑦ 明确告知用户                 "以后开服双击 X，关服双击 Y，敲指令双击 Z"
⑧ 用户亲手打开并回报            「已打开」
⑨ openfrp_expose up           → 起 frpc → 公网端到端验证 → 交付地址
```

④ 必须在 ⑤ 之前：脚本要把公网地址烧进去，而地址来自隧道记录。
导出结果里的 `handoffOrder` 就是这套顺序，`handoff` 字段会告诉你卡在哪一步。

## 三条设计铁律

1. **凡是 DSH 看不见的，都必须搬到它能看见的地方。**
2. **证据优先于猜测。** 每个失败都要落到一条机器可读的证据上（原始日志行 / 退出码 / API 字段），
   回答是"返回了 X，是 Y 问题"，不是"可能是 Z"。
3. **探测，不要配置；挂靠，不要接管；只拥有自己创建的东西。**

### 挂靠，而不是接管

服务端**不需要**由插件持有进程：日志是文件、命令是 RCON。
所以无论服务端是用户双击 `.bat` 起的、PCL2 起的、还是循环脚本起的，插件都能接上。

> ⚠️ 这也是为什么推荐**由用户的循环脚本持有服务端**：关掉 DSH 会终止 DSH 的子进程
> （而且子进程结束会反向唤起 DSH 并把结果推回）。长跑的服务不应该挂在短命的会话下面。

### 与官方启动器共存

插件**只拥有自己创建的隧道**。官方启动器继续管它其余的隧道，两者共用一份凭据、各跑各的 frpc。
启动前会用 API 的 `online` 字段做前置检查，**绝不重复开启一条已经在线的隧道**。

---

## 已验证的事实（本机实测，不是推测）

| 结论 | 怎么验证的 |
|---|---|
| Minecraft 服务端**运行期间可实时读日志** | 隔离实例边跑边采样；发 RCON 后文件增长 231 字节，新行时间戳 == 命令时刻 |
| 运行期间**可通过 RCON 发命令** | 同上，`list` 返回 `There are 0 of a max of 4 players online:` |
| **空闲服务端不写日志** | 47 秒零增长 → 所以判活**绝不能**看日志活动 |
| 就绪信号 | `Done (0.425s)! For help, type "help"` |
| 实际绑定端口 | `Starting Minecraft server on *:25999` —— 拿它建隧道，别信配置文件 |
| Node 没有 XSalsa20-Poly1305 | `crypto.getCiphers()` 里没有 → 用 `tweetnacl` |
| **受限沙箱下 `spawn` 用管道 stdio 会 EPERM** | 实测：`pipe` ✗ / `ignore` ✓ / **文件 fd** ✓ → 所以 frpc 输出重定向到文件再 tail |

完整实测记录见 [`docs/调研与技术方案.md`](docs/调研与技术方案.md)。

---

## 安装

```bash
dsh plugin --profile web add dsh-openfrp
```

> 从本地开发时用 `link:`：
> ```bash
> dsh plugin --profile web add link:/path/to/dsh-openfrp
> ```
> ⚠️ `dsh plugin` 需要写 `~/.dsh/profiles/`，**请在 DSH 之外的普通终端里执行**。

## 使用

不需要打开任何界面。直接在对话里说：

> 把 `C:\path\to\server` 这个服开出去，给我地址

Agent 会自己挂靠服务、拿端口、挑节点、开隧道、把公网地址告诉你；
玩家说卡的时候它会自己 `spark tps` / `spark profiler` 取证，而不是让你去截图。

### Minecraft 侧的前置条件

要让 DSH 能发命令，`server.properties` 里需要：

```properties
enable-rcon=true
rcon.password=<自己设一个强密码>
rcon.port=25575
```

> ⚠️ **RCON 是明文的。绝对不要把 RCON 端口一起穿到公网。**

---

## 开发与测试

```bash
npm install                  # 只有一个运行时依赖 tweetnacl

npm test                     # 192 项：纯逻辑（日志/RCON/隧道名/端口策略/四态/进程识别/BOM/凭据/导出模板）
                             #         + 工具契约（用宿主的真 defineTool 逐个校验）
                             #         + **参数投递**（断言每个参数的值真的到达动作层）
npm run test:load            # 15 项：按宿主方式加载并跑 apply()，断言注册出 14 个工具 + 技能随包分发且含换端指引
npm run test:export          # 87 项：真导出（顺序门禁/控制窗口门禁/文件集/BOM 规则/密钥不落盘/四态与世界锁/窗口文案/顺序/自我善后）
npm run test:live            # 11 项：真实网络（OpenFrp API + argo 登录第一步）
npm run test:live-fixes      # 26 项：真实账号端到端 + 失效隧道记录必须挡住导出
npm run test:mc              # 18 项：真下载并启动一个原版服务端来测
npm run test:all             # 前三项（不需要账号与真实服务端）
```

导出的 `.ps1` 还会用 **Windows PowerShell 5.1 的解析器**实跑一遍语法校验（这是目标运行时，
不是 PowerShell 7）—— 已验证 7 个脚本全部 `ALL PS1 PARSE OK`。

`npm run test:live-fixes` 是**最强的一条**：它用你的真实账号跑完整条链路 ——
建隧道 → 回读校验本地端口 → 起一个临时 TCP 监听 → `expose up` → **从公网地址真的连上去拿回数据** →
然后 `expose down` 并删掉测试隧道。全程只创建 **1 条**临时隧道，跑完清理干净。

`npm run test:mc` 会在 `test/.tmp/` 下建一个隔离实例（端口随机），
**不碰用户自己的任何服务端**，跑完自动删除。

### 三个踩过的宿主契约（写在这里免得再犯）

1. **`defineTool` 必须带 `output`。** 缺了它，`defineTool` 会在**第一个工具**上抛
   `Cannot read properties of undefined (reading 'render')`，整个工具注册静默失败——
   而插件的系统提示段落照样注册，于是**看起来加载了、实际一个工具都没有**。
2. **值 schema 很挑**：`{ type: 'object' }` 会被拒（要求显式声明 `additionalProperties`），
   且**不支持 `required`**。所以异构返回值只能用
   `{ type: 'object', additionalProperties: true }`。
3. **`output.render` 必须返回 `ContentBlock[]`**（`[{ type: 'text', text }]`），不能是裸字符串。

`test/tools-contract.test.mjs`（校验每个 spec）和 `test/plugin-load.test.mjs`
（按宿主方式加载并跑 `apply()`）就是为了拦住这类"静默不注册"。

### 宿主如何加载插件

DSH 通过 profile 的 junction 加载：
`~/.dsh/profiles/web/node_modules/dsh-openfrp` → 插件目录，
并且**按 junction 路径解析依赖**（等价于 `--preserve-symlinks`）。
所以 `@deepseek-ai/*` 只在宿主内可解析；`test/plugin-load.test.mjs` 因此必须
用 `node --preserve-symlinks` 运行。

> **改完插件源码后必须重启 `dsh web`**（宿主插件不在 HMR 范围内）才会生效。
> 另外：**插件目录名与包名必须一致**（`dsh-openfrp`）。
> 目录改名后 junction 会悬空，需要重新执行一次 `dsh plugin … add link:<新路径>`。

---

## 项目结构

```
src/
  index.js            宿主入口：注册工具 + 系统提示说明 + 同步随包技能
  tools.js            工具注册（唯一的注册点；编译全部 spec 后才注册，失败即整体报错）
  tool-specs.js       12 个工具的规格（纯数据，可被测试单独校验）
  actions.js          所有动作的纯实现（无 DSH 依赖，可独立测试）
  protocol.js         外部世界的事实：API 地址、frpc CLI、日志正则、隧道名规则、端口策略
  openfrp-client.js   REST 客户端（UA、flag/msg、Authorization 轮转）
  openfrp-auth.js     argo 远程登录（X25519 + XSalsa20-Poly1305）
  nacl.js             唯一接触 tweetnacl 的地方（缺失时给人话提示）
  frpc.js             frpc 定位/下载/启动/停止/日志解析（ZIP、tar.gz 自带解析）
  rcon.js             手写的 Source RCON 客户端
  logtail.js          实时跟读日志（含轮转检测）
  service.js          挂靠契约 + 适配器 + 四态判定 + 进程识别 + BOM 修复 + 证据级诊断
  registry.js         服务注册表与凭据（原子写；持久化失败不致命）
  exec.js             子进程输出捕获（**一律文件 fd，绝不用管道** —— 沙箱下管道会 EPERM）
  script-templates.js 启停脚本模板（世界锁规避 / 四态 / 顺序 / PS 5.1 坑全在里面）
skills/
  service-handoff/SKILL.md   ← 方法论（换版本/换端怎么重新实例化）。这才是"规则"，脚本只是实例
test/
  pure.test.mjs           纯逻辑 + 导出模板
  tools-contract.test.mjs 工具契约（用宿主的真 defineTool 校验每个 spec）
  plugin-load.test.mjs    模拟宿主加载并跑 apply()（需 --preserve-symlinks）
  export.test.mjs         真导出并校验（BOM/密钥/四态/世界锁）
  live-openfrp.mjs        真实网络验证（API + argo 登录）
  live-fixes.mjs          真实账号端到端（建隧道→回读→暴露→公网连回→清理）
  integration-mc.mjs      真实服务端集成测试
```

---

## 平台状态

**目前只支持 Windows**（已实测）。底层契约是跨平台的，Linux/macOS 需要补测
frpc 下载矩阵与路径处理。

基岩版（BDS）**不支持**：它没有 RCON、也没有服务端管理协议。

---

## 使用条款与声明

- 本项目使用了 **OpenFrp OPENAPI**。
- **此项目由社区开发，OpenFrp 官方不负责除节点问题以外的技术支持。**
- 请求均携带本项目自己的 User-Agent（这是 OpenFrp 的硬性要求）。
- **不实现自动签到**（官方 API 文档明确禁止，属于滥用行为）。
- 商业用途需获得 OpenFrp Project 项目组的书面授权。

## 许可证

MIT
