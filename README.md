# dsh-doctor

**中文** · [English](README.en.md)

> 一个**以只读取证为主**的 DeepSeek Harness 体检插件：自动发现本机所有 DSH 引擎/实例，分层取证，
> 结论带**稳定 id** 与**「无法取证」**态，并附一份从真实故障里长出来的案例库与体检历史。
> 写点只有两处（本地案例库、体检历史），都可一键关掉。

[DeepSeek Harness](https://github.com/anywhere-labs/dsh-desktop)（DSH）一台机器上经常同时存在多个引擎/实例：
npm 全局内核、桌面端内置内核、若干 `DSH_HOME`（用户目录的 `.dsh`、桌宠的 `dsh-home`……），
每个 home 里还有多个 profile（每个 profile 就是一套插件装配）。
出故障时最容易误判的一句话是 —— **"HTTP 有应答，所以服务还在"**。

`dsh-doctor` 把这件事拆成可复现的几层，逐层取证：

| 层 | 看什么 | 为什么必须单独看 |
| --- | --- | --- |
| 发现层 | 所有 `DSH_HOME` / profile / npm 全局内核 / 桌面端安装 / 在听端口 | 不知道有几套引擎，就不知道"坏了没" |
| 端口层 | TCP 连通性（不依赖 WMI/CIM） | `Get-NetTCPConnection` 在受限令牌下会**假阴性** |
| 装配层 | 每个 profile 的 `bundles` / 依赖 / `cordis.patch.yml` | 装了不加载 = 白装 |
| ABI 层 | 每个 bundle 能否解析到、`peerDependencies['@deepseek-ai/dsh']` 是否满足本机内核 | **升级内核前**就能知道哪些插件会挂，而不是等 `Failed to load plugins` |
| 日志层 | 已知故障签名（插件被禁用、等已删除的服务、GPU 崩溃……） | 有些故障**不报错**，只留一行 warn |
| 判定层 | 故障 / 注意 / **无法取证** / 信息 / 正常 + 案例指针 | "取不到证"和"证明确实坏了"是两件事 |

## 安装

```bash
# 作为 DSH 插件（bundle）
dsh plugin --profile <name> add @qweit-crystal/dsh-doctor

# 或从 GitHub 直装（最新 main）
dsh plugin --profile <name> add github:QWIET-Crystal/dsh-plugin

# 或本地开发目录（改代码即时生效，配合宿主 HMR）
dsh plugin --profile <name> add "link:/path/to/dsh-plugin"
```

> ⚠️ **包名**：npm 上的裸名 `dsh-doctor` 属于**另一个无关项目**（astra3294，0.4.3），请务必用 scoped 全名
> `@qweit-crystal/dsh-doctor`；只写 `dsh-doctor` 会装到别人的包。

插件自动插入一行（`cordis.patch.yml` 里 `id: dsh-doctor`、`name: '@qweit-crystal/dsh-doctor'`），无需手工改装配。
entry id 保持 `dsh-doctor` 不变，改的只是包名 —— 客户端模块按**包名**登记，两者别混。

### 支持范围（实测）

| 项目 | 实测 |
| --- | --- |
| DSH 内核 | **0.2.1-rc.2 / 0.2.1-rc.5**（桌面端 2.0.18 内置内核；全局 npm 内核） |
| Node | >= 22.19.0（实测 24.20.0） |
| 其它内核版本 | **宽松 peer + 运行期降级**：解析不到宿主包时退化为"无设置页 / 最小形状工具 / CLI 照常"，不崩 |

## 提供的工具

| 工具 | 作用 |
| --- | --- |
| `doctor_engines` | 列出所有引擎/实例：每个 `DSH_HOME`、每个 profile 的 bundles/依赖/声明端口、npm 全局内核与桌面端版本、正在监听的端口（带常见端口标签） |
| `doctor_check` | 分层体检，返回**结构化对象**（`findings[]` 带稳定 id / level / caseId / fix），同时渲染成 Markdown；日志行**先脱敏再围栏化** |
| `doctor_runs` | 读体检历史：不带参数列最近若干条（时间 / 判定 / 计数），给文件名读一条完整结论 |
| `doctor_cases` | 读**两个**案例库：共享库（随包、只读）+ 本地库（本机沉淀、可写）；不带参数列索引、给 `id` 读单条、给 `search` 做全文检索（多词要求同时出现，带命中片段） |
| `doctor_export_kit` | 导出**急救包**到指定目录：宿主全崩、Agent 也不在场时，人双击「急救.cmd」就能体检并拉起服务 |
| `doctor_case_add` | 把这次遇到的故障写进**本地**案例库（写点①：只写本地库、强制脱敏、默认不覆盖） |
| `doctor_contribute` | 写本地草稿并给出**一条**上传命令（见"一键贡献"，标注 experimental） |

参数都很小：`refresh`（跳过缓存）、`deep`（是否扫日志）、`id`（案例编号）、`limit` / `name`（历史）。

## 设置栏（DSH 设置页里自动出现）

插件导出 `Config`（schemastery schema）后，DSH 的设置页会自动生成该插件的栏目 —— 字段都带 `.volatile()`，可在线改。
客户端往左栏注册了**两页**：**「体检」**（读宿主路由，看最近一次结论并可现场重扫）与**「贡献病例」**（四步贡献流程）。

| 字段 | 默认 | 作用 |
| --- | --- | --- |
| `maxProfiles` | 32 | 扫描 `DSH_HOME` 下最多多少个 profile |
| `maxLogBytes` | 2 MiB | 单个日志文件读取上限（超限标注 `truncated`） |
| `httpTimeoutMs` | 1200 | 端口连通性探测超时 |
| `cacheTtlMs` | 15000 | 发现结果缓存（0 = 每次重扫） |
| `casesPrefer` | `local` | 同名案例 id 优先读哪个库 |
| `localCasesDir` | `$DSH_HOME/dsh-doctor/cases` | 本地案例库目录 |
| `sharedCasesDir` | 包内 `docs/cases` | 共享案例库目录；可指向你 clone 的仓库，`git pull` 即更新 |
| `allowLocalCaseWrite` | `true` | 写点①：设 `false` 关掉本地案例库写入 |
| `saveRuns` | `true` | 写点②：每轮结论记进 `runs/`；设 `false` 回到纯只读 |
| `runsRetention` | 30 | 历史保留条数（超出删最旧的） |
| `deepWriteProbe` | `false` | 对桌面端安装目录做"写空文件再删"的真探针（**写操作**，见下"已知限制"） |
| `headerBadge` | `true` | 会话界面右上角显示「体检」小徽章（有问题变色；设 `false` 隐藏） |
| `contributeGuide` | 四步流程 | **提醒用**：`doctor_case_add` → 复制进 `docs/cases/` → 重建索引 → 开 PR |

> schemastery 在不同 DSH 版本里可能叫 `schemastery` 或 `@deepseek-ai/schemastery`，插件运行期解析；
> 解析不到时 `Config` 为 `undefined` —— 插件照常工作，只是没有设置栏（优雅降级）。

## 退出码与 JSON 契约

`doctor_check`（工具）与 `dsh-doctor check --json` 返回**同一份形状**：

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-11-06T05:07:15.114Z",
  "environment": { "platform": "win32", "node": "v24.20.0", "host": "<host>", "dshHome": "<home>/.dsh" },
  "discovery": { "homes": [], "engines": [], "probedPorts": [{ "port": 3080, "state": "open" }], "capabilities": {} },
  "logScan": { "scanned": [], "warnings": [], "capability": {} },
  "findings": [{ "id": "PORT.DECLARED.NOT_LISTENING", "level": "warn", "area": "运行", "text": "…", "caseId": "…", "fix": [] }],
  "summary": { "fault": 0, "warn": 1, "unknown": 0, "info": 4, "ok": 0, "total": 5 },
  "verdict": "warn",
  "exitCode": 1
}
```

| 判定 | 含义 | 退出码 |
| --- | --- | --- |
| `fault` | 有确定故障 | 2 |
| `unknown` | **有探测没完成**，所以"全绿/注意"不能当真 | 3 |
| `warn` | 没有真故障，但有需要看的项 | 1 |
| `ok` | 全绿 | 0 |

优先级：`fault` > `unknown` > `warn` > `ok`。有确定故障时先说故障；否则"证据不全"比"有点小毛病"更需要拦住自动化流程。

## 体检历史

每轮结论（**脱敏后**）落到 `$DSH_HOME/dsh-doctor/runs/<时间>-<内容hash>.json`：

- 同内容在 `cacheTtlMs` 窗口内**不重复写**（面板刷新/agent 连调不会刷出一堆文件）；
- 只保留最近 `runsRetention` 条；
- 只写**当前宿主自己的** `DSH_HOME`（一个插件服务一个宿主，写别人的 home 是越界）；
- 写失败只追加一条 info，**不改变结论**（取证不能因为"记不住"而失败）。

用 `doctor_runs` 或 `dsh-doctor runs` 读；设置页「体检」页也读它。

## 急救包（宿主全崩时唯一还能用的东西）

插件跑在宿主进程里——**宿主全死时插件自己也不在场**。所以另有一样可以提前导出的东西：

```bash
dsh-doctor kit --to "C:\Users\你\Desktop\DSH急救"   # 或让 Agent 调 doctor_export_kit
```

| 文件 | 作用 |
| --- | --- |
| `急救.cmd` | 双击入口。**纯 ASCII**——cmd.exe 按系统代码页解码批处理，中文会被拆成乱码命令 |
| `rescue.ps1` | 中文菜单 + 环境探测 + 动作。**UTF-8 带 BOM**——PowerShell 5.1 没有它会按 ANSI 解码中文 |
| `kit.json` | 版本 / 导出时间 / 插件安装路径（薄启动器靠它找最新代码） |
| `payload/` | 内置副本（插件被卸载后还能用，但**会过期**） |

菜单只有五个动作：① 体检并打开报告 ② 启动网页端（:3080）③ 启动桌面端 ④ 打开急救包目录 ⑤ 打开 DSH 配置目录。
**不改配置、不删文件、不执行看不见的动作**；每次运行写 `run-<时间>.log`（探测链走到第几级、每个动作的结果），
出了问题把这份日志发给维护者就够。

运行环境按五级级联探测，**每一级都写进日志和报告**：

1. `DSH_DOCTOR_NODE` 环境变量
2. `PATH` 里的 `node`
3. `%APPDATA%\npm\node.exe`
4. 便携扩展包 `@qweit-crystal/dsh-doctor-node`（可选安装）里的 `node.exe`
5. 桌面端 `DSH Desktop.exe` + `ELECTRON_RUN_AS_NODE=1`

全都不可用时**不交白卷**：用 PowerShell 做系统层检查（进程 / 端口 / 目录 / 日志尾），出一份「简化版」HTML。

> 为什么急救包可以执行、插件却坚持零执行面：急救包是**用户主动双击**的独立产物，权限模型不同；
> 插件住在宿主里，一动 `child_process` 就会让 `test/safety.test.mjs` 的静态断言失效。

## 安全模型（详见 [SECURITY.md](SECURITY.md)）

- **零执行面**：不 import `child_process` / `vm`，不用 `eval` / `new Function`；单测里有一条**静态断言**守着这条规矩。
- **两个写点，都可关**：本地案例库（`allowLocalCaseWrite`）与体检历史（`saveRuns`）。除此之外没有第三条写路径。
- **读文件必须落在白名单根内**：`realpath` 之后比对，`..` 穿越与指向外部的符号链接一律拒绝。
- **有界读取**：只读常规文件、按字节截断、显式标注 `truncated`。
- **输出脱敏**：用户名、主机名、用户主目录、临时目录、`ghp_*`/`sk-*`/`Bearer`/URL userinfo 全部替换为占位符。
- **反注入**：外来文本进 Markdown 围栏前先中和反引号，日志内容无法逃出围栏变成"文档指令"。
- **设置页路由**：`/dsh-doctor/api/report` 只允许同源访问（不设 CORS 头），返回的是**落盘前已脱敏**的内容。

## 两个案例库（本地 + 共享）

| | 共享库（shared） | 本地库（local） |
| --- | --- | --- |
| 位置 | `<包>/docs/cases`（可用 `sharedCasesDir` 覆盖） | `<DSH_HOME>/dsh-doctor/cases`（可用 `localCasesDir` 覆盖） |
| 谁写 | 作者审核后合入；**插件只读** | 你（`doctor_case_add`，或手工放 .md） |
| 用途 | 通用病例：别人也踩得到的坑 | 本机特有：你这台机器的环境、版本、怪癖 |
| 索引 | `docs/cases/INDEX.md`（由 `tools/build-cases.mjs` 生成） | 自动枚举目录，无需索引 |

### 类型：`runtime` vs `authoring`

每条案例可以在正文里用一节声明类型，**缺省是 `runtime`**：

```markdown
## 类型

authoring
```

| 类型 | 含义 | 门槛 |
| --- | --- | --- |
| `runtime` | DSH 运行期故障（前端死了、GPU 崩了、等已删除的服务……） | **必须有「判定签名」**，否则 lint 报错 |
| `authoring` | 插件/工具开发时踩的坑（宿主 schema DSL、注入、编码……） | 判定签名强烈建议，但不强制 |

### 检索

`doctor_cases` 带 `search`（或 CLI `dsh-doctor cases --search 关键词`）：空格分隔多个词**要求同时出现**，
大小写不敏感，结果带**命中片段**和类型标注。不做相似度排序——搜不到就是搜不到，比给一堆似是而非的更可信。

### 修好之后：提醒把这次写成案例

上一轮不是全绿、这一轮全绿时，插件判定**修复发生**：`payload.repair` 带上修好了几项、修好的是哪些 id，
以及一份**预填好骨架的病例模板**；会话头部徽章处弹出一次性提醒（复制模板 / 看报告 / 忽略这次，忽略按时间戳记住）。

判定刻意收得很紧：**只在 `ok` 与非 `ok` 之间跨越时触发**——"故障 5 项变 3 项"不算，半修不修的时候提醒只会制造噪音。

### 合入后怎么退役本地那份
本地病例合入共享库后，在本地文件里留一行标记（**不删文件**）：

```bash
dsh-doctor case-promote local-20261021-webRuntime 2026-10-21-plugin-waits-removed-service
```

它会在标题下方的引用块里写入 `> promoted: <共享库 id>`，`doctor_cases` 索引会标注「已合入共享库」。

### 给陌生人的最短路径

不想装任何东西：在 GitHub 网页上 fork → 新建 `docs/cases/<YYYY-MM-DD-短名>.md` → 照
[`docs/cases/_TEMPLATE.md`](docs/cases/_TEMPLATE.md) 填写 → 提 PR。
下划线开头的文件不会被 lint、索引或检索当成案例。

解析规则：

- **读取**按 `casesPrefer`（默认 `local`）先后命中，返回时标注来源（`本地库` / `共享库`）。
- **索引**两个库都列；同名 id 时本地覆盖共享，并在索引里标注"本地覆盖了同名共享条目"。
- **写入**只允许本地库，且要过四道守卫：id 不含路径分隔符 → 目标必须落在本地库内 → 内容强制 `redact()` → 默认不覆盖（`force=true` 才覆盖）。
- `allowLocalCaseWrite: false` 可彻底关掉写入，回到纯只读。

**怎么把本地病例贡献给共享库**（人工审阅，不自动回传）：

```bash
doctor_case_add → 复制进 docs/cases/ → node tools/index-cases.mjs → node tools/lint-cases.mjs → 开 PR
```

CI（`.github/workflows/case-check.yml`）会在 PR 上跑机械检查（文件名 / 必备章节 / 指纹泄漏 / 索引一致性），
维护者只需审语义 —— 贡献者看 [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)，维护者看 [docs/REVIEWING.md](docs/REVIEWING.md)（review → 合并 → 发版）。

## 共享库的来源

`docs/cases/` 最初是从本机 12 次真实事故**机械脱敏**生成的（路径/主机名/用户名/令牌已替换），后续由 PR 增长：

- 审批提示孤儿化、测试作业死锁、前端进程死亡、渲染层失控、GPU 崩溃回退软渲染
- 守护从沙箱内启动被回收、守护状态被重置
- 桌面升级静默安装"假成功"（退出码 0、文件没换）
- 内核升级后 `Failed to load plugins`（客户端模块表缺包）
- 插件在等已被内核删除的服务（`webRuntime`，永久 pending 的形态）
- 用户主动关停导致的"失踪"

重建方式：`node tools/build-cases.mjs <源目录> [输出目录] [工作区根]`。

## 测试

```bash
node --test test/            # 常规环境（12 个文件 / 70+ 项）node test/unknown.test.mjs   # 在沙箱/受限环境里直接跑（测试运行器要 spawn 子进程，会被拦）
node tools/lint-cases.mjs    # 案例库机械检查
```

测试覆盖：路径穿越、符号链接逃逸、读取上限、脱敏、围栏逃逸、执行面静态断言、三态端口取证、
历史去重与保留上限、semver 范围判定、ABI 静态检查、写权限探针、路由契约、命令抽取。

## 已知限制

- **宿主的 `output.schema` 用的是「值 schema DSL」，不是完整 JSON Schema**：不支持 `required`，
  且**每个 object 节点**都必须显式写 `additionalProperties: true|false`。
  0.2.0 第一次装进桌面端时就栽在这里——整条 entry 报 `JsonSchemaError` 不激活。
  现在 `test/plugin.test.mjs` 有一条纯结构断言守着这两条（不依赖宿主包，CI 也能跑）。
- **两种编码坑，各管一层**：`.cmd` 必须纯 ASCII（cmd.exe 按 GBK 解码，中文变乱码命令）；
  `.ps1` 必须带 UTF-8 BOM（PowerShell 5.1 没有它会按 ANSI 解码中文）。
  `test/kit.test.mjs` 两条都钉着，导出时也会强制补 BOM。
- **急救包导到桌面后就脱离了 npm 包**：薄启动器优先用插件目录里的最新代码，但插件被卸载后只剩内置副本，
  那份会过期——日志和报告里会注明这次用的是哪一份。
- **`fs.access(dir, W_OK)` 在 Windows 上不可信**：它看的是只读属性，不是 ACL —— 本机实测一个 ACL 只读的安装目录照样返回"可写"。
  所以「升级会不会静默失败」默认只给版本漂移的 info；要真判定必须打开 `deepWriteProbe`（真写一个空文件再删）。
- **ABI 静态检查最高只到「注意」**：它能证明"这个 profile 里的包解析不到 / peer 不满足"，证明不了"当前宿主正在用这个 profile"。
  为了一条不误报，宁可降级。多个内核并存时也无法确定某个插件实际配的是哪一个。
- **`## 处置命令` 章节是可选的**：没有该章节的病例不会给出可复制命令（只给案例指针）。这是刻意不猜——
  病例正文里的反引号一半是命令、一半是路径。

## 兼容性

- Node `>=22.19.0`；作为 DSH 插件运行时，`@deepseek-ai/dsh-tools` 由宿主提供（peer）。
- 桌面端日志扫描是**能力探测**：没有桌面端时该层自动跳过并给出 info，不会报错；目录存在但读不动则是 unknown（不是故障）。
- 端口探测是纯 TCP 连通性；只有 `ECONNREFUSED` 算"确定没听"，超时/EPERM 等一律记 unknown。
- HTTP 语义（鉴权、401/403）刻意不做，避免把"要鉴权"误判成"挂了"。

## 一键贡献（一条命令）｜ experimental

> 标记 **experimental**：它要跑 `git` / `gh`，前提是"仓库已 clone、`gh` 已登录、默认分支叫 main"。
> 环境不满足时它会明确报错而不是静默失败；不急用的用户可以只用 `doctor_cases` 读案例。

```bash
# 1) 让 Agent 调用 doctor_contribute → 写入本地库（已脱敏），回执里直接给出下面这条命令
# 2) 在仓库目录执行：
node tools/contribute.mjs --from "<本地库>/<病例>.md" --pr
```

它依次完成：**脱敏 → 写进 docs/cases/ → 重建索引 → 机械检查 → 建分支 `case/<id>` → 推送 → `gh pr create`**。
只想演算：`--dry-run`；只提交不推：`--no-push`；换仓库位置：`--repo <目录>`；覆盖同名：`--force`。

### 离线 CLI（DSH 挂了也能用）

```bash
dsh-doctor engines        # 本机所有引擎/实例（home/profile/npm/桌面端）
dsh-doctor check          # 分层体检；退出码 0 全绿 / 1 注意 / 2 故障 / 3 无法完整取证
dsh-doctor check --html <file>   # 额外生成自包含 HTML 报告
dsh-doctor fix            # 只输出「照抄即可」的修理清单（**不执行**）
dsh-doctor kit --to <目录> # 导出急救包（双击即用）
dsh-doctor runs [name]    # 体检历史：列最近若干条，或读某一条的完整 JSON
dsh-doctor cases [id]     # 两库索引 / 读单条
dsh-doctor cases --search "关键词"   # 全文检索（多词要求同时出现，带命中片段）
dsh-doctor case-promote <本地id> <共享id>   # 合入后给本地病例打退役标记
dsh-doctor contribute --from <file> --pr
```

`check` 默认扫日志、默认记历史；`--no-deep` 跳过日志、`--no-save` 不写历史。

## 与同类工具的关系（2026-10-22 对比过）

| | 本项目 | [jorinyang/dsh-doctor](https://github.com/jorinyang/dsh-doctor) | [PerryLink/dsh-plugin-doctor](https://github.com/PerryLink/dsh-plugin-doctor) |
| --- | --- | --- | --- |
| 定位 | 运行期健康体检 + 案例库 | 诊断 + 修复 + 回滚 + 运行时自愈 | 插件发布前的核验标准 |
| 多引擎发现 | ✅ 所有 DSH_HOME / profile / npm / 桌面端 | ❌ 单一环境 | ❌ 面向单个插件包 |
| 案例库 | ✅ 本地+共享两库、脱敏、linter、CI | ❌ | ❌ |
| 修复能力 | ❌（只读；只给可复制命令，不动手） | ✅ journal + LIFO 回滚 | ❌ |
| 离线入口 | ✅ `bin/dsh-doctor.mjs` | ✅ CLI（postinstall 装到全局 PATH） | ✅ bin CLI |
| 体检历史 | ✅ `runs/`（内容去重 + 保留上限） | ❌ | ❌ |
| 测试 | ✅ 70+ 项 / 12 个文件 | ❌ 无 | ✅ `tests/*.mjs` |
| 供应链门禁 | CI + 零执行面静态断言 | ⚠️ postinstall 会 `execSync` 并写全局 bin | ✅ Scorecard / actions / dependabot |
| 运行时依赖 | 零（客户端只 `require('react')`） | 零 | 零 |

**已吸取并落地的经验**：

1. **离线入口**（jorinyang）—— 插件活在宿主里，宿主挂了就等于没有插件；`bin/dsh-doctor.mjs` 只要有 Node 就能体检。
2. **门禁前移**（PerryLink）—— 新增 `.github/workflows/ci.yml`：每次 push/PR 跑全部测试 + 病例 lint + 索引一致性。
3. **包名与安装渠道写清楚**（PerryLink）—— 避免用户装到同名的无关包。
4. **刻意不学**：postinstall 改全局 PATH（安装即执行属于供应链面）；也不做自动修复（会破坏"零执行面"承诺，列 roadmap 另议）。

## 许可

MIT © 2026 QWIET-Crystal

贡献共享案例库的完整流程见 [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)（维护者看 [docs/REVIEWING.md](docs/REVIEWING.md)），变更记录见 [CHANGELOG.md](CHANGELOG.md)。
