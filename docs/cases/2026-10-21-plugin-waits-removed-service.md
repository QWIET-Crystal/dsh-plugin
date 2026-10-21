# 插件在等一个已被内核删除的服务（`1 entry did not activate`）· 2026-10-21

## 症状

宿主每次启动，日志里稳定出现两行（界面某块功能悄悄缺失，不报错、不弹窗）：

```
dsh-plugin-desktop: warning: 1 entry did not activate
better-sidebar (dsh-better-sidebar): pending (waiting for service: webRuntime)
```

插件本身**没有**报 `incompatible with dsh`、没有人点名它版本不对——只是永远停在 pending。

## 判定签名

1. 该插件入口里 `inject` 仍引用某个服务名，例如
   `export const inject = ['webServer','sessions','webRuntime','tools']`；
2. 内核已经删掉那个服务——桌面端自己的兼容层注释就是证据链：`resources/app/lib/profile-*.js` 里写着
   「Through dsh 0.2.1-alpha.1, web-runtime provided the `webRuntime` service … **0.2.1-alpha.2 removed that service**」；
3. 对照最新版插件：`grep -c webRuntime` 为 **0**（新版已不再依赖它）。

## 根因

上游内核在某个小版本里**删除了一个宿主服务**，老插件仍 `inject` 它 → Loader 认为依赖未满足 →
该行永久 pending → 汇总成一句 `1 entry did not activate`。
**这不是 ABI 不兼容**，所以不会有 `incompatible with dsh` 那种点名报错，最容易被当噪音忽略。

## 处置

把该插件升到不再注入该服务的版本（桌面端要走应用自己的 CLI，GUI 子系统程序不接控制台，输出必须重定向到文件）：

```cmd
set ELECTRON_RUN_AS_NODE=1 && "…\DSH Desktop.exe" "…\resources\app\lib\desktop-cli.js" plugin --profile desktop add dsh-better-sidebar@0.28.0 > "%TEMP%\bs.txt" 2>&1
```

- 装完看 `%TEMP%\bs.txt`：出现 `✓ Lockfile passes supply-chain policies` 即落地；
- 若卡在 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`（24h 冷却期）：先查目标版本发布时间，只有"其它已装包太新"时才需要 `--config.minimumReleaseAge=0` 一次性放行（pnpm 会自己往 `pnpm-workspace.yaml` 写 `minimumReleaseAgeExclude` 留痕）；
- **必须重启宿主**才生效，且要走 `schtasks` 通道（会话内起的 GUI 会被沙箱作业回收）。

## 验证

重启后看本次运行日志：`did not activate`、`disabling profile plugin row`、`waiting for service:` **三个模式都应为 0 次**，
只剩正常引导链（`shell-load.start` → `authenticate.complete` → `page-load.complete`）。

## 通式（升级内核前先查一遍）

这是"上游删服务"的通用形态，每次升内核都建议做一次静态排查：

1. 收集 profile 里每个插件 `inject` 依赖的服务名；
2. 到新内核里 grep 这些服务名是否还存在；
3. 对不上的插件**先升级**，再升内核（顺序反了就会出现"永久 pending"）。

反例对照：`Failed to load plugins`（ABI 不符）是**报错点名**，本条是**静默 pending**——症状、根因、处置都不同，别混。

## 实例

桌面端 2.0.17 → 2.0.18（内核 0.2.0-rc.2 → 0.2.1-rc.2）后出现；
`dsh-better-sidebar` 0.25.0（注入 `webRuntime`）→ 0.28.0（0 处引用）后，重启即三条告警全清零。
