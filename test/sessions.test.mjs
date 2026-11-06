/**
 * dsh-doctor / test/sessions.test.mjs —— 会话层取证（0.5.0）
 *
 * 三条必须钉住的事实：
 *   1) 会话文件是**多帧 zstd**，整段 `zstdDecompressSync` 只解第一帧 → 必须自己走帧；
 *   2) 尾部窗口解析出来的是"最近几轮"，不能因为窗口从中间切就崩；
 *   3) 报告里**只有统计数字**，会话原文一个字都不能出去。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { findEmptyTurns, findRepetitionCollapse, listSessionFiles, parseEvents, readTailFrames, resolveSessionsDir, scanSessions } from '../lib/sessions.js';
import { collectFindings } from '../lib/report.js';
import { IDS } from '../lib/findings.js';

const LINE = (obj) => JSON.stringify(obj);

/** 把事件按每 frames 行压成一帧，模拟真实的"多帧拼接"会话文件。 */
function writeSession(dir, project, id, events, perFrame = 2) {
    const pdir = path.join(dir, project, id);
    mkdirSync(pdir, { recursive: true });
    const frames = [];
    for (let i = 0; i < events.length; i += perFrame) {
        const chunk = events.slice(i, i + perFrame).map(LINE).join('\n') + '\n';
        frames.push(zlib.zstdCompressSync(Buffer.from(chunk, 'utf8')));
    }
    const file = path.join(pdir, 'session.v4.jsonl.zstd');
    writeFileSync(file, Buffer.concat(frames));
    return file;
}

const reasoningOnly = (turn) => ({ type: 'assistant/message', seq: turn * 10, data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: '想一下怎么做' }] } } });
const normalAnswer = (turn) => ({ type: 'assistant/message', seq: turn * 10, data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '回答用户' }] } } });
const collapseMsg = (turn) => ({ type: 'assistant/message', seq: turn * 10, data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: '做。'.repeat(15000) }] } } });

test('resolveSessionsDir：跟随 DSH_HOME', () => {
    assert.equal(resolveSessionsDir({ DSH_HOME: 'D:/x/.dsh' }), path.join('D:/x/.dsh', 'sessions'));
});

test('readTailFrames：多帧文件必须逐帧解（整段解只出第一帧）', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-sess-'));
    try {
        const events = [normalAnswer(1), normalAnswer(2), normalAnswer(3), normalAnswer(4)];
        const file = writeSession(root, 'p', 's1', events, 1);
        const whole = zlib.zstdDecompressSync(readFileSync(file));
        assert.ok(whole.length < 600, '整段解只能拿到第一帧（这正是真机上踩到的坑）');
        const r = readTailFrames(file, 1024 * 1024);
        assert.equal(r.ok, true);
        assert.ok(r.frames >= 4, `应该解到所有帧，实际 ${r.frames}`);
        assert.ok(r.text.includes('"turn":4'), '窗口内的事件都要拿到');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('readTailFrames：窗口从中间切也不崩（跳过半帧）', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-sess2-'));
    try {
        const events = Array.from({ length: 40 }, (_, i) => normalAnswer(i + 1));
        const file = writeSession(root, 'p', 's2', events, 1);
        for (const tail of [64, 128, 256]) {
            const r = readTailFrames(file, tail);
            // 可能整帧都不在窗口内，但绝不能抛；要么成功要么给明确原因
            if (r.ok) assert.ok(r.frames >= 1);
            else assert.ok(['no-zstd-frames', 'decode-failed'].includes(r.reason), `意外原因：${r.reason}`);
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('findEmptyTurns：只有推理、无正文无工具调用才算空回合', () => {
    const events = [
        { type: 'step/start', data: { turn: 1 } },
        reasoningOnly(1),
        { type: 'step/end', data: { turn: 1 } },
        normalAnswer(2),
        { type: 'tool/call', data: { turn: 3 } },
        reasoningOnly(3),
    ];
    const empties = findEmptyTurns(events);
    assert.deepEqual(empties.map((e) => e.turn), [1], '第 3 轮有 tool/call，不算空回合');
});

test('findRepetitionCollapse：长消息里同一短语高频高占比才算', () => {
    const collapsed = findRepetitionCollapse([collapseMsg(3)]);
    assert.equal(collapsed.length, 1);
    assert.equal(collapsed[0].turn, 3);
    assert.ok(collapsed[0].count >= 1000);
    assert.ok(collapsed[0].ratio >= 90);
    assert.equal('text' in collapsed[0], false, '不能带原文');

    // 短消息里重复几次不算
    const shortMsg = { type: 'assistant/message', data: { turn: 4, message: { role: 'assistant', content: [{ type: 'reasoning', text: '好。'.repeat(50) }] } } };
    assert.equal(findRepetitionCollapse([shortMsg]).length, 0);
});

test('scanSessions + collectFindings：命中两条 warn，且报告文本里没有会话原文', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-sess3-'));
    try {
        writeSession(root, 'proj', 'session-aaaa1111', [reasoningOnly(1), normalAnswer(2), collapseMsg(3)], 1);
        const scan = scanSessions({ dir: root, env: {}, deep: false });
        assert.equal(scan.scanned.length, 1);
        assert.ok(scan.emptyTurns.some((e) => e.turn === 1), '第 1 轮是空回合');
        assert.equal(scan.collapses.length, 1);
        assert.equal(scan.collapses[0].turn, 3);

        const discovery = {
            generatedAt: new Date().toISOString(),
            platform: 'win32',
            node: process.version,
            host: 'h',
            environment: {},
            homes: [],
            engines: [],
            declaredPorts: [],
            probedPorts: [],
            running: [],
            warnings: [],
            capabilities: { homesDenied: [], profilesTruncated: [], portUnknown: [] },
        };
        const findings = collectFindings(discovery, { hits: [], scanned: [], warnings: [], capability: { ok: true } }, scan);
        const ids = findings.map((f) => f.id);
        assert.ok(ids.includes(IDS.SESSION_EMPTY_TURN));
        assert.ok(ids.includes(IDS.SESSION_REPETITION_COLLAPSE));
        for (const f of findings.filter((x) => x.id.startsWith('SESSION.'))) {
            assert.equal(f.level, 'warn');
            assert.equal(f.caseId, '2026-11-06-reasoning-repetition-collapse');
            assert.equal(f.text.includes('做。'), false, '报告里不能出现会话原文');
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('listSessionFiles：按时间倒序，sinceMs 过滤生效；读不到目录给 error', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-sess4-'));
    try {
        writeSession(root, 'p', 'old', [normalAnswer(1)], 1);
        writeSession(root, 'p', 'new', [normalAnswer(2)], 1);
        const all = listSessionFiles(root);
        assert.equal(all.files.length, 2);
        const filtered = listSessionFiles(root, { sinceMs: Date.now() + 60_000 });
        assert.equal(filtered.files.length, 0);
        assert.deepEqual(listSessionFiles(path.join(root, 'nope')), { files: [], error: 'ENOENT' });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('parseEvents：半行数据（窗口切在行中间）被跳过而不是抛', () => {
    const events = parseEvents('{"type":"a"}\n{"type":"b"\n{"type":"c"}');
    assert.deepEqual(events.map((e) => e.type), ['a', 'c']);
});
