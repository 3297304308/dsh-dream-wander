# 走神与做梦（dsh-dream-wander）

给 DeepSeek Harness（DSH）角色加上「走神」与「做梦」的 host 插件。

> **English**: Mind-wandering and dreaming for DeepSeek Harness agents: idle reverie, sleep judging, dream play-out, and waking residue. Data lives under `<DSH_HOME>/dream-wander-data` by default; set `dataDir: "./data"` to keep data inside the plugin directory. See the configuration table below.

- **走神**：角色独处时产生的短促联想（≤50 字），角色记得，之后可提起也可不提起。
- **做梦**：静默满确认期即入睡，入睡后的判定时长内按曲线抽命中时刻（睡满整段命中率 = `hitP`，默认 0.5），命中且角色还在睡就在那一刻开演，同时扣掉当日 1 场额度（当日额度上限 `dreamsPerDay`，做一场扣 1、扣到 0 当天不再判；一整天没静默过就完全不判）；梦中角色分半幕自由生成梦境；醒来后按档位留下残留（默认打码梦文本；可切词句残留）与模糊心情。
- **梦醒记忆有两种形态可二选一**：打码梦文本（默认，正文随机盖方块、按日变糊、到期忘掉）/ 词句残留（最多三词一句）。
- 两者互不依赖，可各自独立开关。

## 快速开始（4 步）

> ⚠️ **出厂两个开关全关、作用域为空**——装完不打开就等于没装。

0. **启用 + 刷新**：在 DSH 的 设置 → 插件 里确认「走神与做梦」是启用状态（刚装完/更新后需要刷新一次页面，让面板重新加载）。
1. **装**：在 DSH 插件页「添加插件」输入包名 `dsh-dream-wander`（npm 安装，推荐）；或按「安装」里的本地目录/源码方式装。
2. **开**：设置 → **走神与做梦** → 打开「做梦开关」「走神开关」，把「作用域会话」选成你要生效的那个会话——**改完一定要点页面底部的「保存」**（面板是草稿态，不点保存不生效、热应用不会触发）。
3. **验证（先看走神，再看梦）**：
   - 先跟角色说 3-5 句话让角色产出词（面板「运行状态→词池」要 >0，词池空时不做梦）；
   - **走神**：保持「入睡确认」默认 **1 小时**，只改三个：独处触发 **10 分钟**（面板最小档）、走神触发概率 **1.0**、放宽至入睡前开（默认就是开）；点保存后保持安静 **10-11 分钟** → 看 `<数据目录>/走神/<日期>.md`（默认 Windows 路径 `%USERPROFILE%\.dsh\dream-wander-data\`），应出现走神段落。**注意默认允许时段从 08:00 开始：凌晨 0-8 点测不到走神**。
   - **梦**（可选，慢一些）：看完走神后再把「入睡确认」降到 **0.1 小时**、判定时长 **1 小时**、命中率 **1.0**；安静等角色睡下后按曲线抽命中时刻开演——**命中时刻是随机的（睡满期望约半小时）**，不是 15 分钟必出，别急着判坏；梦正文不进聊天，结束后看 `<数据目录>/梦境副本/`。想快点结束把「单场梦时长上限」调 10 分钟。
   - 验证完改回默认：入睡确认 **1 小时**、判定时长 **6 小时**、命中率 **0.5**、独处 **15 分钟**、走神概率 **0.3**、梦时长 **90 分钟**（其余保持默认即可）。

**没反应先查这 4 处**：① 插件是否启用、页面是否刷新过；② 两个开关是否打开、作用域是否选中了会话；③ 面板“运行状态”里有没有报错/最近异常；④ `<数据目录>/plugin.log` 尾部（数据目录见「数据与隐私」）。

## 环境要求

- **DSH 0.2.2-rc.3**（cordis 4.x）——插件按此版本契约实现，目前只在 0.2.2-rc.3 上验证；`engines.dsh` 已声明兼容范围，不兼容版本会被 DSH 拒绝加载。
- **npm 依赖**：`@deepseek-ai/schemastery`（配置校验）——从 npm 注册表安装时会自动拉取；**本地目录 / git clone 安装不会自动装依赖**，需先在插件目录跑一次 `pnpm install`（或 `npm install`）把依赖装齐（离线环境需先准备）。
- **LLM 通道**：默认 `deepseek-account`/`deepseek-flash`，需要 DSH 已登录可用账号。
- **可选：qq-bridge**（外部程序，不随本包分发、不修改它）——用于信号通道（做梦期间的外部中断、被动回应代发、休眠发生探测）。
  **不装桥接时**：走神、做梦判定、梦境生成、残留/画面/心情注入、副本都可用；只有「外部消息中断、被动回应代发、休眠发生探测」不可用（日志会提示「未读到 console-token」）。

## 安装

**npm 安装（推荐）**：在 DSH 插件页「添加插件」输入包名 `dsh-dream-wander`，或用 `plugin_manager install_bundle` 目标为包名 `dsh-dream-wander`（已发布：https://www.npmjs.com/package/dsh-dream-wander；GitHub 源码仓库：https://github.com/3297304308/dsh-dream-wander）。装好后设置 → 插件 里确认启用，刷新页面，设置页出现「走神与做梦」。

**本地目录安装（源码 / 开发用）**：

1. 把本目录放到任意位置（或保持 link）；
2. 在 DSH 插件页「添加插件」选本目录，或用 `plugin_manager install_bundle`（目标为本目录绝对路径）；它会把 `dsh-dream-wander` 加进 profile 的依赖与 patch；
3. 设置 → 插件 里确认已启用；刷新页面后设置页左侧出现「走神与做梦」；
4. 本地 link 安装前建议备份 profile 的 `package.json` 与 `cordis.patch.yml`。

**源码开发**：`git clone https://github.com/3297304308/dsh-dream-wander` 后先在插件目录跑 `pnpm install` 装依赖，再 link 安装；改动热应用。

## 配置

全部字段与默认值（面板以下拉/开关为主，路径、词表、称呼等为文本框；保存即热应用，不用手改 YAML）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `dreamEnabled` | `false` | 做梦开关（出厂全关） |
| `wanderEnabled` | `false` | 走神开关（出厂全关） |
| `scope` | `[]` | 作用域会话 id 列表（空=不生效） |
| `wander.window` | `[8, 20]` | 走神允许时段（小时数，面板整点/半点下拉；跨零点写 22—6） |
| `wander.untilSleep` | `true` | 放宽至入睡前（起点不变、终点放宽到入睡；跨零点窗口下无额外放宽，仍按起点到次日终点前） |
| `wander.aloneMin` | `15` | 独处触发时长（分钟） |
| `wander.p` / `factor` / `threshold` / `max` | `0.3` / `2` / `10` / `50` | 触发概率 / 过度在意因子 / 阈值 / 单条上限 |
| `wander.dupThreshold` | `0.95` | 走神复读阈值（0.1-1；与今天已写走神的相似度 ≥ 此值算重复，会重试或放弃；越高越宽松） |
| `cycle.residueP` | `0.3` | 走神带入残留的概率 |
| `judge.confirmH` | `1` | 入睡确认（静默满 N 小时才算睡着；可配 0-5，0-1 每 0.1、1-3 每 0.5、3-5 每 1） |
| `judge.windowH` | `6` | 最长判定时长（小时，1-24） |
| `judge.dreamsPerDay` | `1` | Kmax：当日梦数上限 |
| `judge.hitP` | `0.5` | 睡满整个判定时长的命中率 |
| `judge.lambdaRatio` / `lambdaHours` | `12` / `null` | 拉普拉斯 λ=判定时长/比例；可单独覆盖（小时） |
| `play.halfChars` / `intervalMin` / `actsPerRelease` / `maxDurationMin` | `[100,200]` / `[10,30]` / `0.5` / `90` | 半幕字数 / 放送间隔 / 每次幕数 / 梦时长上限 |
| `interrupt.sensitivity` | `mid` | 敏感度弱/中/强；累计满 2 次信号即断是机制定值 |
| `interrupt.weakPool` / `midPool` / `fullName` | 各一句 / `''` | 迷糊语小池 / 完整唤醒称呼（未配时点名仅按引用判定） |
| `interrupt.missP` / `startleP` | `0.05` / `0.02` | 没听见 / 惊跳概率（面板固定档位） |
| `actJump.sceneP` / `timeP` / `linkage` | `0.25` / `0.25` / `0.75` | 幕拍：场景跳跃 / 时间跳跃 / 跳跃关联程度 |
| `retry` | `2` | 生成失败重试次数 |
| `copy.degrade` | `daily` | 副本降档驱动（daily/restart） |
| `copy.visibility` | `[80,40,20,0,0]` | 副本可见比例序列（保留期由此唯一决定） |
| `frame.interruptMin` / `naturalMin` | `30` / `120` | 中断/自然梦画面留存（分钟） |
| `residue.form` | `blur` | `blur`=打码梦文本（默认）/ `words`=词句残留 |
| `residue.hours` / `tiers` | `24` / `[50,100,200,300]` | 仅词句形态：保留时长与档位边界 |
| `residue.visibility` | `[50,30,10,0,0]` | 仅打码形态：可见比例序列 |
| `mood.hours` | `2` | 心情影响时长 |
| `freq.stopwords` / `names` / `pronouns` | 内置 / `[]` / 五词 | 停用词 / 称呼表 / 代词表 |
| `bridge.dir` / `port` / `keys` | `''` / `3100` / `{}` | 桥接安装目录、端口、会话 id↔桥接 key 映射 |
| `signal.pollIntervalSec` | `[2,5]` | 信号轮询间隔（秒） |
| `llm.provider` / `llm.model` | `deepseek-account` / `deepseek-flash` | 直连生成通道 |
| `dataDir` | `''` | 数据目录：空 = `<DSH_HOME>/dream-wander-data`；`./data` = 跟着插件目录走（便携，仅本地/link 安装推荐——npm 安装升级会覆盖包目录） |

已废弃字段（保留解析、不参与计算、面板不显示，下个版本删除）：`judge.kMin`、`judge.intervalMin`、`play.releaseMinutes`、`interrupt.count`、`actJump.chainP`、`copy.keepDays`、`mood.scale`。

## 数据与隐私

- **你会看到什么**：走神段落与梦境副本写在下方「数据在哪」的文件里（设置页「内容查看」折叠区也能直接看正文，见本节「内容查看」）；梦的正文**不会出现在聊天/会话**里，角色最多记得残留与最后画面；一直盯着会话窗口等“梦”会觉得它没运行。
- **额外 LLM 调用与费用**：每次走神 = 1 次生成调用；一场梦 ≈ 1 次场景生成 + 每半幕 1 次生成（默认参数下约 10 次；间隔/幕数/重试都会让实际次数变化）；注入内容变化时有一次整份系统提示重写（长会话下 token 可能明显跳一下，属预期）。都走你配置的 LLM provider、消耗账号额度，本插件无遥测、不上报。
- **数据在哪**：默认 `<DSH_HOME>/dream-wander-data`（`DSH_HOME` 默认 `~/.dsh`）。想数据跟着插件目录走（整个文件夹拷走/拷回）可设 `dataDir: "./data"`；也支持环境变量 `DREAM_WANDER_DATA`。相对路径按插件目录解析。
- **数据文件**：`state.json`（状态机、判定进度、替换位图、词频池、会话 id、**角色的走神原文与迷糊语**）、`走神/<日期>.md`、`残留/`、`梦境副本/`、`plugin.log`、`apply-status.json`、`instance.lock`。
- **内容查看（只读）**：设置页「运行状态」下面的「内容查看」折叠区可以直接看：今天的走神逐段、最新残留原文（含打码方块 □）、最近 3 个梦境副本（含 □）、最后画面、正在做的梦（已放出的部分）。接口只接受本机回环来源与本机 Host、同源、GET（POST 405、跨源/非回环来源 403；DSH 若绑到局域网，本接口也不对外）；梦的正文仍只存内存、不落盘。截图前请把「内容查看」合上或打码。
- **恢复默认后**：插件回到全关、数据目录回到默认（旧数据不会自动搬过去）；想继续用旧数据就把 `dataDir` 指回原路径。
- **隐私提醒**：梦境正文、残留、词频、日志可能很私密——**不要提交到仓库、不要直接贴进 issue**；截图前把会话标题/路径/QQ 号打码。
- **分发/发布前检查**：① 删掉 `data/` 与 `instance.lock`（它们含真实会话 id 与旧进程锁，拷给别人会撞锁）；② 确认 `git status` 里没有 data；③ npm 包由 `files` 白名单控制、不含 data。
- **隐私披露**：本插件不向任何服务器上报数据；但副本/残留/日志就存在本机数据目录里——若角色的会话与本插件同在一个 sandbox 策略下，理论上角色能读到自己数据目录中的文件（未做实测，介意可把 `dataDir` 指到角色够不到的位置）。
- **出站请求**：只有 ①DSH 的 LLM provider（走神/梦生成/判定，消耗账号额度）②可选的**本机** qq-bridge（`127.0.0.1:<port>`，读 state、轮询未读、代发）。**无遥测、不上报任何服务器**。
- **删除/迁移**：停用插件后直接删/移动数据目录即可；升级前建议备份。

## 存储与知晓机制（重要）

**角色的知晓靠注入**：走神、残留、画面、心情这些内容，全部靠插件在每轮组装提示词时**按当前时效现算注入**（`systemPrompt.variable`），不写死进会话消息，也不依赖文件位置。梦的完整内容只存在于插件内存缓冲与副本文件，**不进现实角色上下文**；现实角色只知自己的残留与最后画面（自然梦 2 小时、中断梦 30 分钟阶梯打码后散）。

**注入与旧版本清理**：DSH 的 DeepSeek 路由声明 `systemPromptUpdate: 'in-history'`——渲染出的系统提示变化时会被**追加**进会话历史，旧版本不会自动消失。插件把 6 段注入拆成两组：①**会过期必须清的段**（画面/心情/残留/做过梦/迷糊语）一变就归一化清旧版本；②**走神段只追加**，靠三层兜底清旧版本（未归一追加满 3 份、距上次归一化超 4 小时、每天日切）。代价是触发归一化那次请求的前缀 KV 缓存失效，属预期；面板「运行状态」里能看到归一化次数与未归一变化数。

**信号通道（可选，需 qq-bridge）**：

- 只读轮询桥接 `GET /api/socialV2/unread`（带控制台令牌、**不带** `x-agent-token`，不抬高未读水位）
- 做梦期间用 `agent/pre-step` 拦截进角色会话的输入（被拦截的信号不算角色醒来）；计数以轮询通道为权威
- 被动回应/中断迷糊语用会话令牌 `POST /api/send/private|group` 代发（代发失败梦继续、计数照常）
- 桥接进入潜水（`wakeConfig.confirmedAt` 且 `confirmedBy=set_wake_config`）作为走神双源之一

## 排障

| 现象 | 先查 |
|---|---|
| 设置里没有「走神与做梦」 | 插件是否启用、页面是否刷新过；插件页里有没有加载错误 |
| 打开了开关但什么都不发生 | 作用域是否选中会话、时段是否在当前时间、面板“运行状态”是否 awake |
| 一直不睡/不梦 | 独处计时（静默满 confirmH 小时）够不够；当日额度是否用完；词池是否为空；命中是概率（默认 0.5） |
| 面板 503 / 插件未启动 | `<数据目录>/plugin.log` 与 `apply-status.json`；常见是 `instance.lock` 被别的实例占着（**先确认另一个实例已退出**再删锁，或给每个 profile 配不同 dataDir） |
| 走神内容重复 | 把「走神复读阈值」调低（更严）或调高（更宽）；见配置表 |
| 想彻底卸载 | 见文末「安装 / 卸载」；会话里已注入的旧提示重启后跑一回合或重置会话才会清 |

## 已知限制

- **只在 DSH 0.2.2-rc.3 验证**（`engines.dsh` 会拦截不兼容版本，但不保证行为兼容）；DSH 升级后需复核
- 设置面板 UI 目前为中文（`locale/` 只有标题/描述的英文）
- 多会话场景只按作用域首个会话做信号轮询
- 同一台机器多个 profile 同时启用会争用默认数据目录的 `instance.lock`（第二个实例启动失败、面板提示占用）——给每个 profile 配不同 `dataDir`
- 走神时段窗口的起点与终点相同（如 8-8）会被视为无效、走神永不触发（面板请选不同时间）
- 信号通道依赖 qq-bridge 的控制台令牌与 state 文件格式，桥接大版本升级后需复核
- 本插件不修改桥接、人格卡与记忆系统

## 安装 / 卸载 / 整体关闭

- **安装**：见上面「安装」；装了 qq-bridge 时在配置里填 `bridge.dir` 与 `bridge.keys`。
- **卸载（优先插件管理器）**：在 DSH 插件页对 `dsh-dream-wander` 点 Remove（会自动清依赖/lock/链接）；若只能手动：①从 profile 的 `package.json` 删掉 `dependencies['dsh-dream-wander']` 与 `dsh.profile.bundles` 里的同名项，在 profile 目录跑一次 `pnpm install`；②从 profile 的 `cordis.patch.yml` 删掉 `id: dream-wander` 的覆盖段；③删除插件目录；④重启 DSH。数据目录可留可删（删掉=丢失当日词频/残留/副本）。注意：会话历史里已注入的旧系统提示不会被自动清掉，重启后角色在会话里跑一回合（或重置会话）才会清。
- **整体关闭**：两个开关全关后插件**对外完全静默**（不生成、不注入），角色行为与安装前一致；数据目录保留（后台 tick 仍会做残留过期清理与副本降档）。

## 开发方式

本插件由 **DeepSeek Harness（DSH）大力支持**：设计讨论、代码实现、审查与测试主要在 DSH 内完成；作者本人仅负责提出方案和许愿。如果你也在用 DSH，可以直接让它读这个仓库的源码、提 issue 参与改进。后续作者还会继续更新，因为作者又想到了新的点子！

## 开发与测试

- 目录：`index.js`（装配/事件/巡检）、`lib/`（schema、config、store、freq、wander、dream、interrupt、signal、copy、memory、clock、view、client 面板）、`locale/`、`icon.svg`、`cordis.patch.yml`。
- 测试：`node --test tests/`（Node 20+，`node:test`；用临时数据目录，不碰真实数据）；受限环境（如 DSH 沙箱，spawn 被拒）改用 `node tests/index.mjs`（单进程）；包清单自检 `node tests/preflight-bundles.mjs`。测试只在源码仓库内可跑（npm 包不含 tests）。
- 许可：MIT。图标为手绘 SVG，随 MIT 授权。qq-bridge 为可选外部程序，不随本包分发、不修改。
