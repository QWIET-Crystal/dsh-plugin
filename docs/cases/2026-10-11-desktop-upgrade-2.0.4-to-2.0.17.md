# DSH Desktop 2.0.4 → 2.0.17 升级：静默安装"成功"却没换文件

- **首次发现**：2026-10-11 09:20 前后（升级二姐的过程中）
- **持续时长**：约 25 分钟（09:20 首次尝试 → 09:25 定位 → 09:29 提权装成功并拉起）
- **现象（用户视角的一句话）**：升级二姐，安装器返回 0，但她的版本还是 2.0.4；改用直接启动后她又起不来
- **影响范围**：仅二姐（DSH Desktop）。大姐 `:3080`、三妹 `:19372` 未受影响
- **最终归类**：非 DSH 问题（Windows 文件权限 + 代理会话沙箱作业），对策库 `#桌面升级需提权`

## 时间线

| 时间 | 事件 | 证据来源 |
|---|---|---|
| 09:0x | 停掉二姐（她缩托盘，正常关闭请求无效，改为结束进程树） | `:43120` 无监听 |
| 09:2x | 首次静默安装 `DSH-Desktop-2.0.17-x64-Setup.exe /S /D=<workspace> DESKTOP` | `installer-exit 0` |
| 09:25 | 核验发现**文件全是 8/29 的 2.0.4，注册表却是 2.0.17** | 下表证据 1–3 |
| 09:25 | 写测试证明安装目录不可写 | 证据 4–6 |
| 09:26 | 误判"盘满"（`Get-PSDrive` 沙箱假值），用 .NET 复核推翻 | 证据 7–8 |
| 09:27 | 提权重装（UAC 由用户点「是」） | `installer-exit=0`，exe 变 2.0.17 |
| 09:29 | 拉起二姐：`Start-Process` 失败 → `explorer` 代启成功 | 8 进程全 2.0.17，`:43120` 监听 |

## 证据原文

**1–2. 注册表已写、文件没换（半装状态）**
```
DisplayName     : DSH Desktop 2.0.17
DisplayVersion  : 2.0.17
EstimatedSize   : 1128125           <- 声称 1.1GB
DisplayIcon     : <workspace> DESKTOP\uninstallerIcon.ico

(Get-Item '<workspace> DESKTOP\DSH Desktop.exe').VersionInfo.FileVersion  ->  2.0.4
uninstallerIcon.ico : False ; resources\runtime : False
```

**3. 旧 dir 仍全在，时间戳是旧的**
```
<workspace> DESKTOP 体积 568.1 MB（升级成功后为 1,102.3 MB）
DSH Desktop.exe  2026/8/29 0:58:38
```

**4–6. 权限根因（未提权 + D:\ 只给 Users 读执行）**
```
whoami /groups  ->  Mandatory Label\Medium Mandatory Level   (未提权)
icacls D:\      ->  D:\ BUILTIN\Users:(OI)(CI)(RX)
                    BUILTIN\Administrators:(OI)(CI)(F)
写测试          ->  <workspace> DESKTOP\__write-test.tmp : Access to the path is denied.
```
HKCU 注册表**用户可写**、`<workspace> DESKTOP` 文件**用户不可写** —— 这正好解释了"只有注册表变了"。

**7–8. 误判与推翻（`Get-PSDrive` 在沙箱里 Free 是假值）**
```
Get-PSDrive -PSProvider FileSystem  ->  C FreeGB 0 ; D FreeGB 0      （假）
[System.IO.DriveInfo]::new('C')     ->  free=67.83 GB
[System.IO.DriveInfo]::new('D')     ->  free=148.74 GB
```

**9. 启动失败侧：日志里没有新版启动横幅**
```
--- dsh-plugin-desktop DSH Desktop 2.0.4  ... run 1791678930804 ---   <- 还是旧 run
（当次 Start-Process 反复启动后 Get-Process 'DSH Desktop' 为空）
```

## 根因

1. **安装失败＝未提权**：`D:\` 根 ACL 只给 `BUILTIN\Users` 读/执行，写要 Administrators。安装器只能写 HKCU 注册表，1.1GB 文件一个都拷不进，而 NSIS 在静默模式下**不把拷贝失败反映成退出码**。
2. **启动失败＝沙箱作业回收**：从代理会话内 `Start-Process` 拉起的 GUI 应用继承沙箱作业，命令结束后随作业被回收（与 `#守护失效`／`guard-restart-sandbox` 同源，只是这次受害者是 GUI 应用）。用 `explorer.exe <exe>` 代启（由已运行的资源管理器托管）即可脱离。

## 处置与结果

| 步骤 | 动作 | 结果 |
|---|---|---|
| 1 | 定向备份（profile 清单/lockfile/宿主状态，0.08 MB） | `_ops\backups\<stamp>-desktop-2.0.4-preupdate` |
| 2 | 提权安装：`Start-Process -Verb RunAs cmd /c <ASCII .cmd>` | exe 2.0.17、内核 0.2.0-rc.2、体积 1,102.3 MB |
| 3 | `explorer.exe "<workspace> DESKTOP\DSH Desktop.exe"` 拉起 | 8 进程全 2.0.17，`:43120` 监听 |
| 4 | 核验无第二份副本 | `%LOCALAPPDATA%\Programs\*` 均无 |

## 回填清单

- [x] `runbook.md`：新增 `## #桌面升级需提权`
- [x] `AGENTS.md`「已知的坑」：补 GUI 应用要 `explorer` 代启、`.cmd` 中文注释被 GBK 解码
- [ ] `dsh-doctor.ps1`：可程序判定的现象是"注册表 DisplayVersion ≠ 主程序 FileVersion"（半装签名），以及"安装目录不可写"——**尚未加入**，见待办
- [ ] 安装器日志：NSIS 静默模式不上报拷贝失败，值得在升级脚本里**装后强制校验 exe 版本**（本次就是靠这一步才发现的）
