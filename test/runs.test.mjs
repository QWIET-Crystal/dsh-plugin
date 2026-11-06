/**
 * dsh-doctor / test/runs.test.mjs —— 体检历史（第二个写点）
 *
 * 要钉住三件事：
 *   1) 同内容在节流窗口内只落一个文件（面板刷新/agent 连调不会刷出一堆）；
 *   2) 保留条数是硬上限（超出删最旧的）；
 *   3) 读的时候不许用带路径分隔符的名字（历史目录也是文件系统面）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { listRuns, pruneRuns, readRun, renderRuns, resolveRunsDir, saveRun } from '../lib/runs.js';

function tmpDir() {
    return mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-runs-'));
}

function payload(n = 0, generatedAt = new Date().toISOString()) {
    return {
        schemaVersion: 1,
        generatedAt,
        findings: [{ id: 'X.Y', level: n % 2 ? 'warn' : 'ok', area: 'a', text: 't' + n }],
        summary: { fault: 0, warn: n % 2 ? 1 : 0, unknown: 0, info: 0, ok: n % 2 ? 0 : 1, total: 1 },
        verdict: n % 2 ? 'warn' : 'ok',
        exitCode: n % 2 ? 1 : 0,
    };
}

test('saveRun 落盘，listRuns 能读回来', () => {
    const dir = tmpDir();
    try {
        const r = saveRun(dir, payload(0), { retention: 30, throttleMs: 0 });
        assert.equal(r.ok, true);
        assert.equal(r.skipped, false);
        assert.ok(existsSync(r.path));
        const runs = listRuns(dir);
        assert.equal(runs.length, 1);
        assert.equal(runs[0].verdict, 'ok');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('同内容在节流窗口内只写一次（进程内 + 跨进程两条路都拦）', () => {
    const dir = tmpDir();
    try {
        const p = payload(1, '2026-11-06T00:00:00.000Z');
        const a = saveRun(dir, p, { retention: 30, throttleMs: 60_000 });
        const b = saveRun(dir, p, { retention: 30, throttleMs: 60_000 });
        assert.equal(a.ok, true);
        assert.equal(b.skipped, true, '第二次必须被判重复');
        assert.equal(readdirSync(dir).filter((n) => n.endsWith('.json')).length, 1);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('节流关掉时同内容也是覆盖同名文件，而不是无限增长', () => {
    const dir = tmpDir();
    try {
        const p = payload(0, '2026-11-06T00:00:00.000Z');
        saveRun(dir, p, { retention: 30, throttleMs: 0 });
        saveRun(dir, p, { retention: 30, throttleMs: 0 });
        // 文件名由 generatedAt + 内容 hash 决定，天然幂等
        assert.equal(readdirSync(dir).filter((n) => n.endsWith('.json')).length, 1);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('保留条数是硬上限：写 5 条只留 3 条', () => {
    const dir = tmpDir();
    try {
        for (let i = 0; i < 5; i++) {
            saveRun(dir, payload(i, new Date(Date.UTC(2026, 10, 6, 0, 0, i)).toISOString()), { retention: 3, throttleMs: 0 });
        }
        const files = readdirSync(dir).filter((n) => n.endsWith('.json'));
        assert.equal(files.length, 3);
        assert.equal(listRuns(dir, 100).length, 3);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('hashSource：结论相同、只是时间不同，也算重复（面板刷新的场景）', () => {
    const dir = tmpDir();
    try {
        const hashSource = { findings: [{ id: 'A.B', level: 'ok' }], summary: { fault: 0, warn: 0, unknown: 0, info: 0, ok: 1, total: 1 }, verdict: 'ok' };
        const a = saveRun(dir, payload(0, '2026-11-06T00:00:00.000Z'), { retention: 30, throttleMs: 60_000, hashSource });
        assert.equal(a.skipped, false);
        // 时间变了、端口耗时也变了，但结论没变 → 不该再落一份
        const b = saveRun(dir, payload(0, '2026-11-06T00:05:00.000Z'), { retention: 30, throttleMs: 60_000, hashSource });
        assert.equal(b.skipped, true, '同结论必须被判重复');
        assert.equal(readdirSync(dir).filter((n) => n.endsWith('.json')).length, 1);
        // 结论变了 → 必须落新的一份
        const c = saveRun(dir, payload(1, '2026-11-06T00:06:00.000Z'), { retention: 30, throttleMs: 60_000, hashSource: { ...hashSource, verdict: 'warn' } });
        assert.equal(c.skipped, false);
        assert.equal(readdirSync(dir).filter((n) => n.endsWith('.json')).length, 2);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('readRun：拒绝带分隔符或 .. 的名字', () => {
    const dir = tmpDir();
    try {
        const r = saveRun(dir, payload(0), { retention: 30, throttleMs: 0 });
        const name = path.basename(r.path);
        assert.equal(readRun(dir, name).ok, true);
        for (const evil of ['../secret.json', '..\\secret.json', 'a/b.json', '', '..']) {
            assert.equal(readRun(dir, evil).ok, false, `${evil} 必须被拒`);
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('renderRuns：空目录给引导语，有条目时按判定标注', () => {
    const dir = tmpDir();
    try {
        assert.ok(renderRuns(listRuns(dir), dir).includes('还没有记录'));
        saveRun(dir, payload(0, '2026-11-06T00:00:00.000Z'), { retention: 30, throttleMs: 0 });
        const md = renderRuns(listRuns(dir), dir);
        assert.ok(md.includes('体检历史'));
        assert.ok(md.includes('全绿'));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('pruneRuns 直调：保留 <= 上限', () => {
    const dir = tmpDir();
    try {
        for (let i = 0; i < 4; i++) saveRun(dir, payload(i, new Date(Date.UTC(2026, 10, 6, 1, 0, i)).toISOString()), { retention: 10, throttleMs: 0 });
        const removed = pruneRuns(dir, 2);
        assert.equal(removed.length, 2);
        assert.equal(readdirSync(dir).filter((n) => n.endsWith('.json')).length, 2);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('resolveRunsDir：跟随 DSH_HOME，也接受显式目录', () => {
    assert.equal(resolveRunsDir({ DSH_HOME: 'D:/x/.dsh' }), path.resolve('D:/x/.dsh/dsh-doctor/runs'));
    assert.equal(resolveRunsDir({ DSH_HOME: 'D:/x/.dsh' }, 'E:/hist'), path.resolve('E:/hist'));
});
