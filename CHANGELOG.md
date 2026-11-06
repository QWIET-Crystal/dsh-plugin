# Changelog

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
