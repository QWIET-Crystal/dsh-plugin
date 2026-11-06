# 声称"已脱敏"，产物里却还能 grep 到用户名 · 2026-11-06

## 类型

authoring

## 症状

工具/插件宣称输出前会脱敏，但把落盘的东西（JSON 报告、病例库、导出包）翻出来一搜，
**用户名、主机名、用户主目录还在里面**。

最典型的残余位置不是正文，而是**你以为"不是内容"的字段**：一个拼接出来的 id、一个标签、一个缓存键。

## 判定签名

拿产物直接搜（把 `<用户名>` 换成你自己机器上的）：

```powershell
# 落盘产物里出现用户名就算泄漏（写 0 才算干净）
Select-String -Path .\runs\*.json -Pattern '<用户名>' -SimpleMatch | Measure-Object | Select-Object -ExpandProperty Count
```

更通用的一条：**产物里不应该出现任何 `盘符:\Users\<名字>` 形态的路径**，只允许 `<home>` / `<repo>` / `<workspace>` 占位符。

## 根因

第一版脱敏是**白名单式**：显式处理 `dir` / `path` / `text` / `evidence` 这几个"看起来像路径"的字段。
于是漏掉了 `engines[].id` —— 它是拼接出来的：

```js
id: 'npm:' + prefix   // → npm:C:\Users\<user>\AppData\Roaming\npm
```

白名单式脱敏的本质是"我猜得到所有会带身份的位置"，而字段会随版本增加。**猜错一次就是泄漏。**

## 处置命令

```sh
# 全部产物扫一遍（把 <用户名> 换成实际的）；输出 0 才干净
grep -rc "<用户名>" . --include="*.json" --include="*.md"
```

## 处置与结果

把"挑字段脱敏"改成**无条件递归全量脱敏**：字符串一律过 `redact()`，结构原样保留。改动很小：

```js
function deepRedact(value, identity, depth = 0) {
    if (depth > 16) return value;
    if (typeof value === 'string') return redact(value, identity);
    if (Array.isArray(value)) return value.map((v) => deepRedact(v, identity, depth + 1));
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = deepRedact(v, identity, depth + 1);
        return out;
    }
    return value;
}
```

已落盘的旧产物需要**回溯清洗**：用同一函数把历史文件重写一遍（别只修新写入的）。

## 验证

- 新产物：判定签名里的命令计数为 0；
- 历史产物：回溯清洗后再跑一遍，计数为 0；
- 结构没被破坏：渲染/读取仍然正常（加一条"结构不变"的断言）。

## 回填清单

- [x] 单测：构造一份含路径、主机名、令牌的 payload，断言整份 JSON 里不出现这些串，且占位符生效
- [x] 单测：脱敏不改原对象（避免把内存里的真路径也抹掉，影响同进程后续使用）
