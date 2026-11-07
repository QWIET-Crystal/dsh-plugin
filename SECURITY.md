# 安全模型（dsh-doctor 0.5.3）

> 这份文档在 0.5.0 之前写的是"插件唯一职责是只读取证"——**那句话现在不准确了**。
> 0.5.0 起有两套权限模型：**插件只读**，**急救包可以执行**。它们分开写、分开测。

## 一句话

| 产物 | 权限 | 写什么 | 谁触发 |
| --- | --- | --- | --- |
| **插件**（`lib/`，跑在宿主进程里） | **只读**，零执行面 | 本地案例库（可关）、体检历史（可关） | Agent 调工具 / 设置页点按钮 |
| **急救包**（`rescue/`，独立产物） | 可执行（枚举动作） | 启动服务、按计划禁用插件条目、还原备份文件 | **用户双击**，且逐条确认 |

---

## 1. 威胁模型

### 在范围内（不需要同用户权限就能触发）

| 攻击者 | 手段 | 我们的处置 |
| --- | --- | --- |
| 任意网页 | 对 `127.0.0.1` 发跨源 POST，触发体检、刷盘 | **CSRF 头**：POST 必须带 `x-dsh-doctor: 1`，跨源带不了 |
| 能写日志的程序 | 往桌面端日志塞一行，诱导"禁用某个插件" | 只有**点名且能在 patch 里找到同名条目**才产动作；插件名按正则转义 |
| 下载来的会话文件 | zstd 解压炸弹、深度嵌套 JSON | **单帧 8 MB 上限**（分配前拦截）、总量 32 MB、坏行跳过 |
| 恶意 Markdown / 案例 | 往报告里注入指令或逃出围栏 | 外来文本进围栏前先中和反引号 |

### 不在范围内（明确不防）

- **同机、同用户、同权限的进程**：它能直接改 `kit.json`、改 `.ps1`、读你的会话——加签名的收益极低。急救包的可信边界是"你双击的那个目录没人动过"。
- 网络攻击（插件不监听公网，只注册宿主本地路由）。
- 遥测/上报：不存在。

---

## 2. 攻击面逐条

### 2.1 会话层读取（0.5.0 新增）

**读什么**：`$DSH_HOME/sessions/*/*/session.v4.jsonl.zstd` 的**尾部窗口**（默认最近一个会话 1 MB，`deepSessions` 时 24 小时内每个 2 MB）。

| 风险 | 处置 | 测试 |
| --- | --- | --- |
| **解压炸弹**：单帧可膨胀数万倍（实测 64 MB 全零 → 2 KB，32,467×） | 逐帧 `maxOutputLength: 8 MB`，**分配前**拦截；命中即整份放弃并记 `unknown` | `test/security/hardening.test.mjs` · 「解压炸弹：单帧超限整份放弃」「上限是分配前的」 |
| 总量爆炸 | 累计解码上限 32 MB | 同上 |
| 畸形/半帧（窗口从中间切） | 跳过窗口首段；坏帧计数，全坏则 `decode-failed` | `test/sessions.test.mjs` |
| **junction / 软链逃逸**：`sessions/` 里放一个指向根外的链接 | 逐目录 `realpathSync.native` 比对 sessions 根（普通 `realpathSync` 在 Windows 上**不解析 junction**）；逃出根的跳过并计数、进 `errors` | `test/security/redteam.test.mjs` · 「junction 逃逸」 |
| 深度嵌套 JSON | `JSON.parse` 失败的行直接跳过，不抛 | `test/security/hardening.test.mjs` · 「深度嵌套 JSON」 |
| **隐私**：会话正文含用户对话 | 只输出数字（轮次/次数/占比），**原文不进报告、不进 `runs/`** | `test/sessions.test.mjs` · 「报告里不能出现会话原文」 |

### 2.2 HTTP 路由

`/dsh-doctor/api/report`：GET 读历史（不触发取证），POST 现场跑一轮（会写 `runs/`）。

| 风险 | 处置 | 测试 |
| --- | --- | --- |
| **CSRF**：任意网页用简单请求打 POST | 必须带 `x-dsh-doctor: 1`；缺了返回 **403**。跨源自定义头会触发预检，而我们不回 CORS 头 | `test/security/hardening.test.mjs` · 「CSRF：裸 POST 403」 |
| **DNS rebinding**：攻击者页面"同源"于 `127.0.0.1` | `Host` 必须是回环名（`127.0.0.1` / `localhost` / `::1`），否则 **403 `bad-host`**；GET 与 POST 同一道门 | `test/security/redteam.test.mjs` · 「Host 头」 |
| **GET 放大**：30 个 4MB 历史 → 每次全量 `JSON.parse` 121MB | 单文件 > 512KB 只给元数据（`truncated: true`）、整轮解析预算 4MB、单份 > 8MB 不解析 | `test/security/redteam.test.mjs` · 「历史列表」 |
| 刷盘 | 页面侧 2 秒节流（429）+ 单飞锁（同一时刻只跑一轮） | `test/http.test.mjs` |
| 路径穿越读文件 | `?run=` 只接受纯文件名（含分隔符一律 `bad-name`） | `test/security/hardening.test.mjs` · 「路径穿越」 |
| 跨源读数据 | 不设任何 CORS 头，浏览器默认拒绝读取 | `test/http.test.mjs` |
| 回显 | 返回的是**落盘前已脱敏**的内容 | `test/redact.test.mjs` |

### 2.3 修复执行面（急救包 0.5.0 新增）

这是唯一会改系统状态的地方，权限模型与插件完全不同。

| 风险 | 处置 | 测试 |
| --- | --- | --- |
| **任意命令执行**：把计划里的字符串当命令跑 | 动作类型是**枚举白名单**（`start-service` / `disable-plugin-entry` / `restore-file` / `open-dir`）；未知类型直接拒绝；`Invoke-Expression`、`cmd /c $变量` 一处都不出现 | `test/kit.test.mjs` · 「带修复执行器…没有跑任意命令的口子」 |
| **日志注毒**：伪造"某某插件不兼容"诱导禁用 | ① 必须点名（没名字不产动作，不按 mtime 猜）；② 名字 `regex` 转义；③ 必须在某个 profile 的 `cordis.patch.yml` 里找到同名条目 | `test/security/hardening.test.mjs` · 「插件名不会被当成正则」「没有点名就不产动作」 |
| 改错文件 | 执行前打印 diff（前后各两行 + 将被插入的行），B 类必须逐条确认 | `test/kit.test.mjs` · 结构断言 |
| 改坏了回不去 | 每个被改文件先备份到 `backups/<时间戳>/`，并写 `.path` 边车记录原始路径；菜单 7 一键回滚 | `test/kit.test.mjs` |
| 计划被篡改 | 计划在**内存里**生成并立即执行，不落盘 | 设计约束（无临时文件） |
| 提权 | 急救包**不提权**；遇到需要管理员的动作只打印命令 | `rescue/rescue.ps1` 无 `RunAs` |
| 编码陷阱 | `.cmd` 纯 ASCII、`.ps1` 强制 UTF-8 BOM（有测试钉着源文件） | `test/kit.test.mjs` · 「源文件也必须带 BOM」 |

### 2.4 案例库与两个写点

| 风险 | 处置 | 测试 |
| --- | --- | --- |
| 越界写 | 只有两处写：本地案例库（`allowLocalCaseWrite`）、体检历史（`saveRuns`）；都可关 | `test/safety.test.mjs` |
| 案例 id 穿越 | id 只允许安全字符；`readRun` / `case-promote` 拒绝分隔符 | `test/security/hardening.test.mjs` |
| 写进别人的 home | 只写**当前宿主自己**的 `DSH_HOME` | `test/runs.test.mjs` |
| 同一个 home 两种写法重复计数 | 候选 home 按**规范化绝对路径**去重（`D:/x/.dsh` 与 `D:\x\.dsh` 算一个） | `test/security/redteam.test.mjs` · 「同一个 DSH_HOME」 |

### 2.5 输出与脱敏

- 用户名、主机名、家目录、临时目录、`ghp_*` / `sk-*` / `Bearer` / URL userinfo → 占位符（**递归脱敏**，不是字段白名单——白名单漏过一次，见案例 `2026-11-06-redaction-allowlist-leak`）。
- 落盘和 HTTP 返回的都是脱敏后的版本（先脱敏，后写）。
- 外来文本进 Markdown 围栏前中和反引号。

---

## 3. 结构性保证（不是约定，是设计）

| 保证 | 怎么保证的 |
| --- | --- |
| 插件零执行面 | `lib/` 不 import `child_process` / `vm`，不用 `eval` / `new Function`；`test/safety.test.mjs` 静态断言 |
| 读取有界 | 所有读取走 `safeReadText`：`realpath` 后比对白名单根、按字节截断、标注 `truncated` |
| 三态端口取证 | `open` / `closed` / `unknown`；只有 `ECONNREFUSED` 判 `closed`，超时一律 `unknown` |
| 误报比不报更糟 | ABI 静态检查最高只到 `warn`；证据不足时给 `unknown` 而不是 `fault` |

---

## 4. 非目标

- 同用户本地篡改（见威胁模型）。
- 杀毒 / 反 Rootkit。
- 对宿主内核自身漏洞的防护。
- 多用户隔离。

---

## 5. 已知局限

- **HTTP 路由只接受回环 `Host`**：用局域网 IP 打开设置页时，这条路会 403（本插件只面向本机诊断）。
- 会话只读**尾部**：很长会话中段的退化不会被看到（`--deep-sessions` 也只是放宽窗口，不是全量）。
- 单帧 8 MB 上限是取舍：正常长消息（11 万字符 ≈ 300 KB）远低于它；超限的那份会话会记 `unknown`，不影响其它结论。
- CSRF 头要求 0.5.1+ 的页面配合：**旧页面 + 新内核**会让"重新扫描"返回 403（设置页会提示升级）。
- 急救包的备份不含"服务启动"这类无文件动作（回滚时只会还原文件）。

---

## 6. 报告漏洞

开 issue 或提 PR，附：复现步骤、影响面、你的威胁模型假设。
**请不要**把真实会话文件或含个人路径的日志贴进公开 issue——先脱敏，或用 `dsh-doctor check --json` 的脱敏输出。
