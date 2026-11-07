/**
 * dsh-doctor / lib/sessions.js —— 会话层取证（0.5.0）
 *
 * 存在的理由：有一类故障**端口在听、HTTP 正常、日志无错**，只是模型在退化——
 * 比如"思考通道退化成同一短语重复上万次 → 空回合且 completed"。
 * 只看服务的体检永远发现不了它，必须读会话事件。
 *
 * 三个硬约束：
 *
 * 1) **会话文件是多帧 zstd**。`zstdDecompressSync` 整段喂进去**只解第一帧**
 *    （实测：3.2MB / 2,481 帧的文件只吐出 187 字节的 session 头）。
 *    所以这里自带帧游走器：扫 magic `28 B5 2F FD` 切段、逐帧解。
 *
 * 2) **只读尾部**。实测尾部 1MB → 903 帧 → 2.9MB 文本 → 36ms，足够看"最近几轮"。
 *    游走器天然适配：跳过第一段（可能是半帧），只解窗口内的完整帧。
 *
 * 3) **不把会话正文带出去**。会话是用户对话，一旦落进 runs/ 就是长期留存。
 *    这里只产出**统计数字**（第几轮、重复多少次、占比多少），原文一律丢弃。
 */

import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const SESSION_FILE = 'session.v4.jsonl.zstd';

/** 默认窗口：最近一个会话、尾部 1MB；deep 模式放宽到 24h / 2MB。 */
export const SESSION_LIMITS = Object.freeze({
    tailBytes: 1024 * 1024,
    deepTailBytes: 2 * 1024 * 1024,
    deepWindowMs: 24 * 60 * 60 * 1000,
    maxDecompressed: 32 * 1024 * 1024,
    // 单帧解压上限：zstd 单帧理论膨胀可达数万倍（实测 64MB 全零 → 2KB，32,467×）。
    // 不设上限就是"先分配、后检查"——1MB 的尾部足以把内存打穿。
    maxFrameBytes: 8 * 1024 * 1024,
    maxFiles: 200,
});

export function resolveSessionsDir(env = process.env, dshHome) {
    const home = dshHome || env.DSH_HOME || path.join(env.USERPROFILE || os.homedir(), '.dsh');
    return path.join(home, 'sessions');
}

/**
 * 列出会话文件（按修改时间倒序）。
 * @returns {{files:{file,id,project,mtimeMs,bytes}[], error:string|null}}
 */
export function listSessionFiles(dir, { sinceMs = 0, limit = SESSION_LIMITS.maxFiles } = {}) {
    const files = [];
    let projects = [];
    try {
        projects = readdirSync(dir);
    } catch (e) {
        return { files, error: (e && e.code) || 'unreadable' };
    }
    for (const project of projects) {
        const pdir = path.join(dir, project);
        let sessions = [];
        try {
            sessions = readdirSync(pdir);
        } catch {
            continue;
        }
        for (const id of sessions) {
            const file = path.join(pdir, id, SESSION_FILE);
            try {
                const st = statSync(file);
                if (!st.isFile()) continue;
                if (sinceMs && st.mtimeMs < sinceMs) continue;
                files.push({ file, id, project, mtimeMs: st.mtimeMs, bytes: st.size });
            } catch {
                /* 不是会话目录 */
            }
        }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return { files: files.slice(0, limit), error: null };
}

/**
 * 读文件尾部并按帧解压。
 *
 * @param {string} file
 * @param {number} maxBytes 尾部窗口（压缩后字节）
 * @returns {{ok:boolean, text?:string, frames?:number, badFrames?:number, bytes?:number, decompressed?:number, reason?:string}}
 */
export function readTailFrames(file, maxBytes = SESSION_LIMITS.tailBytes) {
    let size = 0;
    try {
        size = statSync(file).size;
    } catch {
        return { ok: false, reason: 'missing' };
    }
    if (size === 0) return { ok: false, reason: 'empty' };
    const len = Math.min(maxBytes, size);
    const buf = Buffer.alloc(len);
    let fd = -1;
    try {
        fd = openSync(file, 'r');
        readSync(fd, buf, 0, len, size - len);
    } catch (e) {
        return { ok: false, reason: (e && e.code) || 'read-failed' };
    } finally {
        if (fd >= 0) {
            try {
                closeSync(fd);
            } catch {
                /* ignore */
            }
        }
    }

    const starts = [];
    let idx = 0;
    while (true) {
        const k = buf.indexOf(ZSTD_MAGIC, idx);
        if (k < 0) break;
        starts.push(k);
        idx = k + 4;
    }
    if (starts.length === 0) return { ok: false, reason: 'no-zstd-frames' };

    let text = '';
    let frames = 0;
    let badFrames = 0;
    let decompressed = 0;
    for (let n = 0; n < starts.length; n++) {
        // 窗口是从文件中间切的：第一段可能是半帧，解出来是垃圾或直接抛错，跳过
        if (n === 0 && starts[0] > 0) continue;
        const s = starts[n];
        const e = n + 1 < starts.length ? starts[n + 1] : buf.length;
        try {
            // 单帧上限在**分配之前**生效：没有它，一帧就能把内存打穿（zstd 实测可膨胀 3 万倍）
            const out = zlib.zstdDecompressSync(buf.subarray(s, e), { maxOutputLength: SESSION_LIMITS.maxFrameBytes });
            decompressed += out.length;
            if (decompressed > SESSION_LIMITS.maxDecompressed) return { ok: false, reason: 'too-large' };
            text += out.toString('utf8');
            frames++;
        } catch (err) {
            // 帧膨胀超限 = 这个文件不可信，整份放弃（记 unknown），不要边解边猜
            if (err && err.code === 'ERR_BUFFER_TOO_LARGE') return { ok: false, reason: 'frame-too-large' };
            badFrames++;
        }
    }
    if (frames === 0) return { ok: false, reason: 'decode-failed' };
    return { ok: true, text, frames, badFrames, bytes: len, decompressed };
}

/** JSONL → 事件数组（坏行跳过，不抛）。 */
export function parseEvents(text) {
    const out = [];
    for (const line of String(text || '').split('\n')) {
        if (!line) continue;
        try {
            out.push(JSON.parse(line));
        } catch {
            /* 半行数据（窗口切在行中间）属正常 */
        }
    }
    return out;
}

function contentOf(event) {
    const msg = event && event.data && event.data.message;
    return msg && Array.isArray(msg.content) ? msg.content : [];
}

/**
 * 空回合判定：一轮里**有推理、但既无正文也无工具调用**。
 *
 * 只在整个 turn 上判：同一轮的不同 step 之间"先推理、后调用"是正常节奏，
 * 按 step 判会大量误报。
 */
export function findEmptyTurns(events) {
    const turns = new Map(); // turn → {reasoning, text, toolCalls, messages}
    const bump = (turn, key) => {
        const t = turns.get(turn) || { reasoning: 0, text: 0, toolCalls: 0, messages: 0 };
        t[key] += 1;
        turns.set(turn, t);
    };
    for (const e of events) {
        const turn = e && e.data && typeof e.data.turn === 'number' ? e.data.turn : null;
        if (turn == null) continue;
        if (e.type === 'tool/call') {
            bump(turn, 'toolCalls');
            continue;
        }
        if (e.type !== 'assistant/message') continue;
        bump(turn, 'messages');
        for (const block of contentOf(e)) {
            if (block && block.type === 'reasoning') bump(turn, 'reasoning');
            else if (block && block.type === 'text') bump(turn, 'text');
            else if (block && (block.type === 'tool_use' || block.type === 'tool-call')) bump(turn, 'toolCalls');
        }
    }
    const empty = [];
    for (const [turn, t] of turns) {
        if (t.reasoning > 0 && t.text === 0 && t.toolCalls === 0 && t.messages > 0) empty.push({ turn, messages: t.messages });
    }
    empty.sort((a, b) => a.turn - b.turn);
    return empty;
}

/**
 * 重复坍缩判定：同一条消息里同一个短单元反复出现。
 *
 * 只在 ≥20k 字符的块上算（正常长回答不会被判成坍缩），并对中间 20k 字符抽样：
 * 对 1–8 字符的单元按步长 L 取不重叠片段计数，取最高频者。
 * 命中条件：出现 ≥100 次 **且** 覆盖率 ≥50%（既看绝对量也看占比，
 * 避免"短消息里重复 200 次很正常"的误报）。
 */
export function findRepetitionCollapse(events, { minChars = 20000, minCount = 100, minRatio = 0.5 } = {}) {
    const hits = [];
    for (const e of events) {
        if (e.type !== 'assistant/message') continue;
        const turn = e && e.data && typeof e.data.turn === 'number' ? e.data.turn : null;
        for (const block of contentOf(e)) {
            const s = block && typeof block.text === 'string' ? block.text : '';
            if (s.length < minChars) continue;
            const mid = Math.floor(s.length / 2);
            const sample = s.slice(Math.max(0, mid - 10000), Math.min(s.length, mid + 10000));
            // 按"覆盖长度"选最优单元：否则 1 字符单元（如「做」）会以 50% 覆盖率
            // 赢过 2 字符单元（如「做。」）的 100% 覆盖率
            let best = { count: 0, unit: '', covered: 0 };
            for (let L = 1; L <= 8; L++) {
                const counts = new Map();
                for (let i = 0; i + L <= sample.length; i += L) {
                    const u = sample.slice(i, i + L);
                    counts.set(u, (counts.get(u) || 0) + 1);
                }
                for (const [u, c] of counts) {
                    const cov = c * L;
                    if (cov > best.covered) best = { count: c, unit: u, covered: cov };
                }
            }
            const covered = best.covered;
            const ratio = sample.length ? covered / sample.length : 0;
            if (best.count >= minCount && ratio >= minRatio) {
                hits.push({
                    turn,
                    blockType: block.type || 'text',
                    count: best.count,
                    ratio: Math.round(ratio * 1000) / 10,
                    chars: s.length,
                    // 刻意不带原文
                });
            }
        }
    }
    hits.sort((a, b) => b.count - a.count);
    return hits;
}

/**
 * 扫会话：默认只看最近 1 个会话的尾部；deep 模式看 24 小时内全部（各自尾部 2MB）。
 *
 * @returns {{scanned:object[], emptyTurns:object[], collapses:object[], skipped:number, errors:string[], deep:boolean}}
 */
export function scanSessions(options = {}) {
    const env = options.env || process.env;
    const deep = Boolean(options.deep);
    const limits = { ...SESSION_LIMITS, ...(options.limits || {}) };
    const dir = options.dir || resolveSessionsDir(env, options.dshHome);
    const sinceMs = deep ? Date.now() - limits.deepWindowMs : 0;
    const listed = listSessionFiles(dir, { sinceMs, limit: deep ? limits.maxFiles : 1 });
    const out = { scanned: [], emptyTurns: [], collapses: [], skipped: 0, droppedFrames: 0, errors: [], deep };

    if (listed.error) {
        out.errors.push(`会话目录读不动（${listed.error}）`);
        return out;
    }
    const tail = deep ? limits.deepTailBytes : limits.tailBytes;
    for (const item of listed.files) {
        const r = readTailFrames(item.file, tail);
        if (r.ok && r.badFrames) out.droppedFrames += r.badFrames;
        if (!r.ok) {
            out.skipped++;
            out.errors.push(`${item.id}：${r.reason}`);
            continue;
        }
        const events = parseEvents(r.text);
        const empties = findEmptyTurns(events);
        const collapses = findRepetitionCollapse(events);
        for (const t of empties) out.emptyTurns.push({ sessionId: item.id, project: item.project, turn: t.turn, messages: t.messages });
        for (const c of collapses) out.collapses.push({ sessionId: item.id, project: item.project, ...c });
        out.scanned.push({ sessionId: item.id, project: item.project, events: events.length, frames: r.frames, badFrames: r.badFrames, bytes: item.bytes, tail: r.bytes, decompressed: r.decompressed });
    }
    return out;
}
