# 攻防测试记录

跑法：`node tools/attack-probe.mjs`（自动化探针）+ `node tools/security-lab.mjs`（多模型红队沙箱）。
每条探针的判据与 SECURITY.md 的断言一一对应。

---

## 2026-11-07 · 第二轮：Kimi 盲测 + 主控逐条复现（0.5.2 → 0.5.3）

### 这轮和上一轮的区别

- SiliconFlow 余额不足（HTTP 402），改走**各自官方 API 直连**：Moonshot `kimi-k2.6`（`thinking: disabled`）。
- **GLM 分支没拿到结果**：Z.ai `glm-5.3` 三次调用都把输出预算烧在推理通道（如 `reasoning_tokens: 13994 / 14000`，`content` 空），换 `glm-5.3-flash` 仍超时——本轮 GLM 不计分，如实记在这里。
- 只给源码（`lib/*.js` + `bin` + `rescue.ps1`），**不给 SECURITY.md**（盲测）。
- 它们只有文本通道，所以是**它们出攻击、主控在沙箱里原样执行**（方案里的降级路径）。
- 沙箱重建在 0.5.2 代码上：`_securitylab/run-20261107b`（假 HOME / 假 APPDATA / 独立实例 `:3999` / 审计包装器）。
- 工具型 DeepSeek 攻击者这轮没在预算内跑完，**不计分**；上一轮 DeepSeek 的结论保留在 0.5.2 那一节。

### 结果：主控复现 5 条真跑通，全部已修

| # | 攻击 | 提出方 | 自评 | 主控实测 | 处置 |
| --- | --- | --- | --- | --- | --- |
| 1 | **HTTP 不校验 `Host`**：DNS rebinding 可读全量历史 / 触发体检 | 承接上一轮 boundary 未复现项 | 中 | 伪造 `Host: evil.example` 的 GET 与 POST 都 **200**（POST 带公开常量头还会真跑一轮） | ✅ 只放行回环 Host，否则 403 `bad-host` |
| 2 | **会话扫描跟随 junction 逃出 `DSH_HOME`** | 主控 | 中 | `sessions/` 放一个指向根外的 junction，扫描器读到根外会话并计入 | ✅ `realpathSync.native` 白名单（普通 `realpathSync` 不解析 junction），逃出计数并进 `errors` |
| 3 | **同一 home 两种写法 → 结论重复计数** | 主控 | 低 | `DSH_HOME=D:/…/.dsh` vs `D:\…\.dsh`：7 条 → 8 条、warn 3 → 4 | ✅ 候选 home 按规范化绝对路径去重 |
| 4 | **GET 解析放大**：每个历史文件整份 `JSON.parse` | Kimi 提到放大、主控实测 | 中 | 10×2MB 历史：**45ms**（全量解析，0 条 truncated）→ 修后 **1ms**（10 条 truncated） | ✅ 单文件 >512KB 只给元数据、整轮预算 4MB、单份 >8MB 不解析 |
| 5 | **`contribute --repo` 执行该仓库里的 `tools/index-cases.mjs`** | Kimi（擦边） | 中 | 代码路径确认：`node <repo>/tools/index-cases.mjs`；本沙箱禁带管道子进程，marker 没落地，**沙箱外会执行** | ✅ 索引/校验改跑**本包自带**脚本，`--repo` 只当数据 |

### 被证伪的（模型声称、主控实测不成立）

| 声称 | 实测 |
| --- | --- |
| `?run=..\..\Windows\win.ini` 穿越（"只拦 `/`"） | 四种编码（`..%2F`、`..%5C`、`%2e%2e`、裸 `..`）全 **404 `bad-name`**；`readRun` 同时拦 `/`、`\`、`..` |
| 500KB 日志行触发 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` ReDoS | **510ms**（含 Node 启动）；该正则无无界量词，且单行已采样 2KB |
| `repair.template` 可 XSS | 客户端只把它写进剪贴板，不进 HTML（文本节点，框架默认转义） |
| `--html --force` 覆盖任意文件 | 非本工具生成的报告默认拒绝；`--force` 是用户显式开关（设计如此） |
| `kit --to` 写任意目录 | 设计如此：目录由用户指定 |
| 会话 zstd 炸弹 | 0.5.2 已有单帧 8MB / 总量 32MB 上限，未复现 |

### 结论

- 上一轮修的 8 条没有回潮（`tools/attack-probe.mjs` 全绿，155 项测试全过）。
- 这一轮的真问题集中在**"信任边界"与"协议边界"**：Host 头、junction、`--repo` 代码来源——都不是"某个字段没过滤"，而是"把外部输入当成了可信上下文"。
- 仍然不防的：同用户本地篡改（`kit.json`、`runs/`、环境变量）、局域网 IP 访问设置页（Host 只放行回环）、杀毒/多用户隔离。

---

## 2026-11-07 · 红队轮（DeepSeek 双角色盲测，Kimi/GLM 待回）

### 沙箱怎么搭的（诚实说明）

本机没有 Docker / Windows Sandbox，所以是**逻辑隔离**，不是内核级：

- `tools/security-lab.mjs` 生成：插件副本 + 假 `DSH_HOME`（假会话/假 profile/假案例库）+ 假 `APPDATA`（假日志）
- 独立实例：用同一份 `createReportHandler` 起在 `127.0.0.1:3999`（不是完整 DSH 宿主，路由层代码相同）
- 审计：攻击者被要求走 `audit/run.mjs` 包装器，每条命令落盘

### 结果：19 条尝试，9 条真跑通

| # | 攻击 | 自评 | 我们复现 | 处置 |
| --- | --- | --- | --- | --- |
| 1 | **单行 1.2MB 日志触发 ReDoS**，卡死主线程 | 严重 | ✅ **94.7 秒** | ✅ 已修：单行采样 2KB + 正则去无界 `[^\n]*`，现 **3ms** |
| 2 | 返回值未脱敏：`check --json` / HTTP 里有 `ghp_`/`glpat-`/`xoxb-` | 高 | ✅ 复现 | ✅ 已修：`runCheck` 返回前脱敏 + 补 4 类令牌规则 |
| 3 | 裸短语 `host outbound proxy policy installed` 擦掉之前所有故障 | 高 | ✅ 1 条 → 0 条 | ✅ 已修：只认结构化启动事件 `"event":"shell-load.start"` |
| 4 | 本地病例同名覆盖 → 任意命令变成「复制即用」 | 高 | 代码路径确认 | ✅ 已修：本地病例命令前强制加「未审核」标注 |
| 5 | 伪造 `runs/` 历史：面板全绿、处置命令被换、`repair.template` 被注入 Markdown | 高 | 代码路径确认 | ✅ 部分修：模板文本去换行与 Markdown 控制符；历史完整性属同用户威胁（非目标） |
| 6 | 会话帧内嵌 4 字节 magic → 内容被静默丢弃、检测漏报 | 高 | 代码路径确认 | ✅ 已修：坏帧 > 0 时出 `SESSION.SCAN.UNAVAILABLE`（unknown），不再等于"没问题" |
| 7 | 会话资源放大：3KB → 1.1GB 内存 / 12 文件 → 29 秒 | 中 | 未复现（已有单帧上限） | ⬜ 观察项 |
| 8 | `sessions/` 用 junction 逃出 `DSH_HOME` 读取 | 中 | 未复现 | ⬜ backlog：会话目录加 realpath 白名单 |
| 9 | `--html` 任意文件覆写（第三条写路径） | 高 | 行为确认（本人执行才触发） | ✅ 已修：非本工具报告拒绝覆盖（`--force` 放行） |
| 10 | HTTP 只查公开常量头，`Host`/`Origin` 不校验（DNS rebinding） | 中 | 未复现 | ⬜ backlog |
| 11 | GET 无鉴权无节流，30 个 4MB 历史 → 单请求 0.35s / 4.2MB 响应 | 中 | 未复现 | ⬜ backlog：GET 也加节流 + 响应上限 |
| 12 | 3 万条唯一结论 → 27MB 报告 / 21MB run 文件 | 中 | ✅ 复现 | ✅ 已修：结论上限 200 + `REPORT.FINDINGS.TRUNCATED` |
| 13 | `kit --to` 任意目录写 45 个文件 | 中 | 行为确认 | ⬜ 文档化（CLI 按用户指定目录写是设计） |
| 14 | `contribute --force` 覆盖共享病例 | 高 | 代码路径确认 | ✅ 同 #4：命令标注来源 |
| 15 | 急救包信任未签名 `kit.json` 的 `pluginRoot` | 高 | 结构确认 | ⬜ 非目标（同用户可改急救包目录） |
| 16 | `DSH_DOCTOR_NODE` 指向任意 `.cmd` 会被第 1 级探测执行 | 中 | 结构确认 | ⬜ 非目标（环境变量本就由用户控制） |
| 17 | 环境变量改写脱敏身份（伪造 `USERPROFILE` 泄露真实路径） | 中 | 未复现 | ⬜ backlog |
| 18 | 深度嵌套 JSON | — | ✅ 已拦 | 已有测试 |
| 19 | HTTP `?run=` 路径穿越 / 客户端 XSS | — | ✅ 已拦 | 已有测试 |

### 已修的 6 条都有回归钉子

`test/security/redteam.test.mjs`：
ReDoS 时长、裸 marker 不再擦故障、返回值无令牌、结论数量上限、`--html` 守卫、本地病例标注。

### 结论

- **"读"这一面基本守住了**：路径穿越、CSRF、脱敏（修完）、XSS 都没被攻破。
- **"算"这一面最脆弱**：正则回溯、结论放大、静默丢弃——都是"输入一多就出事"，已修三条主路径。
- **"信任边界"是下一层的真问题**：`runs/` 历史、`kit.json`、环境变量都假设"本机文件可信"。这条写进了非目标，但它意味着**急救包目录必须放在用户自己控制的位置**。

---

## 2026-11-07 · 自动化探针（加固后第一轮）

| # | 攻击 | 期望 | 实测 |
| --- | --- | --- | --- |
| 1 | **解压炸弹**：一帧 64 MB 全零（压缩后约 2 KB，膨胀 32,467×） | 整份放弃、记 `unknown`、内存不暴涨 | ✅ `scanned=0`，RSS **-33 MB**，6 ms |
| 2 | **CSRF**：裸 POST（无自定义头） | 403 | ✅ 403 |
| 3 | **CSRF**：同源页面带头 | 200 | ✅ 200 |
| 4 | **日志注入**：插件名 `.*` / `good-plugin\|.*` / `(` / 带换行 | 不产动作 | ✅ 全部 0 动作 |
| 5 | **日志注入**：真点名且条目存在 | 必须产动作 | ✅ 1 条 `disable-plugin-entry` |
| 6 | **深度嵌套 JSON**：2 万层方括号 | 跳过，不抛 | ✅ 0 ms |
| 7 | **路径穿越**：历史名 `..\..\windows\win.ini` | 拒绝 | ✅ `bad-name` |

## 加固前 / 加固后的差异

| 项 | 0.5.0 | 现在 |
| --- | --- | --- |
| 解压炸弹 | 先解压再查总量 | 单帧 `maxOutputLength: 8 MB`，**分配前**拦截 |
| ReDoS | 无界 `[^\n]*` 跑在整行上，1.2MB → 94 秒 | 单行采样 2KB + 有界间隙，**3 ms** |
| 日志 marker | 裸短语可擦掉故障 | 只认结构化启动事件 |
| 令牌 | 返回值未脱敏 | `runCheck` 返回前脱敏 |
| CSRF | 无 | 必须带 `x-dsh-doctor: 1` |
| 改配置前 | 只问 y/N | 先打印 diff 再问 |

## 不在范围内的攻击（不测，也不假装防得住）

- **同用户本地篡改**：改 `kit.json` 的 `pluginRoot`、伪造 `runs/`、改环境变量。威胁模型里已声明为**非目标**。
- 杀毒 / 反 Rootkit / 多用户隔离。

## 复跑要求

- 每次改动 `lib/sessions.js`、`lib/report.js`、`lib/http.js`、`lib/repairs.js` 或 `rescue/rescue.ps1` 后重跑：
  `node tools/attack-probe.mjs` + `node test/security/`
- 多模型轮用 `node tools/security-lab.mjs` 搭沙箱，再按 `README.md` 里的交战规则派人。
