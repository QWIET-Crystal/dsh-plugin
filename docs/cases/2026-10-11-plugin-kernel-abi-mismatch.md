# 内核升级后插件全挂：Failed to load plugins（客户端模块表缺 dsh-client-runtime）

- **首次发现**：2026-10-11 09:3x（二姐升到内核 0.2.0-rc.2 之后）
- **持续时长**：约 15 分钟（09:37 报错 → 09:52 插件升完 + dsh-ops 生效）
- **现象（用户视角的一句话）**：二姐界面弹出 `Failed to load plugins`，插件全不可用
- **影响范围**：仅二姐的 **profile 插件层**；宿主/会话本身正常（我仍能对话、跑工具）
- **最终归类**：DSH 插件与内核版本不匹配。对策库 `#插件与内核 ABI 不符`

## 报错原文

```
Failed to load plugins
failed to import loader entry e7e165cb (@deepseek-ai/dsh-client-ui-theme):
client-modules: require("@deepseek-ai/dsh-client-runtime/client") missed the module table
— not a platform seed word, not a materialized module, and no registered package factory
(a build-time externals drift, or a dynamic dependency that did not arrive)
```

## 根因（已验证）

二姐的 profile 是**给内核 0.1.x 解析**的，她的插件全部是那个年代的版本，客户端 chunk 会 require
`@deepseek-ai/dsh-client-runtime/client` —— 而该包**在内核 0.1.2-alpha 就被上游移除**（种子行改成裸名
`@deepseek-ai/dsh-client-store`），新装的 0.2.0-rc.2 里**根本不存在这个包**（289 个 `@deepseek-ai` 包中无它）。
于是客户端模块表里既不是平台种子词、也没有物化模块 → 整个插件树加载失败。

**证据 1：旧 genui 的 peer 明确排除 0.2.x**（`profiles\desktop\pnpm-lock.yaml`）
```
'@changfenhuang/dsh-genui@0.9.7':
  peerDependencies:
    '@deepseek-ai/dsh-client-runtime': ^0.1.0-rc.8 || >=0.1.1-rc.0 <0.2.0
    '@deepseek-ai/dsh-client-ui-slots': ^0.1.0-rc.8 || >=0.1.1-rc.0 <0.2.0
    ...（共 9 条同类区间）
```

**证据 2：新装的 0.2.0-rc.2 里没有该包**
```
<workspace> DESKTOP\resources\app\node_modules\@deepseek-ai\dsh-client-runtime  -> 不存在
（grep 全树：新内核任何包都不 require 'dsh-client-runtime'）
```

**证据 3：新版插件自己写明那是历史遗留**（`dsh-better-sidebar@0.25.0\lib\client-registry.js`）
```
`@deepseek-ai/dsh-client-runtime` was removed upstream in DSH 0.1.2-alpha
(its seed row became bare-name `@deepseek-ai/dsh-client-store`) and
no chunk ever required it, so its row is gone
```

## 处置与结果

| 步骤 | 动作 | 结果 |
|---|---|---|
| 1 | 用二姐自带 CLI 装 dsh-ops + 升级 5 个插件到 latest | genui 0.11.4 / better-sidebar 0.25.0 / remote-web-ui 0.4.6 / modlens 3.26.6 / hindsight 0.8.0 |
| 2 | 修 `pnpm-workspace.yaml` 的 `allowBuilds.cloudflared` 占位符 → `false` | pnpm 由退 1 变退 0 |
| 3 | 重跑 `plugin add` | 对账不再报错；bundles 仍缺 dsh-ops（见下） |
| 4 | 手工把 `dsh-ops` 追加进 `dsh.profile.bundles` | 宿主重载后 `ops_*` 工具出现、`pwsh` 换成随包 PS7 |

**两个新版特有的坑（0.2.0-rc.2 与旧版行为不同）**
1. **`dsh plugin` 不再做 bundles 对账**。0.1.x 的 `plugin-*.js` 里有 `if (exitCode === 0) reconcilePlugins(...)`；
   0.2.0-rc.2 的 `runPlugin` 只跑 pnpm，对账移进了 `dsh-plugin-manager`（由桌面 UI 驱动）。
   所以 CLI 装完必须自己把包名追加进 `dsh.profile.bundles`，否则插件装了但不加载。
2. **`ERR_PNPM_IGNORED_BUILDS` 会让对账整条跳过**。profile 的 `allowBuilds.cloudflared` 是占位符
   `set this to true or false`，pnpm 退 1 → 旧版逻辑下 reconcile 被跳过。定成 `false` 即可
   （cloudflared 只服务 remote-web-ui 的隧道，与插件加载无关；要用隧道再改 `true`）。

## 回填清单

- [x] `runbook.md`：新增 `## #插件与内核 ABI 不符`
- [ ] `dsh-doctor.ps1`：可程序判定的现象是"profile 里某插件的 peer 区间不包含当前内核版本"
      （读 `pnpm-lock.yaml` 的 peerDependencies + 当前内核版本比对）——**尚未加入**
- [ ] 下次升级任何一端的内核前，先列出该 profile 里 peer 区间排除新内核的插件，一次性升级
- [ ] `allowBuilds` 占位符是 DSH 写的（`set this to true or false`），升级后应检查并定值
