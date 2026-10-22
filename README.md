# dsh-doctor

> 一个**只读**的 DeepSeek Harness 体检插件：自动发现本机所有 DSH 引擎/实例，分层取证，并附一份从真实故障里长出来的案例库。

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
| 日志层 | 已知故障签名（插件被禁用、等已删除的服务、GPU 崩溃……） | 有些故障**不报错**，只留一行 warn |
| 判定层 | 故障/注意/正常 + 对策库指针 | 让"下一步做什么"可跳转 |

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

插件自动插入一行 `dsh-doctor`（见 `cordis.patch.yml`），无需手工改装配。

### 支持范围（实测）

| 项目 | 实测 |
| --- | --- |
| DSH 内核 | **0.2.1-rc.2**（桌面端 2.0.18 内置内核；全局 npm 内核同版本） |
| Node | >= 22.19.0（实测 24.20.0） |
| 其它内核版本 | **宽松 peer + 运行期降级**：解析不到宿主包时退化为"无设置页 / 最小形状工具 / CLI 照常"，不崩 |

## 提供的工具

| 工具 | 作用 |
| --- | --- |
| `doctor_engines` | 列出所有引擎/实例：每个 `DSH_HOME`、每个 profile 的 bundles/依赖/声明端口、npm 全局内核与桌面端版本、正在监听的端口（带常见端口标签） |
| `doctor_check` | 分层体检：端口、profile 装配、桌面端日志签名（默认扫日志）；输出带"对策库 #章节"指针的报告，日志行**先脱敏再围栏化** |
| `doctor_cases` | 读**两个**案例库：共享库（随包、只读）+ 本地库（本机沉淀、可写）；不带参数列索引，带 `id` 读单条并标注来源 |
| `doctor_case_add` | 把这次遇到的故障写进**本地**案例库（唯一写操作：只写本地库目录、强制脱敏、默认不覆盖） |
| `doctor_contribute` | 写本地草稿并给出**一条**上传命令（见"一键贡献"，标注 experimental） |

参数都很小：`refresh`（跳过缓存）、`deep`（是否扫日志）、`id`（案例编号）。

## 设置栏（DSH 设置页里自动出现一栏）

插件导出 `Config`（schemastery schema）后，DSH 的设置页会自动生成 **dsh-doctor** 一栏 —— 字段都带 `.volatile()`，可在线改：

| 字段 | 默认 | 作用 |
| --- | --- | --- |
| `maxProfiles` | 32 | 扫描 `DSH_HOME` 下最多多少个 profile |
| `maxLogBytes` | 2 MiB | 单个日志文件读取上限（超限标注 `truncated`） |
| `httpTimeoutMs` | 1200 | 端口连通性探测超时 |
| `cacheTtlMs` | 15000 | 发现结果缓存（0 = 每次重扫） |
| `casesPrefer` | `local` | 同名案例 id 优先读哪个库 |
| `localCasesDir` | `$DSH_HOME/dsh-doctor/cases` | 本地案例库目录 |
| `sharedCasesDir` | 包内 `docs/cases` | 共享案例库目录；可指向你 clone 的仓库，`git pull` 即更新 |
| `allowLocalCaseWrite` | `true` | 设 `false` 回到完全只读 |
| `contributeGuide` | 四步流程 | **提醒用**：`doctor_case_add` → 复制进 `docs/cases/` → 重建索引 → 开 PR；合并后别人 `git pull` |

> 设置栏里的**显示名**由 `cordis.patch.yml` 的 `label` 决定 —— 本项目设为 **贡献病例**（客户端读 `entry.options.label`；宿主版本不认 `label` 时会回退显示条目 id `dsh-doctor`）。

> schemastery 在不同 DSH 版本里可能叫 `schemastery` 或 `@deepseek-ai/schemastery`，插件运行期解析；
> 解析不到时 `Config` 为 `undefined` —— 插件照常工作，只是没有设置栏（优雅降级）。

## 安全模型（详见 [SECURITY.md](SECURITY.md)）

- **零执行面**：不 import `child_process` / `vm`，不用 `eval` / `new Function`；单测里有一条**静态断言**守着这条规矩。
- **读文件必须落在白名单根内**：`realpath` 之后比对，`..` 穿越与指向外部的符号链接一律拒绝。
- **有界读取**：只读常规文件、按字节截断、显式标注 `truncated`。
- **输出脱敏**：用户名、主机名、用户主目录、临时目录、`ghp_*`/`sk-*`/`Bearer`/URL userinfo 全部替换为占位符。
- **反注入**：外来文本进 Markdown 围栏前先中和反引号，日志内容无法逃出围栏变成"文档指令"。

## 两个案例库（本地 + 共享）

| | 共享库（shared） | 本地库（local） |
| --- | --- | --- |
| 位置 | `<包>/docs/cases`（可用 `sharedCasesDir` 覆盖） | `<DSH_HOME>/dsh-doctor/cases`（可用 `localCasesDir` 覆盖） |
| 谁写 | 作者审核后合入；**插件只读** | 你（`doctor_case_add`，或手工放 .md） |
| 用途 | 通用病例：别人也踩得到的坑 | 本机特有：你这台机器的环境、版本、怪癖 |
| 索引 | `docs/cases/INDEX.md`（由 `tools/build-cases.mjs` 生成） | 自动枚举目录，无需索引 |

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
node --test test/            # 常规环境
node test/safety.test.mjs    # 在沙箱/受限环境里直接跑（测试运行器 spawn 会被拦）
```

安全测试覆盖：路径穿越、符号链接逃逸、读取上限、脱敏、围栏逃逸、执行面静态断言。

## 兼容性

- Node `>=22.19.0`；作为 DSH 插件运行时，`@deepseek-ai/dsh-tools` 由宿主提供（peer）。
- 桌面端日志扫描是**能力探测**：没有桌面端时该层自动跳过并给出 info，不会报错。
- 端口探测是纯 TCP 连通性；HTTP 语义（鉴权、401/403）刻意不做，避免把"要鉴权"误判成"挂了"。

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
dsh-doctor check          # 分层体检；退出码 0 全绿 / 1 注意 / 2 故障
dsh-doctor cases [id]     # 两库索引 / 读单条
dsh-doctor contribute --from <file> --pr
```

## 与同类工具的关系（2026-10-22 对比过）

| | 本项目 | [jorinyang/dsh-doctor](https://github.com/jorinyang/dsh-doctor) | [PerryLink/dsh-plugin-doctor](https://github.com/PerryLink/dsh-plugin-doctor) |
| --- | --- | --- | --- |
| 定位 | 运行期健康体检 + 案例库 | 诊断 + 修复 + 回滚 + 运行时自愈 | 插件发布前的核验标准 |
| 多引擎发现 | ✅ 所有 DSH_HOME / profile / npm / 桌面端 | ❌ 单一环境 | ❌ 面向单个插件包 |
| 案例库 | ✅ 本地+共享两库、脱敏、linter、CI | ❌ | ❌ |
| 修复能力 | ❌（只读） | ✅ journal + LIFO 回滚 | ❌ |
| 离线入口 | ✅ `bin/dsh-doctor.mjs` | ✅ CLI（postinstall 装到全局 PATH） | ✅ bin CLI |
| 测试 | ✅ 30+ 项（安全 / 契约 / 客户端） | ❌ 无 | ✅ `tests/*.mjs` |
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
