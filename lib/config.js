/**
 * dsh-doctor / lib/config.js —— 插件 Config schema
 *
 * DSH 的设置页是**按插件的 Config schema 自动生成**的（宿主 `dsh-settings` 用 volatileForm 投影），
 * 所以只要导出 Config，设置栏就会出现 dsh-doctor 一栏；带 `.volatile()` 的字段可在线改。
 *
 * schemastery 的包名在不同 DSH 版本里有两种形态（`schemastery` ↔ `@deepseek-ai/schemastery`），
 * 这里运行期解析；解析不到就导出 undefined —— 插件照常工作，只是没有设置页（优雅降级）。
 */

async function resolveSchemastery() {
    for (const name of ['schemastery', '@deepseek-ai/schemastery']) {
        try {
            const mod = await import(name);
            const z = mod && (mod.default || mod);
            if (z && typeof z.object === 'function') return z;
        } catch {
            /* 换下一个名字 */
        }
    }
    return null;
}

export const z = await resolveSchemastery();

/** 贡献共享案例库的四步流程（同时写进设置栏与 docs/CONTRIBUTING.md，起提醒作用）。 */
export const CONTRIBUTE_GUIDE = [
    '共享案例库由「审阅」增长，不由遥测：',
    '1) 用 doctor_case_add 把这次的故障写进本地库（自动脱敏；共享库插件只读，不会误写）',
    '2) 把生成的 .md 复制进 仓库 docs/cases/',
    '3) 重建索引：node tools/build-cases.mjs（或在 docs/cases/INDEX.md 手工加一行）',
    '4) 开 PR；维护者 review 合并后，其他人 git pull（或把 sharedCasesDir 指向自己 clone 的仓库）就拿到',
    '',
    '本地库默认在 $DSH_HOME/dsh-doctor/cases；共享库默认在本包的 docs/cases。',
].join('\n');

export const Config = z
    ? z
          .object({
              maxProfiles: z
                  .number()
                  .min(1)
                  .max(200)
                  .default(32)
                  .volatile()
                  .description('扫描 DSH_HOME 下最多多少个 profile（默认 32）'),
              maxLogBytes: z
                  .number()
                  .min(4096)
                  .max(33554432)
                  .default(2 * 1024 * 1024)
                  .volatile()
                  .description('单个日志文件读取上限（字节，默认 2 MiB；超限会标注 truncated）'),
              httpTimeoutMs: z
                  .number()
                  .min(100)
                  .max(30000)
                  .default(1200)
                  .volatile()
                  .description('端口连通性探测超时（毫秒，默认 1200）'),
              cacheTtlMs: z
                  .number()
                  .min(0)
                  .max(600000)
                  .default(15000)
                  .volatile()
                  .description('引擎发现结果缓存（毫秒，0=每次重扫；默认 15000）'),
              casesPrefer: z
                  .union(['local', 'shared'])
                  .default('local')
                  .volatile()
                  .description('同名案例 id 时优先读哪个库（默认 local，本地覆盖共享）'),
              localCasesDir: z
                  .string()
                  .volatile()
                  .description('本地案例库目录（默认 $DSH_HOME/dsh-doctor/cases；留空用默认）'),
              sharedCasesDir: z
                  .string()
                  .volatile()
                  .description('共享案例库目录（默认本包 docs/cases；可指向你 clone 的仓库，git pull 即更新）'),
              allowLocalCaseWrite: z
                  .boolean()
                  .default(true)
                  .volatile()
                  .description('允许 doctor_case_add 写本地案例库；设 false 则插件回到完全只读'),
              contributeGuide: z
                  .string()
                  .default(CONTRIBUTE_GUIDE)
                  .volatile()
                  .description('贡献共享案例库的流程提醒（保留原文即可；完整说明见 docs/CONTRIBUTING.md）'),
          })
          .description(
              'dsh-doctor：跨引擎只读体检。案例库分「共享库（随包分发，只读，由 PR 审阅增长）」与「本地库（本机沉淀，可写）」；' +
                  '同名 id 默认本地覆盖共享。贡献流程见 contributeGuide 字段或 docs/CONTRIBUTING.md。',
          )
    : undefined;
