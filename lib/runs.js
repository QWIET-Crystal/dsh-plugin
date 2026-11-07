/**
 * dsh-doctor / lib/runs.js —— 体检历史（0.2.0 新增的第二个写点）
 *
 * 为什么需要它：`doctor_check` 只能回答"现在怎么样"，回答不了"什么时候开始坏的"。
 * 上一次绿、这次黄，本身就是最有用的证据。
 *
 * 但它和本插件"只读"的卖点直接冲突，所以这里做了三道保险：
 *
 *   1) **默认可以关**：`config.saveRuns=false` 时一行都不写（SECURITY.md 里同步声明）。
 *   2) **内容去重**：同一份结论（sha256 相同）在 throttleMs 内只落一个文件，
 *      面板刷新/agent 连调不会刷出一堆重复文件。
 *   3) **写失败不致命**：返回 {ok:false, reason}，调用方降级成一条 info，结论照常给出。
 *      —— 取证不能因为"记不住"而失败。
 *
 * 落盘位置默认 `$DSH_HOME/dsh-doctor/runs/`，只写**当前宿主自己的** DSH_HOME
 * （一个插件服务一个宿主；写别人的 home 是越界）。
 */

import { createHash } from 'node:crypto';
import { realpathSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const RUNS_DIRNAME = 'runs';
export const DEFAULT_RETENTION = 30;
export const MAX_RETENTION = 500;
const RUN_FILE_RE = /^[0-9TZ.+-]+-[0-9a-f]{8}\.json$/;

/** 解析历史目录（纯路径计算，不碰盘）。 */
export function resolveRunsDir(env = process.env, configured) {
    if (configured && String(configured).trim()) return path.resolve(String(configured).trim());
    const home = env.DSH_HOME || path.join(env.USERPROFILE || os.homedir(), '.dsh');
    return path.join(home, 'dsh-doctor', RUNS_DIRNAME);
}

function clampInt(v, def, lo, hi) {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.min(Math.max(Math.trunc(n), lo), hi);
}

/** 进程内节流表：同一个目录、同一份内容、在窗口内只写一次。 */
const throttleMemo = new Map();

/** 把 ISO 时间戳变成文件名安全的形式。 */
function stampFor(iso) {
    return String(iso).replace(/[:.]/g, '-');
}

function listRunFiles(dir) {
    try {
        return readdirSync(dir)
            .filter((n) => RUN_FILE_RE.test(n))
            .map((name) => {
                let mtime = 0;
                let bytes = 0;
                try {
                    const st = statSync(path.join(dir, name));
                    mtime = Number(st.mtimeMs);
                    bytes = Number(st.size);
                } catch {
                    /* 读不到就按 0 处理，排序会把它放最后 */
                }
                return { name, mtime, bytes };
            })
            .sort((a, b) => b.mtime - a.mtime);
    } catch {
        return [];
    }
}

/** 读最新一个 run 的 _hash（跨进程去重用；坏了就当没有）。 */
function newestHash(dir) {
    const [newest] = listRunFiles(dir);
    if (!newest) return { hash: null, mtime: 0 };
    try {
        const doc = JSON.parse(readFileSync(path.join(dir, newest.name), 'utf8'));
        return { hash: typeof doc._hash === 'string' ? doc._hash : null, mtime: newest.mtime };
    } catch {
        return { hash: null, mtime: 0 };
    }
}

/** 只保留最近 retention 个文件（0 表示不写，调用方已提前拦下）。 */
export function pruneRuns(dir, retention = DEFAULT_RETENTION) {
    const keep = clampInt(retention, DEFAULT_RETENTION, 1, MAX_RETENTION);
    const files = listRunFiles(dir);
    const removed = [];
    for (const f of files.slice(keep)) {
        try {
            unlinkSync(path.join(dir, f.name));
            removed.push(f.name);
        } catch {
            /* 删不掉不影响结论 */
        }
    }
    return removed;
}

/**
 * 落一份体检结论。
 *
 * @param {string} dir        历史目录
 * @param {object} payload    要存的 JSON（已脱敏）
 * @param {object} [opts]     { retention?, throttleMs?, now?, hashSource? }
 *                            hashSource：参与"同内容"判定的对象（默认整份 payload）。
 *                            **必须排除 generatedAt 这类每次都会变的字段**，否则节流永远不命中。
 * @returns {{ok:boolean, path?:string, skipped?:boolean, reason?:string, hash?:string}}
 */
export function saveRun(dir, payload, opts = {}) {
    const retention = clampInt(opts.retention, DEFAULT_RETENTION, 1, MAX_RETENTION);
    const throttleMs = clampInt(opts.throttleMs, 0, 0, 24 * 60 * 60 * 1000);
    const now = Number(opts.now) || Date.now();

    let text;
    try {
        text = JSON.stringify(opts.hashSource === undefined ? payload : opts.hashSource);
    } catch {
        return { ok: false, reason: 'not-serializable' };
    }
    const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);

    // ① 进程内节流
    const memo = throttleMemo.get(dir);
    if (memo && memo.hash === hash && now - memo.at < throttleMs) {
        return { ok: true, skipped: true, reason: 'duplicate', hash };
    }
    // ② 跨进程节流：看磁盘上最新那份
    if (throttleMs > 0) {
        const prev = newestHash(dir);
        if (prev.hash === hash && now - prev.mtime < throttleMs) {
            throttleMemo.set(dir, { hash, at: now });
            return { ok: true, skipped: true, reason: 'duplicate', hash };
        }
    }

    try {
        mkdirSync(dir, { recursive: true });
    } catch {
        return { ok: false, reason: 'mkdir-failed' };
    }

    const generatedAt = typeof payload.generatedAt === 'string' ? payload.generatedAt : new Date(now).toISOString();
    const file = path.join(dir, `${stampFor(generatedAt)}-${hash.slice(0, 8)}.json`);
    const doc = { ...payload, _hash: hash };
    try {
        writeFileSync(file, JSON.stringify(doc), 'utf8');
    } catch {
        return { ok: false, reason: 'write-failed' };
    }
    throttleMemo.set(dir, { hash, at: now });
    pruneRuns(dir, retention);
    return { ok: true, path: file, hash, skipped: false, reason: null };
}

/**
 * 列历史（新的在前）。坏文件跳过，不抛。
 *
 * 0.5.3：加解析预算。原来对每个历史文件**整份 JSON.parse**，30 个 4MB 的历史
 * 就是 121MB 主线程解析——一个 ~100 字节的 GET 能把它放大成秒级阻塞。
 * 现在：单文件超 512KB 只给元数据（不解析），整轮总预算 4MB。
 */
const MAX_SUMMARY_BYTES = 512 * 1024;
const MAX_SUMMARY_TOTAL = 4 * 1024 * 1024;

export function listRuns(dir, limit = DEFAULT_RETENTION) {
    const max = clampInt(limit, DEFAULT_RETENTION, 1, MAX_RETENTION);
    const out = [];
    let budget = MAX_SUMMARY_TOTAL;
    for (const f of listRunFiles(dir).slice(0, max)) {
        let summary = null;
        let verdict = null;
        let generatedAt = null;
        let truncated = false;
        if (f.bytes > MAX_SUMMARY_BYTES || budget < f.bytes) {
            truncated = true;
        } else {
            budget -= f.bytes;
            try {
                const doc = JSON.parse(readFileSync(path.join(dir, f.name), 'utf8'));
                summary = doc.summary || null;
                verdict = doc.verdict || null;
                generatedAt = doc.generatedAt || null;
            } catch {
                /* 坏文件照样列出来，只是没有摘要 */
            }
        }
        const row = { name: f.name, bytes: f.bytes, mtime: f.mtime, generatedAt, verdict, summary };
        if (truncated) row.truncated = true;
        out.push(row);
    }
    return out;
}

/** 读最新一份历史（没有就返回 null）。修复识别要用它跟"上一轮"对比。 */
export function readLatestRun(dir) {
    const [newest] = listRunFiles(dir);
    if (!newest) return null;
    try {
        return JSON.parse(readFileSync(path.join(dir, newest.name), 'utf8'));
    } catch {
        return null;
    }
}

/** 读一条历史。name 必须是目录里的纯文件名（不许带分隔符 / `..` / 指向目录外的链接 / 硬链接）。
 *
 * 0.5.4：`?run=` 这条读路径以前只有"纯文件名"这一道门，但文件系统链接绕得过去：
 * - 符号链接 / junction：用 `realpathSync.native` 比对 runs 根；
 * - **硬链接**：它就是同一个 inode 的第二个目录项，realpath 看不出来（真实路径就是链接自己），
 *   只能看 `nlink`——正常的体检历史只有 1 个目录项，>1 说明有别的入口，一律拒绝。
 */
export function readRun(dir, name, { maxBytes = 0 } = {}) {
    // 只服务本工具写的文件名：runs 目录若被 junction 换到别处，
    // 也不能把别人的 settings.json 当"历史"原样回传（红队实测能读出令牌）。
    const base = String(name || '').trim();
    const withExt = base.endsWith('.json') ? base : base + '.json';
    // 只服务本工具写的文件名：runs 目录若被 junction 换到别处，
    // 也不能把别人的 settings.json 当"历史"原样回传（红队实测能读出令牌）。
    if (!RUN_FILE_RE.test(withExt)) return { ok: false, reason: 'bad-name' };
    if (!base || base.includes('/') || base.includes('\\') || base.includes('..')) return { ok: false, reason: 'bad-name' };
    const file = path.join(dir, base.endsWith('.json') ? base : base + '.json');
    try {
        if (!insideRunsDir(dir, file)) return { ok: false, reason: 'bad-name' };
        const st = statSync(file);
        if (st.nlink > 1) return { ok: false, reason: 'linked-file' };
        if (maxBytes > 0 && st.size > maxBytes) return { ok: false, reason: 'too-large' };
        const text = readFileSync(file, 'utf8');
        return { ok: true, path: file, text, doc: JSON.parse(text) };
    } catch {
        return { ok: false, reason: 'missing' };
    }
}

/** file 的真实路径是否仍在 runs 根里（Windows 大小写不敏感）。 */
function insideRunsDir(dir, file) {
    const rp = (p) => (realpathSync.native ? realpathSync.native(p) : realpathSync(p));
    const rootReal = rp(dir);
    const fileReal = rp(file);
    const a = process.platform === 'win32' ? rootReal.toLowerCase() : rootReal;
    const b = process.platform === 'win32' ? fileReal.toLowerCase() : fileReal;
    const rel = path.relative(a, b);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 渲染历史清单（CLI `runs` 与 doctor_runs 共用）。 */
export function renderRuns(runs, dir, identity = null) {
    const lines = [];
    lines.push('# 体检历史');
    lines.push('');
    lines.push(`- 目录：\`${identity ? identity(dir) : dir}\``);
    lines.push(`- 条数：${runs.length}`);
    lines.push('');
    if (runs.length === 0) {
        lines.push('_（还没有记录。跑一次 `dsh-doctor check`，或让 Agent 调 `doctor_check`。）_');
        return lines.join('\n');
    }
    for (const r of runs) {
        const when = r.generatedAt || new Date(r.mtime).toISOString();
        const s = r.summary || {};
        const tag = { fault: '故障', warn: '注意', unknown: '无法取证', ok: '全绿' }[r.verdict] || '?';
        const parts = [`fault=${s.fault ?? '?'}`, `warn=${s.warn ?? '?'}`, `unknown=${s.unknown ?? '?'}`];
        lines.push(`- \`${r.name}\` —— ${when} · ${tag}（${parts.join(' ')}）`);
    }
    return lines.join('\n');
}
