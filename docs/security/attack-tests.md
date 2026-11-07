# 攻防测试记录（0.5.1）

跑法：`node tools/attack-probe.mjs`（只写临时目录，不碰真实会话与配置）。
每条探针的判据与 SECURITY.md 的断言一一对应。

## 2026-11-07 · 第一次跑（加固后）

| # | 攻击 | 期望 | 实测 |
| --- | --- | --- | --- |
| 1 | **解压炸弹**：一帧 64 MB 全零（压缩后约 2 KB，膨胀 32,467×） | 整份放弃、记 `unknown`、内存不暴涨 | ✅ `scanned=0`，`errors=["session-bomb：frame-too-large"]`，RSS **-33 MB**，6 ms |
| 2 | **CSRF**：裸 POST（无自定义头） | 403 | ✅ 403 |
| 3 | **CSRF**：同源页面带头 | 200 | ✅ 200 |
| 4 | **日志注入**：插件名 `.*` / `good-plugin\|.*` / `(` / 带换行 | 不产动作（不得当正则匹配到别的条目） | ✅ 全部 0 动作 |
| 5 | **日志注入**：真点名且条目存在 | 必须产动作（否则功能就废了） | ✅ 1 条 `disable-plugin-entry` |
| 6 | **深度嵌套 JSON**：2 万层方括号 | 解析失败的行跳过，不抛 | ✅ 0 ms |
| 7 | **路径穿越**：历史名 `..\..\windows\win.ini` | 拒绝 | ✅ `bad-name` |

## 加固前 / 加固后的差异

| 项 | 0.5.0 | 0.5.1 |
| --- | --- | --- |
| 解压炸弹 | 先解压再查总量（1 MB 尾部可先分配数百 MB） | 单帧 `maxOutputLength: 8 MB`，**分配前**拦截 |
| CSRF | 任意网页可 POST 触发体检并写盘 | 必须带 `x-dsh-doctor: 1` |
| 改配置前 | 只问 y/N | 先打印 diff（前后两行 + 将插入的行）再问 |

## 不在范围内的攻击（不测，也不假装防得住）

- **同用户本地篡改**：改 `kit.json` 的 `pluginRoot` 可让急救包跑别的代码。威胁模型里已声明为**非目标**。
- 杀毒 / 反 Rootkit / 多用户隔离。

## 复跑要求

- 每次改动 `lib/sessions.js`、`lib/http.js`、`lib/repairs.js` 或 `rescue/rescue.ps1` 后重跑一次；
- 回归断言已固化在 `test/security/hardening.test.mjs`（7 项），CI 会跑。
