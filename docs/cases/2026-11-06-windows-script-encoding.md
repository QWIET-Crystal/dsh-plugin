# Windows 脚本的两种编码坑（`.cmd` 乱码 + `.ps1` 缺 BOM）· 2026-11-06

## 类型

authoring

## 症状

给用户做的"双击即用"入口，第一次跑就翻车，而且**三种坏法长得完全不一样**：

1. 双击 `.cmd`，黑窗一闪就没了，或者执行的是看不懂的命令（报 `'xxx' 不是内部或外部命令`）；
2. `.ps1` 一运行就报 `字符串缺少终止符` —— 但文件在编辑器里看着完全正常；
3. 中文能显示，但**整行粘在一起**、或者显示成 `锛?` / `鏃ュ織` 这类乱码。

## 判定签名

- 报错 `字符串缺少终止符` / `TerminatorExpectedAtEndOfString` → `.ps1` 缺 BOM；
- 报 `'xxx' 不是内部或外部命令`（而 `xxx` 是你注释里的中文） → `.cmd` 里有非 ASCII 字节；
- 输出里出现 `锛` `鏃` `鍒` 这类"看着像汉字但不成词"的字符，或**行尾换行消失导致两行粘连** → stdout 编码不匹配；
- 快速判定命令：

```powershell
# .cmd 里非 ASCII 字节数必须是 0
(Get-Content -Raw .\急救.cmd).ToCharArray() | Where-Object { [int]$_ -gt 127 } | Measure-Object | Select-Object -ExpandProperty Count
```

## 根因

三个不同的解码器，各错各的：

| 文件/通道 | 谁在解码 | 默认按什么解码 | 后果 |
| --- | --- | --- | --- |
| `.cmd` | cmd.exe | 系统代码页（中文机器 = GBK） | 中文注释被拆成乱码命令去执行 |
| `.ps1`（无 BOM） | PowerShell 5.1 | 系统 ANSI | 中文变乱码，引号配对被打破 → 语法错 |
| 子进程 stdout | PowerShell 捕获时 | `[Console]::OutputEncoding`（GBK） | UTF-8 中文乱码；**奇数长度行还会吃掉换行** |

第三条最阴：不是简单的"看着乱"，而是行结构被破坏——两个字节一组解码，最后落单的字节会和 `\n` 组成一个"汉字"，换行就没了。

## 处置命令

```powershell
# 给 .ps1 补 UTF-8 BOM（无 BOM 时 PowerShell 5.1 会按 ANSI 解码中文）
$p = '.\rescue.ps1'
[IO.File]::WriteAllText($p, (Get-Content -Raw $p), (New-Object System.Text.UTF8Encoding($true)))
```

## 处置与结果

- `.cmd`：**只写 ASCII**（中文全部搬进 `.ps1`），文件开头加一句注释说明为什么；
- `.ps1`：统一存成 **UTF-8 带 BOM**，并在导出/复制时强制补 BOM（不要依赖编辑器保存选项）；
- 捕获子进程输出时，**只在捕获那一小段**把 `[Console]::OutputEncoding` 设成 UTF-8，捕完立刻还原——
  否则自己的中文输出也会跟着变形：

```powershell
$prev = [Console]::OutputEncoding
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $captured = & $exe @args 2>&1
} finally {
    if ($prev) { [Console]::OutputEncoding = $prev }
}
```

## 验证

- 双击 `.cmd`：黑窗里中文正常、不粘连、菜单能输入；
- 重跑一次 `.ps1`：不再出现 `字符串缺少终止符`；
- 用判定签名里那条命令复查：`.cmd` 的非 ASCII 计数为 0。

## 回填清单

- [x] 导出器里加断言：`.cmd` 非 ASCII 计数 > 0 就**拒绝导出**；`.ps1` 写入时强制补 BOM
- [x] 单测钉住：`.cmd` 无 BOM 且纯 ASCII、`.ps1` 首字符是 `\ufeff`
