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

/**
 * 案例类型（0.4.0）：
 *   runtime   —— DSH 运行期故障（谁都会遇到；必须有判定签名）
 *   authoring —— 插件/工具开发时踩的坑（作者才会遇到）
 * 缺省按 runtime 处理，所以现有 12 条案例零改动。
 */
export const CASE_KINDS = Object.freeze(['runtime', 'authoring']);

/** 从正文里读 `## 类型`（或 `**类型**`）。缺省 runtime；值非法返回 null（给 lint 报错用）。 */
export function extractKind(text) {
    const m = String(text || '').match(/(?:^##+\s*(?:类型|kind)[^\n]*\n+|\*\*(?:类型|kind)\*\*[：:]?\s*)([^\n\r]+)/im);
    if (!m) return 'runtime';
    const v = m[1].trim().toLowerCase().replace(/[`*]/g, '');
    return CASE_KINDS.includes(v) ? v : null;
}

/**
 * 本地病例合入共享库后的退役标记：正文里的一行 `> promoted: <shared-id>`。
 * 保留文件本身（本地库是用户自己写的），只是让人和索引都知道"这条已经提过了"。
 */
export function extractPromoted(text) {
    const m = String(text || '').match(/^>\s*promoted:\s*([A-Za-z0-9._-]{1,80})\s*$/im);
    return m ? m[1] : null;
}

/** 案例文件里"不该被当案例"的：下划线前缀（模板）、INDEX。 */
export function isCaseFile(name) {
    const n = String(name || '').toLowerCase();
    return n.endsWith('.md') && n !== 'index.md' && !n.startsWith('_');
}

/** 解析两个库的物理位置（纯路径计算，不碰盘）。 */
export function resolveCaseSources(config = {}, env = process.env, packageRoot = process.cwd()) {
    const home = env.DSH_HOME || path.join(env.USERPROFILE || os.homedir(), '.dsh');
    const shared = path.resolve(config.sharedCasesDir || path.join(packageRoot, 'docs', 'cases'));
    const local = path.resolve(config.localCasesDir || path.join(home, 'dsh-doctor', 'cases'));
    const prefer = config.casesPrefer === 'shared' ? 'shared' : 'local';
    const writeLocal = config.allowLocalCaseWrite !== false;
    return { shared, local, prefer, writeLocal, home };
}

/** 列一个目录里的案例（只取标题与元数据，读 8KB 上限，最多 MAX_CASES_PER_SOURCE 个）。 */
function listOne(dir, source) {
    const out = [];
    let names = [];
    try {
        names = readdirSync(dir).filter(isCaseFile);
    } catch {
        return { source, dir, exists: false, cases: out };
    }
    for (const name of names.slice(0, MAX_CASES_PER_SOURCE)) {
        const file = path.join(dir, name);
        const r = safeReadText(file, { roots: [dir], maxBytes: 8192 });
        const id = name.replace(/\.md$/i, '');
        const text = r.ok ? r.text : '';
        const firstLine = text.split(/\r?\n/).find((l) => /^#\s+/.test(l)) || '';
        out.push({
            id,
            source,
            title: firstLine.replace(/^#\s+/, '').trim() || '(无标题)',
            // 元数据读不到/非法时退回 runtime：索引不该因为一行元数据而报错
            kind: (text ? extractKind(text) : 'runtime') || 'runtime',
            promoted: text ? extractPromoted(text) : null,
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
export function saveLocalCase(sources, { id, title, body, kind }, opts = {}) {
    if (sources.writeLocal === false) return { ok: false, reason: 'local-write-disabled' };
    const rawId = String(id || '').trim().replace(/\.md$/i, '');
    if (!CASE_ID_RE.test(rawId)) return { ok: false, reason: 'bad-id' };
    const cleanKind = kind == null || kind === '' ? 'runtime' : String(kind).trim().toLowerCase();
    if (!CASE_KINDS.includes(cleanKind)) return { ok: false, reason: 'bad-kind' };
    const dir = sources.local;
    const target = path.join(dir, rawId + '.md');

    const identity = opts.identity || localIdentity();
    const cleanTitle = redact(String(title || rawId), identity).replace(/[\r\n]+/g, ' ').trim().slice(0, 120) || rawId;
    const cleanBody = redact(stripControl(String(body || '')).trim(), identity);
    if (!cleanBody) return { ok: false, reason: 'empty-body' };

    // 先确保目录存在，再做白名单校验：否则"目录尚不存在"时 realpath 退化，
    // 首次写入会被误判成越界（真机验证时踩到过）。
    try {
        mkdirSync(dir, { recursive: true });
    } catch {
        return { ok: false, reason: 'mkdir-failed' };
    }
    if (!isInside(dir, target)) return { ok: false, reason: 'outside-local-dir' };
    const exists = (() => {
        const probe = safeReadText(target, { roots: [dir], maxBytes: 64 });
        return probe.ok || probe.reason !== 'missing';
    })();
    if (exists && !opts.force) return { ok: false, reason: 'exists' };

    const stamp = new Date().toISOString();
    const head = [`# ${cleanTitle}`, '', `> 来源：本地病例库（${stamp} 由 dsh-doctor 记录；内容已脱敏）`, ''];
    // authoring 类必须显式写一行类型；runtime 是缺省值，不写以保持文件干净
    if (cleanKind !== 'runtime') head.push('## 类型', '', cleanKind, '');
    const doc = [...head, cleanBody, ''].join('\n');
    try {
        writeFileSync(target, doc, 'utf8');
    } catch {
        return { ok: false, reason: 'write-failed' };
    }
    return { ok: true, path: target, bytes: Buffer.byteLength(doc) };
}

/**
 * 从病例正文里抽出「可直接复制」的处置命令。
 *
 * 只认显式的 `## 处置命令` 章节里的围栏块 —— **不从散文和表格里猜**。
 * 理由：病例正文里带反引号的东西一半是命令、一半是路径/代码片段
 * （真机抽样：`node --test --test-concurrency=2` 和 `profiles\desktop\pnpm-lock.yaml` 同级），
 * 猜出来的"命令"点一下就跑偏，比不给更糟。
 */
export function extractCommands(text) {
    const lines = String(text || '').split(/\r?\n/);
    const out = [];
    let inSection = false;
    let inFence = false;
    let lang = '';
    for (const line of lines) {
        if (/^##\s+/.test(line)) {
            inSection = /^##\s*处置命令/.test(line);
            inFence = false;
            continue;
        }
        if (!inSection) continue;
        const fence = /^```([A-Za-z0-9_-]*)\s*$/.exec(line.trim());
        if (fence) {
            if (!inFence) {
                inFence = true;
                lang = (fence[1] || '').toLowerCase();
            } else {
                inFence = false;
                lang = '';
            }
            continue;
        }
        if (!inFence || lang === 'json') continue;
        const cmd = line.trim();
        if (!cmd || cmd.startsWith('#')) continue;
        out.push(cmd.slice(0, 600));
    }
    return out;
}

/** 读一条病例并抽出处置命令（读不到 / 没有该章节 → 空数组）。 */
export function commandsForCase(sources, id) {
    const hit = readCase(sources, id);
    if (!hit || hit.error) return [];
    return extractCommands(hit.text);
}

/**
 * 给本地病例打「已合入共享库」标记（写入正文一行 `> promoted: <id>`）。
 * 守卫与写案例同口径：id 白名单 → 目标落在本地库内 → 只改那一行。
 */
export function markPromoted(sources, localId, sharedId, opts = {}) {
    const a = String(localId || '').trim().replace(/\.md$/i, '');
    const b = String(sharedId || '').trim().replace(/\.md$/i, '');
    if (!CASE_ID_RE.test(a)) return { ok: false, reason: 'bad-local-id' };
    if (!CASE_ID_RE.test(b)) return { ok: false, reason: 'bad-shared-id' };
    const dir = sources.local;
    const target = path.join(dir, a + '.md');
    if (!isInside(dir, target)) return { ok: false, reason: 'outside-local-dir' };

    const r = safeReadText(target, { roots: [dir], maxBytes: 1024 * 1024 });
    if (!r.ok) return { ok: false, reason: r.reason === 'missing' ? 'not-found' : 'read-failed' };

    const lines = r.text.split(/\r?\n/);
    const marker = `> promoted: ${b}`;
    const prev = extractPromoted(r.text);
    if (prev === b) return { ok: true, path: target, already: true };
    if (prev && !opts.force) return { ok: false, reason: 'already-promoted', previous: prev };

    const pi = lines.findIndex((l) => /^>\s*promoted:/i.test(l));
    if (pi >= 0) {
        lines[pi] = marker;
    } else {
        const srcIdx = lines.findIndex((l) => /^>\s*来源[：:]/.test(l));
        if (srcIdx >= 0) {
            lines.splice(srcIdx + 1, 0, marker);
        } else {
            const h1 = lines.findIndex((l) => /^#\s+/.test(l));
            lines.splice(h1 >= 0 ? h1 + 1 : 0, 0, marker, '');
        }
    }
    const text = lines.join('\n');
    try {
        writeFileSync(target, text, 'utf8');
    } catch {
        return { ok: false, reason: 'write-failed' };
    }
    return { ok: true, path: target, bytes: Buffer.byteLength(text) };
}

/** 取命中行做片段（截 120 字），让"搜到了"变成"看得出哪条对"。 */
function snippetAround(text, token) {
    const lines = String(text || '').split(/\r?\n/);
    const idx = lines.findIndex((l) => l.toLowerCase().includes(token));
    const raw = (idx >= 0 ? lines[idx] : lines[0] || '').replace(/^#+\s*/, '').replace(/[`*|]/g, '').trim();
    return raw.length > 120 ? raw.slice(0, 120) + '…' : raw;
}

/**
 * 全文关键词检索（0.4.0）。
 *
 * 语义刻意保守：**多个词都要出现（AND）**、大小写不敏感、搜正篇。
 * 不做排序、不做相似度——搜不到就是搜不到，比"给你一堆似是而非"更有用。
 *
 * @returns {{query:string, tokens:string[], hits:{id,source,title,kind,promoted,snippet}[]}}
 */
export function searchCases(sources, query, { limit = 20 } = {}) {
    const q = String(query || '').trim();
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return { query: q, tokens: [], hits: [] };
    const cap = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const order = sources.prefer === 'shared' ? ['shared', 'local'] : ['local', 'shared'];
    const hits = [];
    const seen = new Set();

    for (const which of order) {
        const dir = sources[which];
        let names = [];
        try {
            names = readdirSync(dir).filter(isCaseFile);
        } catch {
            continue;
        }
        for (const name of names.slice(0, MAX_CASES_PER_SOURCE)) {
            const id = name.replace(/\.md$/i, '');
            if (seen.has(id)) continue; // 同名时按 prefer 顺序先命中的那个算
            const r = safeReadText(path.join(dir, name), { roots: [dir], maxBytes: 1024 * 1024 });
            if (!r.ok) continue;
            const lower = r.text.toLowerCase();
            if (!tokens.every((t) => lower.includes(t))) continue;
            seen.add(id);
            const titleLine = r.text.split(/\r?\n/).find((l) => /^#\s+/.test(l)) || '';
            hits.push({
                id,
                source: which,
                title: titleLine.replace(/^#\s+/, '').trim() || '(无标题)',
                kind: extractKind(r.text) || 'runtime',
                promoted: extractPromoted(r.text),
                snippet: snippetAround(r.text, tokens[0]),
            });
            if (hits.length >= cap) break;
        }
        if (hits.length >= cap) break;
    }
    return { query: q, tokens, hits };
}

/** 渲染检索结果（doctor_cases --search 用）。 */
export function renderCaseSearch(result, identity = localIdentity()) {
    const lines = [];
    lines.push(`# 案例检索：${result.query}`);
    lines.push('');
    if (result.hits.length === 0) {
        lines.push('没有命中。（多个关键词是"都要出现"的关系，换个更短的词再试。）');
        return lines.join('\n');
    }
    lines.push(`命中 ${result.hits.length} 条（多关键词要求同时出现）：`);
    lines.push('');
    for (const h of result.hits) {
        const tag = h.kind === 'authoring' ? ' `[authoring]`' : '';
        const src = h.source === 'local' ? '（本地库）' : '';
        const promoted = h.promoted ? `（已合入 \`${h.promoted}\`）` : '';
        lines.push(`- \`${h.id}\`${tag} ${redact(h.title, identity)}${src}${promoted}`);
        if (h.snippet) lines.push(`  > ${redact(h.snippet, identity)}`);
    }
    lines.push('');
    lines.push('读全文：`doctor_cases`（带 `id`）。');
    return lines.join('\n');
}

/** 索引用：取正文第一个 H1 作标题。 */
export function caseTitle(text) {
    const m = String(text || '').match(/^#\s+(.+)$/m);
    return m ? m[1].trim() : '(无标题)';
}

/**
 * 索引用：取「根因」段的第一行作摘要（没有就退回「处置」）。
 *
 * 注意 `m` 标志：没有它 `^` 只匹配整个文件开头，摘要列会**永远**显示 "—"。
 * 这个 bug 在真机上静默存在过一版（15 条案例的摘要全是空的），所以这里单独抽出来可测。
 */
export function caseSummary(text) {
    const md = String(text || '');
    for (const label of ['根因', '处置', '原因', '对策']) {
        const re = new RegExp(`(?:^##+\\s*${label}[^\\n]*\\n+|\\*\\*${label}\\*\\*[：:]?\\s*)([^\\n\\r]+)`, 'm');
        const m = md.match(re);
        if (m) {
            const line = m[1].replace(/[`*|]/g, '').replace(/^[：:\s]+/, '').trim();
            if (line) return line.slice(0, 90);
        }
    }
    return '—';
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
            const kind = c.kind === 'authoring' ? ' `[authoring]`' : '';
            const promoted = c.promoted ? `（已合入共享库 \`${c.promoted}\`）` : '';
            lines.push(`- \`${c.id}\`${kind} ${redact(c.title, identity)}${mark}${promoted}`);
        }
        lines.push('');
    }
    return lines.join('\n');
}
