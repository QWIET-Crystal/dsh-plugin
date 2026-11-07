# Changelog

## 0.5.7 — 2026-11-07

第五轮（收敛验证）：对 0.5.6 的修复做对抗性复测。

### 修复

- **会话 id 消毒碰撞（中）**：`a b` 与 `a_b` 都消毒成 `a_b`，两个会话共用 id → 结论串味。修：只要改过原值就补 4 位短哈希（`a_b~7dbd`）。
- **Host 判定（验证结论：无问题）**：`127.1` 与 `[0:0:0:0:0:0:0:1]` 返回 200 是**正确的**——WHATWG URL 会把它们规范化成回环地址。误报已排除。

### 收敛判定

连续两轮（第 4、5 轮）**没有新的严重/高危**：第 4 轮 1 严重 / 3 高已全部修复并有回归测试；
第 5 轮只发现 1 条中危（本节已修）。按"严重/高危清零"口径，**本轮收敛**。

### 测试

- 166 → **167 项 / 25 个文件**。

## 0.5.6 — 2026-11-07

第四轮红队（HTTP 协议 × 会话解析）后的加固。1 严重 / 3 高 / 若干中。

### 修复

- **空帧风暴（严重）**：1MB 连续 zstd magic = 262144 次解压尝试 → 主线程冻结 11 秒、RSS 1.3GB、deep 下 OOM。修：单文件帧数上限 5000、整轮帧数预算 20000，且预算按**尝试次数**记（不看成功与否）。
- **会话文件硬链接（高）**：realpath 对硬链接隐形，根外的 `session.v4.jsonl.zstd` 链进来就能读。修：枚举与读取都看 `nlink > 1` 并拒绝。
- **整份丢弃 = 帮攻击者删证据（高）**：一帧超 8MB 会让整个会话被放弃且不出 unknown。修：保留已解出的帧、标记 `truncatedByFrame`，由上层转 unknown。
- **`?run=` 任意 .json（高）**：runs 根被 junction 换掉时能读出别人的 `settings.json`（含令牌）。修：只服务本工具写的文件名。
- **坏行/截断/硬链接静默（中）**：现在都进 `SESSION.SCAN.UNAVAILABLE`（unknown），不再等于没问题。
- **Host 伪装（中）**：`[::1]evil.com`、`127.0.0.1:3999, attacker.test` 曾被放行。修：严格解析，拒绝逗号列表与前缀伪装。
- **未来 mtime 霸位（中）**：2100 年的良性会话永久占据「最近一个会话」。修：不可信时间戳排到最后。
- **会话 id 指令注入（中）**：目录名原样进结论正文。修：消毒后再用。
- **解压后分析成本（中）**：9KB 会话可膨胀成 1.7s 纯 JS。修：分析文本上限 8MB。

### 测试

- 159 → **166 项 / 25 个文件**（新增 `test/security/round4.test.mjs` 7 项）。

## 0.5.5 — 2026-11-07

第三轮红队（CLI 参数 / 环境变量）里由主控侧修掉的 5 条。

### 修复

- **脱敏把枚举洗掉（高）**：`USERNAME=fault` 时 `level:'fault'` 被替换成 `<user>`，真故障在报告里变成「全绿」而 exitCode 仍是 2。修：`level` / `verdict` / `schemaVersion` / `exitCode` 不参与脱敏（id 仍脱敏，里面可能嵌路径）。
- **本地病例投毒（高）**：往本地病例库放同名病例，`check` 会把里面的 `calc.exe` 当「复制即用」输出。修：**只有共享库的病例给命令**，本地草稿一律不给。
- **junction 逃逸（中）**：`safety.isInside` 用非 native 的 `realpathSync`，Windows 下不解析 junction，可读写 `DSH_HOME` 之外。修：改用 `realpathSync.native`。
- **cases --json 不脱敏（中）**：`cases <id> --json` 与 `--search --json` 原样输出令牌与家目录。修：输出前脱敏。
- **--deep-sessions 聚合炸弹（中）**：200 个会话 × 4 帧 × 8MB = 6.4GB / 8.1 秒。修：整轮解压总预算 64MB，超了停并标 `truncated`。

### 测试

- 155 → **159 项 / 24 个文件**。

## 0.5.4 — 2026-11-07

第三轮红队：工具型攻击者（带 shell 的 DeepSeek 边界角色）在沙箱里跑出 10 条真攻破。
其中 5 条本轮修掉；其余按威胁模型记为「已声明非目标」，但补进了文档。

### 修复

- **runs/ 硬链接 → 无鉴权 HTTP 任意读（高）**：`readRun` 只有"纯文件名"一道门，
  `runs\loot.json` 硬链接到根外文件后，`GET ?run=loot` 直接返回根外内容
  （硬链接是同一 inode 的第二个目录项，realpath 看不出来）。修：`realpathSync.native`
  比对 runs 根 + `nlink > 1` 一律拒绝（`linked-file`）。
- **`contribute --id` 路径穿越写（高）**：`--id ../../..` 把病例写出 `--repo` 之外，
  `--force` 还能覆盖任意 `.md`。修：id 走 `isSafeCaseId`（与本地病例同一白名单），
  落点必须在 `docs/cases` 里。
- **`--html` 守卫名不副实（中）**：原判据是"文件里有没有 `<!doctype html`"——用户自己保存的
  任何网页都会被静默覆盖。修：报告写入 `<meta name="generator" content="dsh-doctor">`，
  守卫只认这个标记（旧版报告按标题兼容）。
- **`kit --to` 无条件覆盖（中）**：会静默顶掉目标目录里的 `急救.cmd` / `rescue.ps1` / `kit.json`。
  修：目标非空默认拒绝（`dir-not-empty`）；目录里已有我们导出的 `kit.json` 时仍幂等，或显式 `--force`。
- **`rescue.ps1` stdin EOF 无限刷菜单（低）**：重定向/非交互下 `Read-Host` 返回空，主循环空转
  （实测刷出 23MB 输出）。修：空输入直接退出。

### 仍不防（已声明，本轮补进文档）

- 急救包 `kit.json.pluginRoot` 未签名、`DSH_DOCTOR_NODE` 只验"文件存在"——同用户可改 = 非目标，
  但链路一步即触发：**急救包目录必须放在用户自己控制的位置**。
- `DSH_HOME` 环境变量即读写根（能控制进程环境 = 能控制写点）。
- HTTP 不校验 `Origin`/`Referer`（`Host` 已限回环，rebinding 面已收窄；非浏览器本机进程本就不受 CORS 约束）。

### 测试

- 155 → **159 项 / 24 个文件**；新增 4 条回归（硬链接、contribute id、kit 非空、rescue EOF）。

## 0.5.3 — 2026-11-07

第二轮红队（Kimi-K2.6 / GLM-5.3 盲测 + 主控逐条复现；上一轮 DeepSeek 双角色见 0.5.2）。
本轮**新增 4 条真跑通的边界问题**，全部有回归钉子。

### 修复

- **Host 头不校验（中）**：只比对公开常量 `x-dsh-doctor: 1` 不算"同源"——DNS rebinding 下
  攻击者页面与服务同源，能自己带这个头并读回响应。实测伪造 `Host: evil.example` 的 GET/POST
  都返回 200。修：Host 必须是回环名（127.0.0.1 / localhost / ::1），否则 403 `bad-host`。
- **会话 reading 跟随 junction（中）**：`sessions/` 里一个指向根外的 junction 能让"只读自己的
  DSH_HOME"变成读任意目录（实测扫到了根外的会话文件）。修：逐目录 `realpathSync.native`
  白名单（普通 `realpathSync` 不解析 junction），逃出根的跳过并计数、出 `errors` 说明。
- **同一 home 重复计数（低）**：`DSH_HOME` 写成 `D:/x/.dsh` 与 `D:\x\.dsh` 会被当成两个 home，
  结论重复（实测 7 条 → 8 条、warn 3 → 4）。修：`candidateHomes` 按规范化路径去重。
- **GET 解析放大（中）**：`listRuns` 对每个历史文件**整份 JSON.parse**，30 个 4MB 历史 ≈ 121MB
  主线程解析。修：单文件超 512KB 只给元数据（`truncated: true`），整轮解析预算 4MB；
  `?run=` / 最新一份超过 8MB 拒绝解析。

### 新增

- `test/security/redteam.test.mjs` 加 5 条回归（Host、junction、home 去重、runs 预算、contribute 代码来源）。

### 测试

- 150 → **155 项 / 24 个文件**；`tools/attack-probe.mjs` 全绿。

## 0.5.2 — 2026-11-07

红队实测后的加固（沙箱：`tools/security-lab.mjs`，19 条尝试 / 9 条真跑通）。

### 修复

- **ReDoS（严重）**：单行 1.2MB 日志让主线程卡 **94 秒**。修：单行采样 2KB + 去掉无界 `[^
]*` 间隙，现 **3ms**。
- **令牌外泄（高）**：`check --json` 与 HTTP 响应返回**未脱敏** payload（`ghp_`/`glpat-`/`xoxb-`）。修：`runCheck` 返回前脱敏，并补 4 类令牌规则。
- **日志注入（高）**：任意一行含 `host outbound proxy policy installed` 就能擦掉之前的故障（1→0）。修：只认结构化启动事件 `"event":"shell-load.start"`。
- **静默漏报（高）**：会话帧里内嵌 4 字节 magic 可让内容被丢弃且不报警。修：坏帧 > 0 时出 `SESSION.SCAN.UNAVAILABLE`（unknown）。
- **本地病例命令（高）**：同名覆盖可把任意命令变成「复制即用」。修：本地来源强制加「未审核」标注。
- **模板注入（高）**：`repair.template` 会带攻击者 Markdown。修：标题去换行与 Markdown 控制符。
- **报告放大（中）**：3 万条结论 → 27MB。修：结论上限 200 + `REPORT.FINDINGS.TRUNCATED`。
- **--html 覆写（高）**：可覆盖任意文件。修：非本工具生成的报告拒绝覆盖（`--force` 放行）。

### 新增

- `tools/security-lab.mjs`：多模型红队沙箱（假 HOME / 假日志 / 审计包装器）。
- `test/security/redteam.test.mjs`：6 条回归钉子。

### 测试

- 144 → **150 项 / 24 个文件**。

## 0.5.1 — 2026-11-07

安全加固 + 贡献傻瓜化（对应 SECURITY.md 重写）。

### 加固

- **解压炸弹**：会话帧逐帧加 `maxOutputLength: 8MB`，在**分配之前**拦截（zstd 实测可膨胀 32,467×）；命中即整份放弃并记 unknown。
- **CSRF**：`POST /dsh-doctor/api/report` 必须带 `x-dsh-doctor: 1`，否则 403。跨源简单请求带不了自定义头。
- **执行前 diff**：急救包在改 `cordis.patch.yml` 前，把前后各两行与将要插入的那行打印出来。

### 新增：一键起草病例

- `dsh-doctor case-from <finding-id> [--dry-run]`：症状 / 判定签名 / 处置命令三节自动填，根因留给人。
- 设置页「体检」每条结论旁的「写成案例」复制这条命令（客户端调不了工具，不假装能一键写）。

### 文档

- `SECURITY.md` 按**攻击面**重写：会话层 / HTTP 路由 / 修复执行面 / 案例库 / 脱敏；每条断言都指向一个跑得起来的测试。
- 明确两套权限模型：**插件只读** vs **急救包可执行**。

### 测试

- 131 → **144 项 / 23 个文件**（新增 `test/security/hardening.test.mjs` 7 项、`test/case-draft.test.mjs` 5 项、BOM 回归 1 项）。

## 0.5.0 — 2026-11-07

从"能诊断"走到"能动手"：新增**会话层取证**与**一键修复**。

### 新增：会话层检查（只读统计，不碰正文）

- 会话文件是**多帧 zstd**：整段 `zstdDecompressSync` **只解第一帧**（真机实测：3.2MB / 2,481 帧只吐出 187 字节）。
  自带帧游走器，按 magic `28 B5 2F FD` 切段逐帧解；只读尾部窗口，跳过窗口首的半帧。
- 默认只扫**最近一个会话的尾部 1MB**（实测 951 帧 / 1,529 事件 / 整条体检 0.34 秒）；
  `deepSessions` / `--deep-sessions` 放宽到 24 小时内所有会话（每个尾部 2MB）。
- 两条判定：
  - `SESSION.EMPTY_TURN`（warn）：一轮里只有推理、**既无正文也无工具调用**；
  - `SESSION.REPETITION.COLLAPSE`（warn）：单条 ≥20k 字符的消息里，同一短单元出现 ≥100 次**且覆盖率 ≥50%**。
- **隐私**：只输出数字（第几轮、重复次数、占比），会话原文一律不进报告、不进 `runs/`。
- 判定签名与案例：`docs/cases/2026-11-06-reasoning-repetition-collapse.md`。

### 新增：修复计划（数据）与急救包执行器

- `dsh-doctor plan [--json]`：把体检结论翻译成**动作清单**（枚举白名单：`start-service` / `disable-plugin-entry` / `restore-file` / `open-dir`）。
  - A 类（零风险）：端口没在跑 → 启动对应宿主；
  - B 类（需确认）：**日志点名**的坏插件 → 在 `cordis.patch.yml` 里禁用那一条；
  - C 类：会话损坏、ACL、重装内核等 → **只给文字指路，永不产动作**。
  - 没有点名就不动手（不按"最近改过"猜）。
- 急救包菜单新增 **6 一键修复** / **7 回滚上一次修复**：
  每个动作固定"备份 → 执行 → 验证 → 记日志"；`start-service` 验证到端口监听（30 秒），文件类验证到内容匹配；
  备份在 `<急救包>/backups/<时间戳>/`，每个被改文件留 `.path` 边车记录原始路径。
- 无 Node 时退化成内置最小计划（只做 A 类启动），并明确说明"完整修复需要 Node"。
- 执行器只认枚举动作；`Invoke-Expression` / `cmd /c $变量` 一律不出现（有结构测试钉着）。

### 测试

- 115 → **131 项 / 21 个文件**（新增 sessions 8 / repairs 7 / kit 结构 1）。

## 0.4.0 — 2026-11-06

案例库从"一堆文件"变成**有类型、有生命周期、能检索**的知识库。

### 新增：案例类型 `runtime` / `authoring`

- 正文里 `## 类型` 一节声明；**缺省 `runtime`**，现有 12 条零改动。
- `runtime` **必须**有「判定签名」（lint 从警告升为错误）——没有它，别人无法判断是不是同一个坑；
  `authoring` 保持建议级。
- `doctor_case_add` / `doctor_contribute` 新增可选 `kind` 参数（写 `authoring` 时会自动带上类型节）。

### 新增：本地病例的退役标记

- `dsh-doctor case-promote <本地id> <共享id>`：在本地病例标题下方的引用块里写一行 `> promoted: <id>`，
  **不删文件**；`doctor_cases` 索引标注「已合入共享库」。
- 本机那条与共享库重复的 `local-20261021-webRuntime` 已按此标记。

### 新增：案例检索

- `doctor_cases` 新增 `search` 参数；CLI `dsh-doctor cases --search "关键词"`。
- 多词 **AND**、大小写不敏感、搜全篇、结果带**命中片段**与类型标注；不做相似度排序。

### 新增：陌生人模板

- `docs/cases/_TEMPLATE.md`：照着填就能提 PR；下划线开头的文件不进 lint、索引与检索。

### 修复（真机静默错误）

- **INDEX 的「根因摘要」列一直是空的**：`tools/index-cases.mjs` 里正则少了 `m` 标志，`^` 只匹配文件开头，
  于是 15 条案例的摘要全显示 `—`。解析逻辑已抽进 `lib/cases.js`（`caseTitle` / `caseSummary`）并加了单测。

### 新增：修好之后的贡献提醒

- 服务端在「上一轮非全绿 → 这一轮全绿」时判定**修复发生**，`payload.repair` 带上 `fixedCount` / `fixedIds`
  与**预填好骨架的病例模板**；同时给出一条 `CASE.CONTRIBUTE.SUGGESTED`（info，CLI/Agent 也看得到）。
- 客户端在会话头部徽章处弹出提醒：复制模板 / 看报告 / 忽略这次（按时间戳记住，不再打扰）。
- 判定刻意收紧：**只在 ok 与非 ok 之间跨越时触发**——半修不修的时候提醒，只会制造噪音。

### 新增三条 authoring 案例

- `2026-11-06-plugin-entry-silent-inactive` —— 插件整条"静默不激活"的两种形态（value schema DSL 不支持 `required`；`inject` 未声明的服务）
- `2026-11-06-windows-script-encoding` —— `.cmd` 必须纯 ASCII / `.ps1` 必须带 BOM / 捕获子进程输出要临时切 UTF-8
- `2026-11-06-redaction-allowlist-leak` —— 白名单式脱敏必然漏字段（`engines[].id` 带出用户名）

测试 97 → **110 项 / 18 个文件**。

## 0.3.0 — 2026-11-06

面向"只会双击"的用户：**宿主全崩时也要能自救**，平时也要"随手就能看"。

### 新增：急救包（宿主外）

- `dsh-doctor kit --to <目录>` / `doctor_export_kit` 导出一个双击即用的目录：
  `急救.cmd`（纯 ASCII 门铃）→ `rescue.ps1`（UTF-8 BOM，中文菜单）→ `kit.json`（薄启动器找最新代码）→ `payload/`（内置副本）。
- 五级运行环境级联探测：`DSH_DOCTOR_NODE` → `PATH node` → npm 全局 node → 便携扩展包 → 桌面端 Electron（`ELECTRON_RUN_AS_NODE`）。
  **每一级都写进日志与报告**；全都没有时用 PowerShell 做系统层检查，出一份「简化版」HTML，不交白卷。
- 动作白名单只有四个：启动网页端 / 启动桌面端 / 打开急救包目录 / 打开 DSH 配置目录。
- 每次运行写 `run-<时间>.log`（可事后取证），报告里注明这次用的是"插件目录的最新代码"还是"内置副本"。

### 新增：共享 HTML 报告

- `lib/html.js` 是**唯一**的 HTML 实现，插件与急救包共用；`check --html <file>` 生成自包含报告
  （三段式：顶部一句话+一个动作 / 中间问题卡片 / 底部折叠 JSON；零外部资源，离线可开）。

### 新增：运行层「装了却没在跑」

- 真机缺口：关掉桌面端后报告一片绿 —— 端口层只比对"profile 声明过的端口"，43120 不在任何 profile 里。
- 现在用**本机确实装了哪个宿主**反推应有的端口：`PORT.HOST.NOT_LISTENING`（info，带可复制的启动命令）与
  `PORT.ALL_HOSTS.DOWN`（warn，标记为头条）。报告顶部因此会直接显示「有服务没在运行 / DSH 没在运行」。
- 没装桌面端的机器不会误报（有单测钉着）；探测失败（unknown）也不算"没在跑"。

### 新增：头部徽章与修理清单

- 会话界面右上角新增「体检」小徽章（`conversation.session.header.utilities`），按 `verdict` 变色，点开即看结论并可现场重扫；`headerBadge: false` 可隐藏。
- `dsh-doctor fix`：只输出「照抄即可」的命令清单，**不执行**；`--json` 里带 `fix[]`，供 Agent 取用。

### 工程

- 第七个工具 `doctor_export_kit`；`inject` 增加 `webServer`。
- 测试 77 → **92 项 / 15 个文件**（新增 html 7 / kit 6 / client 徽章 1 / 插件 route 1）。

## 0.2.0 — 2026-11-06

从「一份能看的报告」升级成「一份能被机器信任的结论」。五组改动：

### 1. 结论契约（破坏性）

- **每条结论有稳定 id**（`PORT.DECLARED.NOT_LISTENING`、`ABI.PEER.UNSATISFIED` …），文案可以改，id 不改。
- **新增第五级 `unknown`**：「我取不到证」不再被压成「正常」或「故障」。触发条件包括端口探测失败
  （只有 `ECONNREFUSED` 才算"确定没听"，超时/EPERM 一律 unknown）、`DSH_HOME` 读不动、profile 扫描被上限截断、日志目录读不动。
- **`doctor_check` 返回结构化对象**（`schemaVersion / findings / summary / verdict / exitCode`），`render` 仍出 Markdown。
- **退出码新增 3 = 无法完整取证**；优先级 `fault(2) > unknown(3) > warn(1) > ok(0)`。
- CLI `check --json` 与工具返回**同一份形状**。

### 2. 体检历史（新增写点）

- 每轮结论（脱敏后）落到 `$DSH_HOME/dsh-doctor/runs/`，按**内容 hash** 去重（`generatedAt` 不参与 hash，
  否则面板每刷一次就多一个文件），保留最近 30 条。
- 新工具 `doctor_runs` 与 CLI `dsh-doctor runs` 读历史。
- `saveRuns: false` 回到纯只读；写失败只降级成一条 info，不影响结论。
- 只写**当前宿主自己的** DSH_HOME（写别人的 home 是越界）。

### 3. 两个「不等出事」的检查

- **ABI 静态检查**：逐个 profile 解析 `dsh.profile.bundles`，报「解析不到」与「peer 范围不满足本机内核」。
  自带零依赖 mini-semver（只认 `^ / ~ / >= / < / = / *`、空格合取、`||` 析取；其余返 null 判 unknown）。
  最高只到「注意」—— 它能证明这个 profile 装不对，证明不了当前宿主正在用它。
- **升级假成功**：默认只给版本漂移 info；`deepWriteProbe: true` 时才做"写空文件再删"的真探针，失败才 fault。
  原因：`fs.access(W_OK)` 在 Windows 上看只读属性而非 ACL，本机实测一个 ACL 只读的目录仍返回"可写"。

### 4. 面板与结论可操作性

- 设置页新增**「体检」**页（读 `/dsh-doctor/api/report`，显示最近一次结论 + 「重新扫描」；宿主无 `webServer` 时降级为复制命令，不白屏）。
- 结论自动带上**可复制的处置命令**：只从病例的 `## 处置命令` 章节抽，**不从散文/表格里猜**。
- `finding.caseId` 指向随包案例库（`docs/cases/<id>.md`）；`runbook` 字段保留但只做本地内部对齐
  （`_ops/runbook.md` 不随包分发，对外是悬空指针）。

### 5. 打包

- 包名改为 **`@qweit-crystal/dsh-doctor`**（裸名 `dsh-doctor` 在 npm 上属于另一个无关项目）。
- entry id 仍是 `dsh-doctor`；客户端模块 id 跟包名一致（加载器按包名登记模块）。
- 测试 33 → **73 项 / 12 个文件**；`docs/cases` 12 条，`node tools/lint-cases.mjs` 通过。

### 修复（0.2.0 装机时真机踩到的）- **整条 entry 不激活**：`doctor_check` 的输出 schema 里写了 `required`，而宿主对 `output.schema` 用的是
  「值 schema DSL」——不支持 `required`，且每个 object 节点必须显式 `additionalProperties`。
  已按实测规则重写 schema，并加了一条**纯结构断言**（`test/plugin.test.mjs`）把这两个坑钉住，
  另用宿主真实 `defineTool` 对六个工具逐一复验通过。
- **同一份包以两个名字出现**：改名后 profile 里残留了旧的 `node_modules/dsh-doctor` 符号链接，
  会让客户端模块重复注册；已删。
- **设置页「体检」一直显示降级页**：`inject` 只声明了 `tools`，而 cordis 对**未声明的服务**是直接抛
  `cannot get property "webServer" without inject`，被 try/catch 吞掉 → 路由静默没注册。
  已把 `webServer` 加进 `inject`，并在注册失败时打 warn（不再静默降级）；补了一条 inject 契约测试。
- **历史文件里漏了用户名**：第一版 `redactPayload` 是"挑字段脱敏"，漏了 `discovery.engines[].id`
  （形如 `npm:C:\Users\<user>\AppData\Roaming\npm`）。白名单式脱敏迟早起漏，改成**无条件递归全量脱敏**，
  并用一条"整份 JSON 不含用户名/主机名/主目录"的测试守着（`test/redact.test.mjs`）。

### 真机验证（2026-11-06，桌面端 2.0.18 / 内核 0.2.1-rc.2）

- 插件 entry 激活，六个工具注册成功；日志无 `did not activate` / `JsonSchemaError`。
- 设置页「体检」→「开始体检」跑通：面板 → `/dsh-doctor/api/report` → `runCheck` → `runs/` 落盘。
- 重启后新写入的历史文件里 `engine.id = npm:<home>\AppData\Roaming\npm`、`host = <host>`，
  用户名/主机名/主目录均为占位符 —— 脱敏在**宿主真实写入**的路径上验过，不只是单测。

## 0.1.0 — 2026-10-22

首个可分享版本。

### 能力

- **多引擎发现**：本机所有 `DSH_HOME`（含桌宠的 `dsh-home`）、每个 profile 的 bundles/依赖/声明端口、npm 全局内核、桌面端安装、在听端口。
- **分层体检**：端口（纯 TCP，不依赖 WMI/CIM）→ profile 装配 → 桌面端日志签名 → 带「对策库 #章节」指针的报告。
- **两库案例库**：共享库（随包，只读，PR 审阅增长）+ 本地库（`$DSH_HOME/dsh-doctor/cases`，可写），同名 id 本地覆盖共享。
- **设置面板「贡献病例」页**：客户端模块注册到 `settings.section` 槽位。
- **一键贡献**：`doctor_contribute` 生成脱敏草稿 → `tools/contribute.mjs` 一条命令完成入册/索引/检查/提交/推送/开 PR。
- **离线 CLI**：`bin/dsh-doctor.mjs`（engines / check / cases / contribute），不依赖 DSH 运行。
- **机械门禁**：`tools/lint-cases.mjs`（文件名/必备章节/指纹泄漏/体积/索引一致性）+ `case-check.yml` + `ci.yml`。

### 修复（真机踩出来的）

- 插件整条不激活：`Config` 缺少 Standard Schema（`~standard.validate`）、缺少 `inject`、包内测试桩顶替宿主包 —— 分别修正并加断言。
- 本地案例库目录尚不存在时，首次写入被误判为越界（`isInside` 用最近祖先、`saveLocalCase` 先建目录再校验）。
- 两个 `.cmd` 包装脚本的退出码被 `pause` 吃掉（改为 `set RC` + `exit /b %RC%`）。

### 安全

- `lib/` 零执行面（无 `child_process` / `vm` / `eval` / `new Function`），由静态断言守着。
- 读取白名单 + 有界读取 + 输出脱敏 + 反注入围栏（日志内容无法逃出代码围栏）。
- 唯一写点是本地案例库；`allowLocalCaseWrite: false` 可回到完全只读。

### 修复（发布前审查，2026-10-22 下午）

- `dsh-doctor check` 默认**空绿**：CLI 与插件工具的 `deep` 默认值不一致，且端口层只查 profile 声明（当前 profile 都没声明）。改为默认扫日志（`--no-deep` 跳过）、报告区分「已扫描 N 个文件」与「未扫描（原因）」、端口层补「在听但未声明」的信息项并展示 warnings。
- 宿主包解析链补 `process.argv[1]` 祖先链：web 宿主从 `<内核>/lib/bin.js` 启动，`@deepseek-ai/dsh-tools` 在内核嵌套 `node_modules` 里；之前只能退化兜底。新增 `dsh-doctor where` 自检。
- 包名澄清：npm 裸名 `dsh-doctor` 已被他人占用（astra3294，0.4.3），统一改用 `@qweit-crystal/dsh-doctor`。
- 补 `repository` / `homepage` / `bugs` 与 `publish.yml`（`v*` tag 触发、CI 全绿、`NPM_TOKEN` 齐备才发）；一键贡献标记 experimental。
