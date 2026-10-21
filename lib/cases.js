/**
 * dsh-doctor / lib/cases.js —— 两个案例库的解析与读写
 *
 *   共享库（shared）：随包分发、由作者通过 PR 审核合入，只读。默认 <包>/docs/cases
 *   本地库（local）：这台机器自己沉淀的病例，可写（唯一写点），默认 <DSH_HOME>/dsh-doctor/cases
 *
 * 解析规则：
 *   - 读：按 prefer 顺序查找（默认 local 优先），命中即返回，并带 source 标签
 *   - 列：两个库都列，按来源分组；同 id 时本地覆盖共享（但索引里会标注"被本地覆盖"）
 *   - 写：只允许写本地库；id 不含路径分隔符；落盘前强制脱敏；默认不覆盖
 *
 * 安全（与 SECURITY.md 一致）：读取走 safeReadText 白名单；写入前 isInside 校验；
 * 写的内容必须过 redact()（防止把令牌/主机名沉淀进案例库）。
 */

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isInside, localIdentity, redact, safeReadText, stripControl } from './safety.js';

export const CASE_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;
export const MAX_CASES_PER_SOURCE = 400;

/** 解析两个库的物理位置（纯路径计算，不碰盘）。 */
export function resolveCaseSources(config = {}, env = process.env, packageRoot = process.cwd()) {
    const home = env.DSH_HOME || path.join(env.USERPROFILE || os.homedir(), '.dsh');
    const shared = path.resolve(config.sharedCasesDir || path.join(packageRoot, 'docs', 'cases'));
    const local = path.resolve(config.localCasesDir || path.join(home, 'dsh-doctor', 'cases'));
    const prefer = config.casesPrefer === 'shared' ? 'shared' : 'local';
    const writeLocal = config.allowLocalCaseWrite !== false;
    return { shared, local, prefer, writeLocal, home };
}

/** 列一个目录里的案例（只取标题，读 4KB 上限，最多 MAX_CASES_PER_SOURCE 个）。 */
function listOne(dir, source) {
    const out = [];
    let names = [];
    try {
        names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.md') && n.toLowerCase() !== 'index.md');
    } catch {
        return { source, dir, exists: false, cases: out };
    }
    for (const name of names.slice(0, MAX_CASES_PER_SOURCE)) {
        const file = path.join(dir, name);
        const r = safeReadText(file, { roots: [dir], maxBytes: 4096 });
        const id = name.replace(/\.md$/i, '');
        const firstLine = r.ok ? (r.text.split(/\r?\n/).find((l) => /^#\s+/.test(l)) || '') : '';
        out.push({
            id,
            source,
            title: firstLine.replace(/^#\s+/, '').trim() || '(无标题)',
            readable: r.ok,
            reason: r.ok ? null : r.reason,
            truncated: r.ok ? r.truncated : false,
        });
    }
    return { source, dir, exists: true, cases: out };
}

/**
 * 列出两个库并做合并：同 id 时标注覆盖关系。
 * 返回 { sources:[...], merged:[{id,title,source,shadowedBy,shadowedSource}] , counts }
 */
export function listCases(sources) {
    const shared = listOne(sources.shared, 'shared');
    const local = listOne(sources.local, 'local');
    const byId = new Map();
    // 先铺共享，再铺本地（本地覆盖）
    for (const c of shared.cases) byId.set(c.id, { ...c });
    for (const c of local.cases) {
        const prev = byId.get(c.id);
        byId.set(c.id, prev ? { ...c, shadowedBy: 'local', shadowedSource: 'shared' } : { ...c });
    }
    const merged = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return {
        sources: [shared, local],
        merged,
        counts: { shared: shared.cases.length, local: local.cases.length, total: merged.length },
    };
}

/** 按 id 读取：按 prefer 顺序找，返回 { source, text, dir } 或 null。 */
export function readCase(sources, id) {
    if (!CASE_ID_RE.test(String(id || ''))) return { error: 'bad-id' };
    const order = sources.prefer === 'shared' ? ['shared', 'local'] : ['local', 'shared'];
    for (const which of order) {
        const dir = sources[which];
        const file = path.join(dir, id.endsWith('.md') ? id : id + '.md');
        const r = safeReadText(file, { roots: [dir], maxBytes: 1024 * 1024 });
        if (r.ok) return { source: which, text: r.text, dir, truncated: r.truncated };
    }
    return null;
}

/**
 * 写一条本地病例（本插件唯一写点）。
 * 守卫：id 合法（无路径分隔符）→ 目标落在本地库内 → 内容强制脱敏 → 默认不覆盖。
 */
export function saveLocalCase(sources, { id, title, body }, opts = {}) {
    if (sources.writeLocal === false) return { ok: false, reason: 'local-write-disabled' };
    const rawId = String(id || '').trim().replace(/\.md$/i, '');
    if (!CASE_ID_RE.test(rawId)) return { ok: false, reason: 'bad-id' };
    const dir = sources.local;
    const target = path.join(dir, rawId + '.md');
    if (!isInside(dir, path.join(dir, rawId + '.md'))) return { ok: false, reason: 'outside-local-dir' };

    const identity = opts.identity || localIdentity();
    const cleanTitle = redact(String(title || rawId), identity).replace(/[\r\n]+/g, ' ').trim().slice(0, 120) || rawId;
    const cleanBody = redact(stripControl(String(body || '')).trim(), identity);
    if (!cleanBody) return { ok: false, reason: 'empty-body' };

    try {
        // 先确认目录可建/可用；失败直接给原因（不在半路留垃圾）
        mkdirSync(dir, { recursive: true });
    } catch {
        return { ok: false, reason: 'mkdir-failed' };
    }
    const exists = (() => {
        const probe = safeReadText(target, { roots: [dir], maxBytes: 64 });
        return probe.ok || probe.reason !== 'missing';
    })();
    if (exists && !opts.force) return { ok: false, reason: 'exists' };

    const stamp = new Date().toISOString();
    const doc = [
        `# ${cleanTitle}`,
        '',
        `> 来源：本地病例库（${stamp} 由 dsh-doctor 记录；内容已脱敏）`,
        '',
        cleanBody,
        '',
    ].join('\n');
    try {
        writeFileSync(target, doc, 'utf8');
    } catch {
        return { ok: false, reason: 'write-failed' };
    }
    return { ok: true, path: target, bytes: Buffer.byteLength(doc) };
}

/** 渲染"两个库"的索引文本（供 doctor_cases 无参调用）。 */
export function renderCaseIndex(listing, identity = localIdentity()) {
    const { sources, counts } = listing;
    const sharedSrc = sources.find((x) => x.source === 'shared');
    const localSrc = sources.find((x) => x.source === 'local');
    const lines = [];
    lines.push('# 案例库（本地 + 共享）');
    lines.push('');
    lines.push(`- 共享库（随包分发，只读）：\`${redact(String(sharedSrc && sharedSrc.dir), identity)}\` —— ${counts.shared} 条`);
    lines.push(`- 本地库（本机沉淀，可写）：\`${redact(String(localSrc && localSrc.dir), identity)}\` —— ${counts.local} 条`);
    lines.push(`- 合计 ${counts.total} 条；同名 id 时**本地覆盖共享**。`);
    lines.push('');
    for (const which of ['shared', 'local']) {
        const s = sources.find((x) => x.source === which);
        const label = which === 'shared' ? '共享库' : '本地库';
        lines.push(`## ${label}`);
        if (!s || !s.exists) {
            lines.push('_（目录不存在）_');
            lines.push('');
            continue;
        }
        const rows = listing.merged.filter((c) => c.source === which);
        if (rows.length === 0) lines.push('_（空）_');
        for (const c of rows) {
            const mark = c.shadowedSource === 'shared' ? '（本地覆盖了同名共享条目）' : '';
            lines.push(`- \`${c.id}\` ${redact(c.title, identity)}${mark}`);
        }
        lines.push('');
    }
    return lines.join('\n');
}
