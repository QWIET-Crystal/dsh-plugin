# Changelog

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
