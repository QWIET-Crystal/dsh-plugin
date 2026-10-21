/**
 * dsh-doctor / lib/config.js —— 插件 Config（用宿主真实的 schemastery 构造）
 *
 * 两次真机教训（都在 2026-10-21/22 踩出来的）：
 *
 * 1) **不能导出一个"像 schema 但没有 ~standard"的对象**。cordis 的 resolveConfig 是：
 *        if (!runtime.Config) return config;
 *        runtime.Config["~standard"].validate(config);
 *    所以 Config 存在但缺 Standard Schema 协议 → TypeError → 整条 entry 不激活。
 *    （`Config` 为 undefined 反而是**安全**的：会被上面的 if 兜住。）
 *
 * 2) **不能手搓 schemastery 的 JSON 形状**。它的 toJSON() 是 refs/uid 图
 *    （{uid, refs: {"23": {type:'object', dict:{n:6,...}}}}）；设置页拿这个图去渲染表单，
 *    手搓的扁平 JSON 会被静默丢光字段。
 *
 * 结论：能解析到真 schemastery 就用它构造；解析不到就 **不导出 Config**
 * （插件照常工作，只是没有设置页），绝不拿半成品糊弄宿主。
 */

import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const NAMES = ['@deepseek-ai/schemastery', 'schemastery'];

/** 一个候选 z 是否真的可用（能造 schema、能 toJSON、能按 Standard Schema 校验）。 */
function usable(z) {
    try {
        if (!z || typeof z.object !== 'function') return false;
        // 只用最基本的构造，别用 .optional() 之类可能不存在的修饰（schemastery 3.x 没有它）
        const probe = z.object({ field: z.string() });
        const std = probe['~standard'];
        return Boolean(std && typeof std.validate === 'function') && typeof probe.toJSON === 'function';
    } catch {
        return false;
    }
}

function accept(mod) {
    const z = mod && (mod.default || mod);
    return usable(z) ? z : null;
}

/** 列出可以当解析根的目录：cwd、宿主 app、可执行文件目录、各 profile。 */
function candidateBases() {
    const bases = new Set();
    const add = (p) => {
        if (p && typeof p === 'string') bases.add(path.resolve(p));
    };
    add(process.cwd());
    if (typeof process.resourcesPath === 'string') add(path.join(process.resourcesPath, 'app'));
    add(path.dirname(process.execPath));
    // ELECTRON_RUN_AS_NODE 子进程里 process.resourcesPath 可能不存在，但 exe 路径仍在
    add(path.join(path.dirname(process.execPath), 'resources', 'app'));
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    add(home);
    try {
        for (const name of readdirSync(path.join(home, 'profiles'))) add(path.join(home, 'profiles', name));
    } catch {
        /* 没有 profiles 目录就算了 */
    }
    return [...bases];
}

async function resolveSchemastery() {
    // ① 裸导入：npm 安装的插件走这条（profile 的 node_modules 在解析链上）
    for (const name of NAMES) {
        try {
            const z = accept(await import(name));
            if (z) return z;
        } catch {
            /* 下一条 */
        }
    }
    // ② 路径解析：link: 安装时唯一可靠的方式（按宿主 app / profile 目录去找）
    for (const base of candidateBases()) {
        let req;
        try {
            req = createRequire(path.join(base, 'noop.cjs'));
        } catch {
            continue;
        }
        for (const name of NAMES) {
            try {
                const resolved = req.resolve(name);
                const z = accept(await import(pathToFileURL(resolved).href));
                if (z) return z;
            } catch {
                /* 下一个候选 */
            }
        }
    }
    return null;
}

const CONTRIBUTE_GUIDE = [
    '共享案例库由「审阅」增长，不由遥测：',
    '1) 用 doctor_case_add 把这次的故障写进本地库（自动脱敏；共享库插件只读，不会误写）',
    '2) 把生成的 .md 复制进 仓库 docs/cases/',
    '3) 重建索引：node tools/index-cases.mjs',
    '4) 开 PR；维护者 review 合并后，其他人 git pull（或把 sharedCasesDir 指向自己 clone 的仓库）就拿到',
    '',
    '本地库默认在 $DSH_HOME/dsh-doctor/cases；共享库默认在本包的 docs/cases。',
].join('\n');

const z = await resolveSchemastery();

/** 用真 schemastery 构造；解析不到就 undefined（无设置页，但插件健康）。 */
export const Config = z
    ? z
          .object({
              maxProfiles: z.number().min(1).max(200).default(32).volatile().description('扫描 DSH_HOME 下最多多少个 profile（默认 32）'),
              maxLogBytes: z.number().min(4096).max(33554432).default(2 * 1024 * 1024).volatile().description('单个日志文件读取上限（字节，默认 2 MiB；超限会标注 truncated）'),
              httpTimeoutMs: z.number().min(100).max(30000).default(1200).volatile().description('端口连通性探测超时（毫秒，默认 1200）'),
              cacheTtlMs: z.number().min(0).max(600000).default(15000).volatile().description('引擎发现结果缓存（毫秒，0=每次重扫；默认 15000）'),
              casesPrefer: z.union(['local', 'shared']).default('local').volatile().description('同名案例 id 时优先读哪个库（默认 local，本地覆盖共享）'),
              localCasesDir: z.string().volatile().description('本地案例库目录（默认 $DSH_HOME/dsh-doctor/cases；留空用默认）'),
              sharedCasesDir: z.string().volatile().description('共享案例库目录（默认本包 docs/cases；可指向你 clone 的仓库，git pull 即更新）'),
              allowLocalCaseWrite: z.boolean().default(true).volatile().description('允许 doctor_case_add 写本地案例库；设 false 则插件回到完全只读'),
              contributeGuide: z.string().default(CONTRIBUTE_GUIDE).volatile().description('贡献共享案例库的流程提醒（保留原文即可；完整说明见 docs/CONTRIBUTING.md）'),
          })
          .description(
              '贡献病例：dsh-doctor 跨引擎只读体检。案例库分「共享库（随包分发，只读，由 PR 审阅增长）」与「本地库（本机沉淀，可写）」；' +
                  '同名 id 默认本地覆盖共享。贡献流程见 contributeGuide 字段或 docs/CONTRIBUTING.md。',
          )
    : undefined;

export const CONFIG_AVAILABLE = Boolean(z);
export { CONTRIBUTE_GUIDE };
