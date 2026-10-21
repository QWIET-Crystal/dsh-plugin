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
dsh plugin add dsh-doctor
# 或本地开发目录
dsh plugin add "link:/path/to/dsh-doctor"
```

插件自动插入一行 `dsh-doctor`（见 `cordis.patch.yml`），无需手工改装配。

## 提供的工具

| 工具 | 作用 |
| --- | --- |
| `doctor_engines` | 列出所有引擎/实例：每个 `DSH_HOME`、每个 profile 的 bundles/依赖/声明端口、npm 全局内核与桌面端版本、正在监听的端口（带常见端口标签） |
| `doctor_check` | 分层体检：端口、profile 装配、桌面端日志签名；输出带"对策库 #章节"指针的报告，日志行**先脱敏再围栏化** |
| `doctor_cases` | 读随包案例库（11 条真实故障，已脱敏）；不带参数则列索引 |

参数都很小：`refresh`（跳过缓存）、`deep`（是否扫日志）、`id`（案例编号）。

## 安全模型（详见 [SECURITY.md](SECURITY.md)）

- **零执行面**：不 import `child_process` / `vm`，不用 `eval` / `new Function`；单测里有一条**静态断言**守着这条规矩。
- **读文件必须落在白名单根内**：`realpath` 之后比对，`..` 穿越与指向外部的符号链接一律拒绝。
- **有界读取**：只读常规文件、按字节截断、显式标注 `truncated`。
- **输出脱敏**：用户名、主机名、用户主目录、临时目录、`ghp_*`/`sk-*`/`Bearer`/URL userinfo 全部替换为占位符。
- **反注入**：外来文本进 Markdown 围栏前先中和反引号，日志内容无法逃出围栏变成"文档指令"。

## 案例库

`docs/cases/` 是从本机 11 次真实事故**机械脱敏**生成的（路径/主机名/用户名/令牌已替换）：

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

## 许可

MIT © 2026 QWIET-Crystal
