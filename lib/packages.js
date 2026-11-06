/**
 * dsh-doctor / lib/packages.js —— profile 里到底装了什么、跑得起来吗（纯读）
 *
 * 0.1.x 只看 `dsh.profile.bundles` 这个字符串数组，等于只看了"菜单上没有菜"，
 * 没看"菜能不能做出来"。0.2.0 补上两件静态事实：
 *
 *   1) **这个 bundle 能不能被解析到**：解析不到 = 它根本不会加载（真问题）；
 *   2) **它的 peer 范围满不满足当前内核**：这是「内核升级前就能预警插件会挂」的唯一静态线索。
 *
 * 两条都要防误报：
 *   - `@deepseek-ai/*` 是内核自带的 bundle，不存在于 profile/node_modules 是正常的，直接跳过；
 *   - peer 范围看不懂（`workspace:*` 之类）就返回 unknown，不猜。
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { safeReadText } from './safety.js';
import { satisfies } from './semver-lite.js';

/** 内核自带的 bundle 前缀：它们随内核安装，不该在 profile 里找。 */
export const KERNEL_PREFIXES = ['@deepseek-ai/'];

export function isKernelProvided(name) {
    return KERNEL_PREFIXES.some((p) => String(name).startsWith(p));
}

function readJson(file) {
    const r = safeReadText(file, { roots: [path.dirname(file)], maxBytes: 256 * 1024 });
    if (!r.ok) return null;
    try {
        return JSON.parse(r.text);
    } catch {
        return null;
    }
}

/**
 * 从 profile 出发解析一个包：先直连 node_modules（pnpm 也在这里建顶层符号链接），
 * 再退到 Node 解析（能穿透 exports/条件导出），最后看内核安装目录。
 *
 * @returns {{name:string, found:boolean, dir:string|null, version:string|null, peer:string|null}}
 */
export function resolveBundle(profileDir, name, kernelDirs = []) {
    const empty = { name, found: false, dir: null, version: null, peer: null };

    const direct = path.join(profileDir, 'node_modules', ...String(name).split('/'), 'package.json');
    if (existsSync(direct)) {
        const j = readJson(direct);
        if (j) return { name, found: true, dir: path.dirname(direct), version: j.version ? String(j.version) : null, peer: peerRangeOf(j) };
    }

    try {
        const req = createRequire(path.join(profileDir, 'package.json'));
        const resolved = req.resolve(`${name}/package.json`);
        const j = readJson(resolved);
        if (j) return { name, found: true, dir: path.dirname(resolved), version: j.version ? String(j.version) : null, peer: peerRangeOf(j) };
    } catch {
        /* 继续看内核目录 */
    }

    for (const kernelDir of kernelDirs) {
        const cand = path.join(kernelDir, 'node_modules', ...String(name).split('/'), 'package.json');
        if (existsSync(cand)) {
            const j = readJson(cand);
            if (j) return { name, found: true, dir: path.dirname(cand), version: j.version ? String(j.version) : null, peer: peerRangeOf(j) };
        }
    }

    return empty;
}

/** 读 `peerDependencies['@deepseek-ai/dsh']`（没有就 null）。 */
export function peerRangeOf(pkgJson) {
    const peers = pkgJson && pkgJson.peerDependencies;
    if (!peers || typeof peers !== 'object') return null;
    const v = peers['@deepseek-ai/dsh'];
    return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * 检一个 profile 的 bundles。
 *
 * @param {object} profile           detect.js 产出的 profile（含 dir / bundles）
 * @param {string[]} kernelVersions  本机发现的内核版本（去重、非空）
 * @param {string[]} kernelDirs      本机内核安装目录（用于兜底解析）
 * @returns {{name:string, skipped:boolean, found:boolean, version:string|null, peer:string|null, satisfied:boolean|null}[]}
 */
/** 开发期占位范围（发布时会被改写）：不是真实约束，不该报成"不满足"或"不知道"。 */
const PLACEHOLDER_RANGE = /^(workspace:|file:|link:|portal:|npm:|git(\+|:)|https?:)/i;

export function inspectBundles(profile, kernelVersions = [], kernelDirs = []) {
    const out = [];
    for (const raw of profile.bundles || []) {
        const name = String(raw || '').trim();
        if (!name) continue;
        if (isKernelProvided(name)) {
            // 内核自带：不解析、不判定，避免把正常情况报成缺包
            out.push({ name, skipped: true, found: true, version: null, peer: null, satisfied: null });
            continue;
        }
        const r = resolveBundle(profile.dir, name, kernelDirs);
        let satisfied = null;
        if (r.found && r.peer && kernelVersions.length) {
            if (PLACEHOLDER_RANGE.test(r.peer)) {
                satisfied = true; // 占位范围 = 没有真实约束
            } else {
                const verdicts = kernelVersions.map((v) => satisfies(v, r.peer));
                // 任一内核满足就算满足（多内核机器上无法确定这个 profile 跑在哪一个上）
                if (verdicts.some((v) => v === true)) satisfied = true;
                else if (verdicts.some((v) => v === null)) satisfied = null;
                else satisfied = false;
            }
        }
        out.push({ ...r, skipped: false, satisfied });
    }
    return out;
}

/** 从 discovery.engines 收集内核版本与内核安装目录。 */
export function kernelProfileOf(discovery) {
    const versions = new Set();
    const dirs = new Set();
    for (const e of (discovery && discovery.engines) || []) {
        // npm 引擎的 version 就是 `@deepseek-ai/dsh` 的版本，也就是内核版本
        if (e.kind === 'npm' && e.version) versions.add(String(e.version));
        if (e.kernelVersion) versions.add(String(e.kernelVersion));
        // npm 引擎：<prefix>/node_modules/@deepseek-ai/dsh/package.json
        // 桌面端：<dir>/resources/app/node_modules/@deepseek-ai/dsh/package.json
        if (e.path) dirs.add(path.dirname(path.dirname(path.dirname(e.path))));
        if (e.kind === 'desktop' && e.dir) dirs.add(path.join(e.dir, 'resources', 'app'));
        if (e.kind === 'npm' && e.dir) dirs.add(e.dir);
    }
    return { versions: [...versions], dirs: [...dirs] };
}
