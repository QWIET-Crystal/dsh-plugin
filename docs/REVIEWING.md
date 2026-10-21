# 维护者手册：review 与合并病例 PR

> 一句话：**机器查格式，你查语义**。`case-check` 这个 GitHub Action 已经把机械项挡在门外，
> 你只需要回答"这真的是同一个坑吗、处置对不对、有没有把私事写进去"。

## 0. 前置

```bash
gh auth status          # 应显示 Logged in to github.com account <you>
cd dsh-plugin           # 你 clone 的仓库
git pull
```

## 1. 看有哪些 PR 等着

```bash
gh pr list                         # 列表（编号 / 标题 / 分支 / 作者）
gh pr view <n>                     # 正文 + 描述 + 关联 issue
gh pr diff <n>                     # 只看改动（最快）
gh pr view <n> --web               # 想点界面就开浏览器
```

## 2. 机器已经替你查了什么

`case-check`（`.github/workflows/case-check.yml`）在 PR 上自动跑 `tools/lint-cases.mjs` + 索引一致性：

| 机械项 | 判据 |
| --- | --- |
| 文件名 | `YYYY-MM-DD-短名.md`（小写字母数字与 `-`、`.`） |
| 必备内容 | 有「症状/现象」；根因/处置/验证 至少两项 |
| 指纹泄漏 | `ghp_*`、`sk-*`、`AKIA*`、`Bearer`、URL userinfo、`C:\Users\<name>`、`/home/<name>/`、`LAPTOP-XXXXXXX` |
| 体积 | 500 B ~ 40 KB |
| 索引 | 每个案例都在 `INDEX.md` 里；`INDEX.md` 不引用不存在的案例 |

红色就退回去让对方修（评论里贴 Action 报错原文即可）；绿色才进入人工审。

## 3. 你只需要判断这四件事

1. **同一个坑吗**：症状能不能被**判据**稳定识别？只有"很卡""不太对"不算。
2. **处置可执行吗**：命令/配置/升级动作是否具体、是否有副作用、是否要求提权或停宿主却没写。
3. **有没有私事**：路径、主机名、用户名、内网地址、同事的名字、公司的服务名。（机械项只挡常见形态，语义上的泄露要人看）
4. **值不值得进共享库**：只对他自己机器成立 → 建议他留在本地库（`doctor_case_add`），不进 PR。

## 4. 本地复验（可选，2 分钟）

```bash
gh pr checkout <n>
node tools/lint-cases.mjs            # 与 CI 同一套判据
node -e "import('./lib/cases.js').then(async m=>{const s=m.resolveCaseSources({},process.env,process.cwd());const l=m.listCases(s);console.log(l.counts);console.log(m.readCase(s,'<新案例 id>')?.source)})"
```

装过插件的机器上更直观：让 Agent 调 `doctor_cases`（不带 id）看新条目是否出现在"共享库"分组。

## 5. 给意见

```bash
# 只是讨论/提问
gh pr review <n> --comment -b "判据里第 2 条能不能给个命令？现在无法判断是不是同一个坑。"

# 要求修改（会挂 Request changes 状态）
gh pr review <n> --request-changes -b "处置步骤缺少「停宿主」这一步，照做会 EBUSY。"

# 通过
gh pr review <n> --approve -b "机械项通过，判据可识别，处置可执行。"
```

## 6. 合并

```bash
gh pr merge <n> --squash --delete-branch
```

- **推荐 `--squash`**：一条案例 = 一个 commit，历史干净，`git log --oneline docs/cases` 就是案例流水。
- 合并后建议顺手改一下索引描述（`tools/index-cases.mjs` 从正文首行取标题、从"根因"段取摘要，通常不用手改）。
- 如果 PR 里还改了 `lib/`（少见），合并前跑一次 `node --test test/`；沙箱环境用 `node test/*.test.mjs` 逐个跑。

## 7. 合并之后

1. **公告式更新**：想让大家立刻拿到，就发个版本
   ```bash
   npm version minor --no-git-tag-version   # 或 patch：只有案例新增时 patch 也够
   git commit -am "chore: release vX.Y.Z（新增 N 条案例）"
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin main --tags
   ```
   用户侧更新：`dsh plugin add dsh-doctor@X.Y.Z`，或直接 `dsh plugin update`。
2. **不想发版也可以**：别人 `git pull` 自己 clone 的仓库、把 `sharedCasesDir` 指过去，插件读的就是最新案例（这是 D 通道的意义）。

## 8. 安全提示（审陌生 PR 时）

- **先看 diff 再跑任何东西**。仓库里没有 `postinstall`，`npm test` 只跑 `node:test`；但 PR 可以改 `package.json` 的 scripts —— 你要是 `npm install/ test` 就等于执行了对方代码。
- 只合并 `docs/cases/**` 与 `INDEX.md` 的改动是最省心的；一旦 PR 动了 `lib/`、`tools/`、`package.json`，按代码评审标准来（跑测试、看是否引入网络/写盘/执行面）。
- 本项目的安全承诺写在 [SECURITY.md](../SECURITY.md)：零执行面、白名单读取、唯一写点是本地库。任何 PR 若破坏其中一条，**不要合并**。

## 9. 一张图记住流程

```
PR 开 → case-check（机械） → 你审 4 件事 → approve → squash merge → （可选）发版
                                    ↓ 要改
                              request changes → 作者修 → 再跑 CI
```
