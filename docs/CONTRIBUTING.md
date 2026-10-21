/**
 * dsh-doctor / docs/CONTRIBUTING.md
 *
 * 共享案例库靠「审阅」增长：没有遥测、没有自动上报、插件不联网。
 * 你只做三件事：写一条本地病例 → 提 PR → 维护者合并。
 */

# 贡献一条案例

## 0. 先想清楚它属于哪个库

| | 本地库 | 共享库（本文件讲的就是它） |
| --- | --- | --- |
| 位置 | `$DSH_HOME/dsh-doctor/cases` | 仓库 `docs/cases/` |
| 内容 | 你这台机器特有的（路径、版本、怪癖） | 别人也大概率会遇到的通用失败形态 |
| 谁能写 | 你（`doctor_case_add`） | 维护者审阅合并 PR |

判据：**别人在自己的机器上照这个描述，能不能复现/判断？** 能 → 送共享库。

## 1. 生成脱敏草稿

在 DSH 里调用：

```
doctor_case_add
  id: local-YYYYMMDD-短名        # 只用字母数字与 -_. ，不带路径分隔符
  title: 一句话标题（症状）
  body: |
    ## 症状
    ## 判定签名
    ## 根因
    ## 处置
    ## 验证
```

它会做这些事（不需要你操心）：

- 只写本地库目录，绝不碰共享库；
- 写盘前强制 `redact()`：用户名 / 主机名 / 用户主目录 / 临时目录 / `ghp_*`、`sk-*`、`Bearer`、URL userinfo 都替换成占位符；
- 默认不覆盖同名文件（要覆盖传 `force=true`）。

## 2. 复制进仓库

```bash
cp "$DSH_HOME/dsh-doctor/cases/local-YYYYMMDD-短名.md" docs/cases/
```

建议把文件名改成不带 `local-` 前缀的正式编号，例如 `2026-10-21-plugin-waits-removed-service.md`（和已有案例同一风格）。

## 3. 重建索引

```bash
node tools/index-cases.mjs            # 只重建 docs/cases/INDEX.md（不碰正文）
node tools/lint-cases.mjs             # 与 CI 同一套机械检查，提交前先跑一遍
```

> `tools/build-cases.mjs` 是**一次性 bootstrap**（从本机事故归档生成初始案例库），别用它重建索引，
> 否则会把手工/PR 加入的案例冲掉。CI（`.github/workflows/case-check.yml`）会替你跑上面两条。

## 4. 开 PR

- 标题建议：`case: <症状一句话>`
- 描述里写清楚：**怎么复现 / 怎么判断 / 怎么修 / 怎么验证**
- 别贴真实令牌；需要时用 `<redacted>` 占位
- 如果案例涉及本机特有路径，请用 `<home>`、`<workspace>`、`<path>` 占位（脱敏器已经这么做了，手抄时保持一致）

## 维护者 review 要点

1. **可判据**：判定签名能不能被程序或人稳定识别？只有"我感觉很卡"不算。
2. **可处置**：有没有明确的下一步（命令/配置/升级动作）？
3. **无指纹**：`grep -Ei 'kaiple|<你的用户名>|<你的主机名>|ghp_|sk-'` 必须为空。
4. **不冲突**：新案例不要复用已有 id；要修订旧案例就改原文件并在描述里说明。

合并后，其他人更新插件（或 `git pull` 自己的 clone，把 `sharedCasesDir` 指过去）即可看到新案例。

## 不想开 PR？

也可以只把案例留在本地库——`doctor_cases` 会两个库一起列，你的本地条目一样能被自己和同机的其他人用到。
