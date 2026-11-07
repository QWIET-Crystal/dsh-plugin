# dsh-doctor 急救包 v1 —— 宿主全崩时的人工入口
#
# 为什么是 PowerShell 而不是 .cmd：cmd.exe 按系统代码页（中文机器是 GBK）解码批处理，
# 中文注释会被拆成乱码命令去执行。所以 .cmd 只写 ASCII 做"门铃"，中文全部放在这里
# （本文件必须存成 UTF-8 **带 BOM**，否则 PowerShell 5.1 也会按 GBK 读）。
#
# 它只做三件事：探测运行环境 -> 体检并出报告 -> 按你按下的数字拉起服务。
# 不改配置、不删文件、不动注册表。

$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logPath = Join-Path $here ("run-$stamp.log")
$reportPath = Join-Path $here 'report.html'
$chain = @()
$nodeKind = 'none'

function Write-Log {
    param([string]$Message)
    $line = ('[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $Message)
    Write-Host $line
    try { Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8 } catch { }
}

function Wait-Enter {
    [void](Read-Host "`n按回车返回菜单")
}

function Find-DesktopExe {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\DSH Desktop\DSH Desktop.exe'),
        'D:\DSH DESKTOP\DSH Desktop.exe',
        (Join-Path $env:ProgramFiles 'DSH Desktop\DSH Desktop.exe')
    )
    foreach ($p in $candidates) {
        if ($p -and (Test-Path -LiteralPath $p)) { return $p }
    }
    return $null
}

Write-Host ''
Write-Host '================================================' -ForegroundColor Cyan
Write-Host '   DSH 急救包' -ForegroundColor Cyan
Write-Host '   只做体检和拉起服务，不改你的配置' -ForegroundColor DarkGray
Write-Host '================================================' -ForegroundColor Cyan
Write-Log "启动；目录 = $here"
Write-Log "日志文件 = $logPath"

# ---------------------------------------------------------------- kit.json
$kit = $null
$kitPath = Join-Path $here 'kit.json'
if (Test-Path -LiteralPath $kitPath) {
    try {
        $kit = Get-Content -LiteralPath $kitPath -Raw -Encoding UTF8 | ConvertFrom-Json
        Write-Log ("急救包版本 {0}；导出时间 {1}" -f $kit.kitVersion, $kit.generatedAt)
    } catch {
        Write-Log "kit.json 解析失败（继续）：$($_.Exception.Message)"
    }
} else {
    Write-Log 'kit.json 不存在（继续）'
}

# ---------------------------------------------------------------- 运行环境探测链
$node = $null
$desktopExe = Find-DesktopExe
Write-Log ("桌面端主程序：" + $(if ($desktopExe) { $desktopExe } else { '（没找到）' }))

if (-not $node -and $env:DSH_DOCTOR_NODE) {
    if (Test-Path -LiteralPath $env:DSH_DOCTOR_NODE) {
        $node = $env:DSH_DOCTOR_NODE
        $chain += "第 1 级 DSH_DOCTOR_NODE -> $node"
        Write-Log $chain[-1]
    } else {
        $chain += '第 1 级 DSH_DOCTOR_NODE -> 指向的文件不存在'
        Write-Log $chain[-1]
    }
}
if (-not $node) {
    $cmdNode = Get-Command node -ErrorAction SilentlyContinue
    if ($cmdNode -and $cmdNode.Source) {
        $node = $cmdNode.Source
        $chain += "第 2 级 PATH -> $node"
        Write-Log $chain[-1]
    } else {
        $chain += '第 2 级 PATH -> 没有 node'
        Write-Log $chain[-1]
    }
}
if (-not $node) {
    $npmNode = Join-Path $env:APPDATA 'npm\node.exe'
    if (Test-Path -LiteralPath $npmNode) {
        $node = $npmNode
        $chain += "第 3 级 npm 全局 -> $node"
        Write-Log $chain[-1]
    } else {
        $chain += '第 3 级 npm 全局 -> 没有'
        Write-Log $chain[-1]
    }
}
if (-not $node) {
    $portable = Join-Path $env:APPDATA 'npm\node_modules\@qweit-crystal\dsh-doctor-node\node.exe'
    if (Test-Path -LiteralPath $portable) {
        $node = $portable
        $chain += "第 4 级 便携 node 扩展包 -> $node"
        Write-Log $chain[-1]
    } else {
        $chain += '第 4 级 便携 node 扩展包 -> 没装'
        Write-Log $chain[-1]
    }
}
if (-not $node -and $desktopExe) {
    $node = $desktopExe
    $nodeKind = 'electron'
    $chain += "第 5 级 桌面端 Electron（ELECTRON_RUN_AS_NODE） -> $desktopExe"
    Write-Log $chain[-1]
} elseif ($node) {
    $nodeKind = 'node'
}

# ---------------------------------------------------------------- 体检入口（薄启动器优先）
$pluginRoot = $null
if ($kit -and $kit.pluginRoot) {
    $candidate = Join-Path $kit.pluginRoot 'bin\dsh-doctor.mjs'
    if (Test-Path -LiteralPath $candidate) {
        $pluginRoot = $kit.pluginRoot
        Write-Log "体检代码来源：插件安装目录（跟随最新代码）-> $pluginRoot"
    }
}
if (-not $pluginRoot) {
    $builtin = Join-Path $here 'payload'
    if (Test-Path -LiteralPath (Join-Path $builtin 'bin\dsh-doctor.mjs')) {
        $pluginRoot = $builtin
        Write-Log "体检代码来源：急救包内置副本（**可能已过期**，建议重新导出）-> $builtin"
    }
}
if (-not $pluginRoot) {
    Write-Log '找不到可用的体检代码（插件目录和内置副本都没有）'
}

$kernelBin = Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\lib\bin.js'

function Test-NodeLaunchable {
    if (-not $node) { return $false }
    try {
        $out = & $node --version 2>&1
        $code = $LASTEXITCODE
        if ($code -eq 0 -and ("$out" -match 'v\d+\.')) {
            Write-Log "Node 可用：$out"
            return $true
        }
        Write-Log ("Node 存在但跑不起来（退出码 " + $code + "）：" + ($out -join ' '))
        return $false
    } catch {
        Write-Log "Node 启动失败：$($_.Exception.Message)"
        return $false
    }
}

if ($node) {
    if (-not (Test-NodeLaunchable)) {
        Write-Log 'Node 探测通过但无法启动 -> 降级为系统层检查（简化版报告）'
        $chain += '（Node 无法启动 -> 已降级）'
        $node = $null
        $nodeKind = 'none'
    }
}

function Invoke-WithNode {
    param([string[]]$NodeArgs)
    $prevElectron = $env:ELECTRON_RUN_AS_NODE
    if ($nodeKind -eq 'electron') { $env:ELECTRON_RUN_AS_NODE = '1' }
    $prevEnc = $null
    $code = $null
    $captured = @()
    try {
        # Node 的 stdout 是 UTF-8，而 PowerShell 默认按控制台代码页（中文机器是 GBK）解码 -> 乱码，
        # 甚至连行尾的换行都会被吞掉。只在"捕获"这段时间切到 UTF-8，捕获完立刻还原，
        # 避免我们自己的中文输出也跟着变形。
        try {
            $prevEnc = [Console]::OutputEncoding
            [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
        } catch { }
        $captured = & $node @NodeArgs 2>&1
        $code = $LASTEXITCODE
    } catch {
        $captured = @('调用 Node 失败：' + $_.Exception.Message)
    } finally {
        if ($prevEnc) { try { [Console]::OutputEncoding = $prevEnc } catch { } }
        if ($nodeKind -eq 'electron') {
            if ($prevElectron) { $env:ELECTRON_RUN_AS_NODE = $prevElectron } else { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
        }
    }
    foreach ($line in $captured) { Write-Log ([string]$line) }
    return $code
}

function Write-DegradedReport {
    $rows = ''
    foreach ($port in @(3080, 43120, 19372)) {
        $state = '无法判断'
        try {
            $hit = (& netstat -ano | Select-String (':' + $port + '\s') | Select-String 'LISTENING' | Select-Object -First 1)
            if ($hit) { $state = '在监听' } else { $state = '没有在监听' }
        } catch { }
        $color = if ($state -eq '在监听') { '#2e9e5b' } else { '#d03050' }
        $rows += ('<tr><td>' + $port + '</td><td style=' + '"color:' + $color + '"' + '>' + $state + '</td></tr>')
    }
    $procs = @()
    foreach ($name in @('DSH Desktop', 'node')) {
        $n = 0
        try { $n = @(Get-Process -Name $name -ErrorAction SilentlyContinue).Count } catch { }
        $procs += ('<li>' + $name + '：' + $n + ' 个进程</li>')
    }
    $dirs = ''
    foreach ($d in @((Join-Path $env:USERPROFILE '.dsh'), (Join-Path $env:LOCALAPPDATA 'AAAAGENT\dsh-home'))) {
        $exists = if (Test-Path -LiteralPath $d) { '存在' } else { '不存在' }
        $dirs += ('<li><code>' + $d + '</code>：' + $exists + '</li>')
    }
    $html = @'
<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>DSH 体检（简化版）</title>
<style>body{font:15px/1.7 "Segoe UI","Microsoft YaHei",sans-serif;max-width:760px;margin:32px auto;padding:0 16px;background:#f6f7f9;color:#1c1f24}
.card{background:#fff;border-radius:12px;padding:16px 20px;margin:14px 0;box-shadow:0 1px 2px rgba(16,24,40,.06)}
h1{font-size:19px}table{border-collapse:collapse}td{padding:4px 14px 4px 0}</style></head><body>
<h1>DSH 体检（简化版）</h1>
<div class="card"><b>没找到可用的 Node</b>，所以这次只做了操作系统层面的检查。
要得到完整报告：装一个 Node（nodejs.org），或安装便携扩展包
<code>npm i -g @qweit-crystal/dsh-doctor-node</code>，然后重新双击急救包。</div>
<div class="card"><b>端口</b><table>__ROWS__</table></div>
<div class="card"><b>进程</b><ul>__PROCS__</ul></div>
<div class="card"><b>目录</b><ul>__DIRS__</ul></div>
<div class="card">下一步：如果端口全都没在监听，回到菜单按 <b>2</b> 启动网页端、按 <b>3</b> 启动桌面端。</div>
</body></html>
'@
    $html = $html.Replace('__ROWS__', $rows).Replace('__PROCS__', ($procs -join '')).Replace('__DIRS__', $dirs)
    try {
        [System.IO.File]::WriteAllText($reportPath, $html, (New-Object System.Text.UTF8Encoding($false)))
        Write-Log "简化版报告已写入 $reportPath"
        Start-Process $reportPath
    } catch {
        Write-Log "写简化版报告失败：$($_.Exception.Message)"
    }
}

function Invoke-Check {
    if (-not $node -or -not $pluginRoot) {
        Write-Log '没有可用的 Node 或没有体检代码 -> 走简化版（只用系统层事实）'
        Write-DegradedReport
        return
    }
    $entry = Join-Path $pluginRoot 'bin\dsh-doctor.mjs'
    Write-Log "开始体检：$entry"
    # --quiet：报告已经写进 HTML 了，终端里不必再滚一遍 Markdown（也避开编码问题）
    $code = Invoke-WithNode @($entry, 'check', '--html', $reportPath, '--quiet')
    if ($null -eq $code) {
        Write-Log 'Node 没能执行（被权限/杀软拦住？）-> 改走简化版'
        Write-DegradedReport
        return
    }
    $verdictText = switch ($code) { 0 { '全绿' } 1 { '有注意项' } 2 { '有真故障' } 3 { '无法完整取证' } default { '未知' } }
    Write-Log ("体检结束：$verdictText（退出码 $code；0 全绿 / 1 注意 / 2 故障 / 3 无法完整取证）")
    if (Test-Path -LiteralPath $reportPath) {
        Write-Log "报告：$reportPath"
        try { Start-Process $reportPath } catch { Write-Log ("打开报告失败：" + $_.Exception.Message) }
    } else {
        Write-Log '没有生成 HTML 报告（看看上面的输出）'
    }
}

function Start-WebHost {
    if (-not $node) { Write-Log '没有可用的 Node，无法启动网页端'; return }
    if (-not (Test-Path -LiteralPath $kernelBin)) { Write-Log "找不到内核入口：$kernelBin"; return }
    $out = Join-Path $here 'web-host.log'
    Write-Log "启动网页端：$node $kernelBin web --no-open --port 3080（输出 -> $out）"
    $prev = $env:ELECTRON_RUN_AS_NODE
    if ($nodeKind -eq 'electron') { $env:ELECTRON_RUN_AS_NODE = '1' }
    try {
        Start-Process -FilePath $node -ArgumentList @($kernelBin, 'web', '--no-open', '--port', '3080') -WorkingDirectory $env:USERPROFILE -RedirectStandardOutput $out -RedirectStandardError ($out + '.err') -WindowStyle Hidden
        Write-Log '已发出启动请求（黑窗会消失一会儿，属正常）'
    } catch {
        Write-Log "启动失败：$($_.Exception.Message)"
    } finally {
        if ($nodeKind -eq 'electron') {
            if ($prev) { $env:ELECTRON_RUN_AS_NODE = $prev } else { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
        }
    }
}

function Start-DesktopApp {
    $exe = Find-DesktopExe
    if (-not $exe) { Write-Log '没找到 DSH Desktop.exe，请手动打开桌面端'; return }
    Write-Log "启动桌面端：$exe"
    try {
        Start-Process -FilePath $exe
        Write-Log '已发出启动请求'
    } catch {
        Write-Log "启动失败：$($_.Exception.Message)"
    }
}


# ---------------------------------------------------------------- 一键修复（0.5.0）
# 施工纪律：**动作清单是数据，执行器只认枚举类型**。
# 每个动作固定四步：备份 -> 执行 -> 验证 -> 记日志；任何一步失败都不继续。

$repairBackupRoot = Join-Path $here 'backups'

function Test-PortListening {
    param([int]$Port, [int]$TimeoutMs = 800)
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $task = $client.ConnectAsync('127.0.0.1', $Port)
        $ok = $task.Wait($TimeoutMs) -and $client.Connected
        $client.Close()
        return $ok
    } catch {
        return $false
    }
}

function Wait-PortListening {
    param([int]$Port, [int]$TimeoutSec = 30)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (Test-PortListening -Port $Port) { return $true }
        Start-Sleep -Milliseconds 700
    }
    return $false
}

function Get-BuiltinPlan {
    # 没有 Node 时也能救：只做 A 类里最确定的两件事
    $actions = @()
    if (-not (Test-PortListening -Port 3080)) {
        $actions += [pscustomobject]@{ id = 'web'; type = 'start-service'; risk = 'A'; title = '启动网页端（:3080）'; why = '内置计划：端口没在监听'; params = [pscustomobject]@{ service = 'web' }; verify = [pscustomobject]@{ kind = 'port'; port = 3080 } }
    }
    $desk = Find-DesktopExe
    if ($desk -and -not (Test-PortListening -Port 43120)) {
        $actions += [pscustomobject]@{ id = 'desktop'; type = 'start-service'; risk = 'A'; title = '启动桌面端（:43120）'; why = '内置计划：端口没在监听'; params = [pscustomobject]@{ service = 'desktop' }; verify = [pscustomobject]@{ kind = 'port'; port = 43120 } }
    }
    return [pscustomobject]@{ actions = $actions; notes = @(); summary = [pscustomobject]@{ total = $actions.Count; A = $actions.Count; B = 0; notes = 0 } }
}

function Get-Plan {
    if (-not $node -or -not $pluginRoot) {
        Write-Log '没有 Node/插件代码 -> 用内置最小计划（只做 A 类启动）'
        return Get-BuiltinPlan
    }
    $entry = Join-Path $pluginRoot 'bin\dsh-doctor.mjs'
    $prevEnc = $null
    $raw = $null
    try {
        try { $prevEnc = [Console]::OutputEncoding; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
        $raw = & $node $entry plan --json 2>&1
    } catch {
        Write-Log "生成修复计划失败：$($_.Exception.Message)"
        return $null
    } finally {
        if ($prevEnc) { try { [Console]::OutputEncoding = $prevEnc } catch { } }
    }
    $text = ($raw | Out-String).Trim()
    try {
        $obj = $text | ConvertFrom-Json
        return $obj.plan
    } catch {
        Write-Log '修复计划不是合法 JSON（多半是 Node 起不来）-> 退回内置计划'
        return Get-BuiltinPlan
    }
}

function Backup-File {
    param([string]$Path, [string]$Stamp)
    $dir = Join-Path $repairBackupRoot $Stamp
    if (-not (Test-Path -LiteralPath $dir)) { [void](New-Item -ItemType Directory -Path $dir -Force) }
    $safe = ($Path -replace '[:\\/]', '_')
    $dest = Join-Path $dir $safe
    Copy-Item -LiteralPath $Path -Destination $dest -Force
    # 记下原始路径：回滚时不能靠把文件名里的下划线还原（路径本身可能就有下划线）
    Set-Content -LiteralPath ($dest + '.path') -Value $Path -Encoding UTF8
    return $dest
}

function Invoke-StartService {
    param($Params)
    switch ($Params.service) {
        'web' { Start-WebHost }
        'desktop' { Start-DesktopApp }
        default { Write-Log ("未知服务：" + $Params.service) }
    }
}

function Invoke-DisablePluginEntry {
    param($Params)
    $file = $Params.file
    $entryId = $Params.entryId
    if (-not (Test-Path -LiteralPath $file)) { Write-Log "找不到文件：$file"; return $false }
    $lines = Get-Content -LiteralPath $file -Encoding UTF8
    $pattern = '^\s*-\s*id:\s*[''"]?' + [regex]::Escape($entryId) + '[''"]?\s*$'
    $idx = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match $pattern) { $idx = $i; break }
    }
    if ($idx -lt 0) { Write-Log "文件里找不到 entry：$entryId"; return $false }
    for ($j = $idx; $j -lt [Math]::Min($idx + 6, $lines.Count); $j++) {
        if ($lines[$j] -match '^\s*disabled:\s*true') { Write-Log "这条已经禁用了：$entryId"; return $true }
    }
    $indent = ($lines[$idx] -replace '^(\s*).*$', '$1')
    $newLine = $indent + '  disabled: true'
    $out = @()
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $out += $lines[$i]
        if ($i -eq $idx) { $out += $newLine }
    }
    try {
        Set-Content -LiteralPath $file -Value $out -Encoding UTF8
        Write-Log ("已禁用 entry：" + $entryId + "（插入一行：" + $newLine.Trim() + "）")
        return $true
    } catch {
        Write-Log "写文件失败：$($_.Exception.Message)"
        return $false
    }
}

function Invoke-Action {
    param($Action, [string]$Stamp)
    Write-Log ("----- 动作：" + $Action.title + "（" + $Action.risk + " 类）")
    Write-Log ("原因：" + $Action.why)

    if ($Action.params -and $Action.params.file) {
        try {
            $b = Backup-File -Path $Action.params.file -Stamp $Stamp
            Write-Log "备份：" + $b
        } catch {
            Write-Log "备份失败，取消这个动作：$($_.Exception.Message)"
            return $false
        }
    }

    $ok = $false
    switch ($Action.type) {
        'start-service' { Invoke-StartService -Params $Action.params; $ok = $true }
        'disable-plugin-entry' { $ok = Invoke-DisablePluginEntry -Params $Action.params }
        default { Write-Log ("不认识的动作类型，拒绝执行：" + $Action.type); return $false }
    }
    if (-not $ok) { return $false }

    $verified = $false
    if ($Action.verify -and $Action.verify.kind -eq 'port') {
        Write-Log ("等待端口 " + $Action.verify.port + " 开始监听（最多 30 秒）…")
        $verified = Wait-PortListening -Port ([int]$Action.verify.port) -TimeoutSec 30
    } elseif ($Action.verify -and $Action.verify.kind -eq 'file-contains') {
        $verified = (Get-Content -LiteralPath $Action.verify.file -Raw -Encoding UTF8) -match [regex]::Escape($Action.verify.contains)
    } else {
        $verified = $true
    }
    if ($verified) { Write-Log '验证：通过' } else { Write-Log '验证：未通过（可能还需要重启宿主才生效）' }
    return $verified
}

function Show-EntryDiff {
    # 只读预览：告诉用户"会往哪一行插什么"，别的什么都不做
    param($Action)
    $file = $Action.params.file
    $entryId = $Action.params.entryId
    if (-not (Test-Path -LiteralPath $file)) {
        Write-Host ("    （文件不存在，这个动作会被跳过：" + $file + "）") -ForegroundColor DarkGray
        return
    }
    $lines = @(Get-Content -LiteralPath $file -Encoding UTF8)
    $pattern = '^\s*-\s*id:\s*[''"]?' + [regex]::Escape($entryId) + '[''"]?\s*$'
    $idx = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match $pattern) { $idx = $i; break }
    }
    if ($idx -lt 0) {
        Write-Host "    （patch 里找不到这个条目，动作会被跳过）" -ForegroundColor DarkGray
        return
    }
    Write-Host ("    文件：" + $file) -ForegroundColor DarkGray
    $from = [Math]::Max(0, $idx - 2)
    $to = [Math]::Min($lines.Count - 1, $idx + 2)
    for ($k = $from; $k -le $to; $k++) {
        Write-Host ("        " + $lines[$k]) -ForegroundColor DarkGray
        if ($k -eq $idx) {
            $indent = ($lines[$idx] -replace '^(\s*).*$', '$1')
            Write-Host ("      + " + $indent + '  disabled: true') -ForegroundColor Yellow
        }
    }
}

function Invoke-Repair {
    Write-Log '===== 一键修复开始'
    $plan = Get-Plan
    if (-not $plan) { Write-Log '拿不到修复计划，什么都没做'; return }
    $actions = @($plan.actions)
    $notes = @($plan.notes)
    if ($actions.Count -eq 0 -and $notes.Count -eq 0) { Write-Log '没有需要修复的项。'; return }

    $aCount = @($actions | Where-Object { $_.risk -eq 'A' }).Count
    $bCount = @($actions | Where-Object { $_.risk -eq 'B' }).Count
    Write-Log ("计划：A 类 " + $aCount + " 项，B 类 " + $bCount + " 项，人工项 " + $notes.Count + " 项")

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $done = 0
    $failed = 0
    $skipped = 0

    foreach ($a in $actions) {
        if ($a.risk -eq 'A') {
            Write-Host ("`n[A] " + $a.title) -ForegroundColor Green
            Write-Host ("    原因：" + $a.why) -ForegroundColor DarkGray
            if (Invoke-Action -Action $a -Stamp $stamp) { $done++ } else { $failed++ }
        } elseif ($a.risk -eq 'B') {
            Write-Host ("`n[B] " + $a.title) -ForegroundColor Yellow
            Write-Host ("    原因：" + $a.why) -ForegroundColor DarkGray
            Write-Host '    这类改动会写文件（已自动备份），确认才执行。' -ForegroundColor DarkGray
            # 动手前先把"会变成什么样"打出来：新手唯一能看懂的就是这两行差异
            if ($a.type -eq 'disable-plugin-entry') { Show-EntryDiff -Action $a }
            $ans = Read-Host '    执行吗？(y/N)'
            if ($ans -match '^[yY]') {
                if (Invoke-Action -Action $a -Stamp $stamp) { $done++ } else { $failed++ }
            } else {
                Write-Log ("跳过：" + $a.title)
                $skipped++
            }
        }
    }

    if ($notes.Count -gt 0) {
        Write-Host "`n需要人工处理（不会自动执行）：" -ForegroundColor Cyan
        foreach ($n in $notes) {
            Write-Host ("  - " + $n.title + "：" + $n.why)
            if ($n.caseId) { Write-Host ("    案例：" + $n.caseId) -ForegroundColor DarkGray }
        }
    }

    $record = [pscustomobject]@{ stamp = $stamp; done = $done; failed = $failed; skipped = $skipped; actions = $actions }
    try {
        $dir = Join-Path $repairBackupRoot $stamp
        if (-not (Test-Path -LiteralPath $dir)) { [void](New-Item -ItemType Directory -Path $dir -Force) }
        ($record | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath (Join-Path $dir 'actions.json') -Encoding UTF8
    } catch { }
    Write-Log ("===== 一键修复结束：成功 " + $done + "，失败 " + $failed + "，跳过 " + $skipped)
    Write-Host ("`n结果：成功 " + $done + " / 失败 " + $failed + " / 跳过 " + $skipped) -ForegroundColor Cyan
    Write-Host ("备份与动作记录：" + (Join-Path $repairBackupRoot $stamp)) -ForegroundColor DarkGray
}

function Invoke-Rollback {
    if (-not (Test-Path -LiteralPath $repairBackupRoot)) { Write-Log '还没有任何修复备份'; return }
    $dirs = @(Get-ChildItem -LiteralPath $repairBackupRoot -Directory | Sort-Object Name -Descending)
    if ($dirs.Count -eq 0) { Write-Log '还没有任何修复备份'; return }
    $latest = $dirs[0].FullName
    Write-Host ("最近一次修复：" + $dirs[0].Name) -ForegroundColor Cyan
    # 只看 .path 边车文件：每个被备份的原文件都有一条，里面写着原始路径
    $maps = @(Get-ChildItem -LiteralPath $latest -File -Filter '*.path')
    if ($maps.Count -eq 0) { Write-Log '这次修复没有改过文件（只启动过服务），无需回滚'; return }
    foreach ($m in $maps) {
        Write-Host ("  将还原：" + (Get-Content -LiteralPath $m.FullName -Raw -Encoding UTF8).Trim())
    }
    $ans = Read-Host '确认回滚这些文件吗？(y/N)'
    if ($ans -notmatch '^[yY]') { Write-Log '已取消回滚'; return }
    foreach ($m in $maps) {
        $orig = (Get-Content -LiteralPath $m.FullName -Raw -Encoding UTF8).Trim()
        $backup = $m.FullName.Substring(0, $m.FullName.Length - 5)
        try {
            Copy-Item -LiteralPath $backup -Destination $orig -Force
            Write-Log ("已还原：" + $orig)
        } catch {
            Write-Log ("还原失败：" + $orig + " —— " + $_.Exception.Message)
        }
    }
    Write-Log '回滚结束'
}

function Show-Menu {
    Write-Host ''
    Write-Host '------------------------------------------------' -ForegroundColor DarkGray
    Write-Host '  1  体检并打开报告（推荐先按这个）'
    Write-Host '  2  启动网页端（:3080）'
    Write-Host '  3  启动桌面端'
    Write-Host '  4  打开急救包目录（看日志）'
    Write-Host '  5  打开 DSH 配置目录'
    Write-Host '  6  一键修复（A 类全做、B 类逐条确认、C 类只给指路）' -ForegroundColor Green
    Write-Host '  7  回滚上一次修复（从 backups 还原被改的文件）'
    Write-Host '  0  退出'
    Write-Host '------------------------------------------------' -ForegroundColor DarkGray
}

# ---------------------------------------------------------------- 主循环
while ($true) {
    Show-Menu
    $pick = Read-Host '请输入数字'
    # 0.5.4：stdin 到 EOF（重定向 / 非交互 / 被管道调用）时 Read-Host 返回空，
    # 原来的 switch 落到 default 后继续循环 → 无限刷菜单（实测一次 23MB 输出）。空输入即退出。
    if ([string]::IsNullOrWhiteSpace($pick)) {
        Write-Log 'stdin 已结束（非交互），退出'
        break
    }
    switch ($pick) {
        '1' { Invoke-Check; Wait-Enter }
        '2' { Start-WebHost; Wait-Enter }
        '3' { Start-DesktopApp; Wait-Enter }
        '4' { Start-Process explorer.exe -ArgumentList $here; }
        '5' { Start-Process explorer.exe -ArgumentList (Join-Path $env:USERPROFILE '.dsh'); }
        '6' { Invoke-Repair; Wait-Enter }
        '7' { Invoke-Rollback; Wait-Enter }
        '0' { Write-Log '退出'; break }
        default { Write-Host '看不懂这个输入，按 0-7' -ForegroundColor Yellow }
    }
    if ($pick -eq '0') { break }
}

Write-Log '结束'
