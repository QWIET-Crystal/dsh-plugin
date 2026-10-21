# 守卫状态文件被重置：日志说"在线"、状态文件说"从未在线"

- **首次发现**：2026-10-11 16:35 前后（排查二姐掉线时偶然发现）
- **持续时长**：未知（发现时已是该状态）
- **现象（用户视角的一句话）**：用户看不出异常；但守卫的"从未在线"判据会让它**放弃救援**
- **影响范围**：`_probe\sisters-guard-task.ps1` 的状态机（三姐妹的存活历史判定）
- **最终归类**：**尚未定位**（只报告，不处置）

## 判据与证据

**同一时刻，日志与状态文件互相矛盾：**

```
sisters-guard.log:
[2026-10-11 12:59:28] desktop: online (port=43120 listenPid=23336 http=ok desktopHostAlive=True)
  <- 二姐当时确实在线，且被正确识别

sisters-state.json（16:35 读）:
"desktop": { "online": false, "attempts": 0, "lastAttempt": null,
             "note": "OFFLINE_NO_HISTORY (never seen online since this guard started ...)" }
  <- 却声称"本次守护启动后从未见过她在线"
```

**关键矛盾点**：`_scans` 从 09:28 的 11945 连续增长到 16:33 的 12362（≈ 每 60 秒 +1，无跳变），
说明**状态文件本身一直在被正常读写、且未被清空重建**；但 `desktop.online` 的历史却丢了。

按代码逻辑，`$wasOnline` 只来自状态文件的 `online` 字段：

```powershell
$prev = $state[$name]
$wasOnline = [bool]$prev.online
...
if (-not $wasOnline) { $note = 'OFFLINE_NO_HISTORY (never seen online ... reported, not resurrected)' }
```

所以只要历史还在，二姐离线时应当是**边沿触发 → 尝试拉起**（受冷却/上限约束），
而不是 `OFFLINE_NO_HISTORY`。**这个字段的丢失等于永久关闭了对该姐妹的自动救援。**

## 时间线（可考的部分）

| 时间 | 观测 | 来源 |
|---|---|---|
| 09:28 | state: desktop=OFFLINE_NO_HISTORY, `_scans`=11945 | `sisters-state.json`（当时读） |
| 10:50–10:53 | log: desktop **online** pid=23336 | `sisters-guard.log` |
| 10:54 | log: web online pid=46188（我临时起的后台作业实例） | 同上 |
| 10:55:13 | log: web `OFFLINE_HOST_OWNS_IT`（二姐活着 → 守卫拒绝拉起大姐） | 同上 |
| 12:59:28 | log: desktop **online**（最后一次见到她） | 同上 |
| 15:30 起 | log: desktop/web/pet 全为 `OFFLINE_NO_HISTORY` | 同上 |
| 16:35 | state: desktop 仍为"从未在线" | `sisters-state.json` |

> 注：09:28 那次读到的"从未在线"发生在二姐**当时确实离线**的窗口内（我 08:58 停过她、09:29 才拉起），
> 所以那一条不构成矛盾；矛盾出现在 **12:59 之后**。

## 目前能排除的

- **不是**端口参数写错：`sisters-guard-task.ps1` 的默认值是正确的
  （`$WebPort=3080` / `$DesktopPort=43120` / `$PetPort=19372`），且 `dsh-guard-loop.ps1` 不传端口参数。
- **不是**探测方法失效：`Get-ListenerPid` 用 `netstat -ano -p TCP` 解析，对 3080 一直有效；
  10:50 也正确识别出 23336 在 43120 上监听。
- **不是**系统重启（`[Environment]::TickCount` 显示已开机 319.6 小时）。

## 待查（需要什么证据）

1. 守卫循环是否**同时跑着多个实例**（各自持有不同的内存 `$state`，交替写同一个状态文件）。
   查法：连续采样 `Get-Process powershell` 的 pid/启动时间，并对照 `guard-loop.log` 的
   `loop starting (pid ...)` 是否出现**不伴随旧实例退出**的新条目。
2. 状态文件是否存在**被并发写入**导致的读回不一致（无锁的 `ConvertTo-Json | Set-Content`）。
3. `sisters-guard.log.1`（已轮转）里 12:59–15:30 之间是否出现过 `state file unreadable - starting fresh`
   —— 若出现，则 `_scans` 应当归 1，但它没有，所以这条基本可排除，值得复核。

## 为什么必须归档

`OFFLINE_NO_HISTORY` 是**静默关闭救援**的分支。它一旦因状态丢失而误判，
表面上"守卫在正常运行"（日志每分钟都在写、`wmi=ok`、心跳正常），
但那位姐妹实际上已经失去自动救助 —— 这正是最容易被忽略的失效模式。

## 回填清单

- [ ] `runbook.md`：`#姐妹崩溃` 补一句"`OFFLINE_NO_HISTORY` 可能是状态丢失的假象，先比对同刻日志"
- [ ] `dsh-doctor.ps1`：可程序判定的现象 —— "同刻日志有 `X: online` 而 state 里 `X.online=false`" → WARN
- [ ] 守卫本身：状态写入加锁 / 启动时打印"载入了哪些历史"，让重置变得可见
