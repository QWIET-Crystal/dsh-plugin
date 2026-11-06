# 案例库（脱敏）

> 全部由真实故障归档机械脱敏生成；后续新增通过 PR 合入。
> 每条案例的结构统一为 **症状 → 判定签名 → 根因 → 处置 → 验证**，可直接对照现场取证。
> **类型**：`runtime` = DSH 运行期故障（必须有判定签名）；`authoring` = 插件/工具开发时踩的坑。缺省为 `runtime`。
> 用 `doctor_cases` 工具按编号读取单条；`doctor_cases --search 关键词` 做全文检索。
> 索引由 `node tools/index-cases.mjs` 维护；机械检查用 `node tools/lint-cases.mjs`。

| 编号 | 类型 | 标题 | 根因摘要 |
| --- | --- | --- | --- |
| `2026-09-23-approval-orphan` | runtime | 审批提示孤儿化 · 2026-09-23 / 09-24（连续两天复发） | 审批的设计是单通道的：只投递给发起请求的那个页面。因此当 |
| `2026-09-23-testjob-deadlock` | runtime | 测试作业死锁 · 2026-09-23 | 命令缺 --test-timeout。worker 卡死后 node --test 无限等待，作业永不结算，agent 的 job_output 轮询也就永远返回 running。 |
| `2026-09-24-frontend-dead` | runtime | 网页端进程死亡 + 系统外壳崩溃 · 2026-09-24 | 两个独立问题在同一时间窗叠加： 1. #前端进程死亡：服务 :3080 的 node 进程 22380 退出，端口无人监听。 |
| `2026-09-24-gpu-process-crash` | runtime | GPU 子进程崩溃 → 软件渲染回退 · 2026-09-24 | GPU 子进程崩溃后，Chromium 系应用回退到软件渲染，把光栅化/合成/动画全部改由 CPU 计算。 |
| `2026-09-24-guard-restart-sandbox` | runtime | 2026-09-24 守护循环中断：从代理会话沙箱内启动常驻守护 | 两条，都已验证： 1. 代理会话内启动的进程会继承文件沙箱，后果有两个，缺一不可地解释了现象： |
| `2026-09-24-renderer-runaway` | runtime | 渲染层失控 · 2026-09-24 | > ⚠️ 本条目的根因已被修正。 下面是当时的判断，不是最终结论，保留以供复盘。 |
| `2026-10-11-desktop-upgrade-2.0.4-to-2.0.17` | runtime | DSH Desktop 2.0.4 → 2.0.17 升级：静默安装"成功"却没换文件 | 1. 安装失败＝未提权：D:\ 根 ACL 只给 BUILTIN\Users 读/执行，写要 Administrators。安装器只能写 HKCU 注册表，1.1GB 文件一个都拷 |
| `2026-10-11-guard-state-reset` | runtime | 守卫状态文件被重置：日志说"在线"、状态文件说"从未在线" | 状态文件的"在线历史"字段丢失，但 _scans 连续增长（每 60 秒 +1、无跳变）说明文件一直在被正常读写、 |
| `2026-10-11-plugin-kernel-abi-mismatch` | runtime | 内核升级后插件全挂：Failed to load plugins（客户端模块表缺 dsh-client-runtime） | 二姐的 profile 是给内核 0.1.x 解析的，她的插件全部是那个年代的版本，客户端 chunk 会 require |
| `2026-10-11-web-kernel-upgrade-and-launch-channels` | runtime | 大姐内核升级 0.1.1-rc.2 → 0.2.0-rc.2（含沙箱外启动通道的摸索） | 1. 宿主运行中做全局 npm 升级 → 已加载的原生库（如 libvips-42.dll）被锁住； |
| `2026-10-14-web-self-shutdown-by-user` | runtime | 大姐按用户要求自我关停（:3080） | 不是故障。用户主动要求关停大姐（网页端 DSH）。按工作区铁律第 5 条， |
| `2026-10-21-plugin-waits-removed-service` | runtime | 插件在等一个已被内核删除的服务（`1 entry did not activate`）· 2026-10-21 | 上游内核在某个小版本里删除了一个宿主服务，老插件仍 inject 它 → Loader 认为依赖未满足 → |
| `2026-11-06-plugin-entry-silent-inactive` | authoring | 插件整条"静默不激活"的两种形态 · 2026-11-06 | A：宿主对 output.schema 用的是值 schema DSL（给工具参数用的那套），不是完整 JSON Schema。它： - 不支持 required（写了直接抛）； |
| `2026-11-06-reasoning-repetition-collapse` | runtime | 思考通道退化成重复短语 → 空回合且不报错 · 2026-11-06 | 三步连锁，缺一不可： 1. 模型在工具参数位退化。那一步模型本意是发一个工具调用（证据：结尾有工具调用的闭合标记）， |
| `2026-11-06-redaction-allowlist-leak` | authoring | 声称"已脱敏"，产物里却还能 grep 到用户名 · 2026-11-06 | 第一版脱敏是白名单式：显式处理 dir / path / text / evidence 这几个"看起来像路径"的字段。 |
| `2026-11-06-windows-script-encoding` | authoring | Windows 脚本的两种编码坑（`.cmd` 乱码 + `.ps1` 缺 BOM）· 2026-11-06 | 三个不同的解码器，各错各的： 文件/通道  谁在解码  默认按什么解码  后果 |

共 16 条。
