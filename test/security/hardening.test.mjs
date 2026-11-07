/**
 * dsh-doctor / test/security/hardening.test.mjs —— 0.5.1 安全加固的回归钉子
 *
 * 每个用例对应 SECURITY.md 里的一条断言。改坏了会在这里响。
 * 威胁模型边界：**只防跨应用/远程**（网页 CSRF、恶意日志内容、恶意会话文件），
 * 同机同用户的篡改不在范围内（见 SECURITY.md「非目标」）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { createReportHandler } from '../../lib/http.js';
import { buildRepairPlan } from '../../lib/repairs.js';
import { parseEvents, scanSessions, readTailFrames, SESSION_LIMITS } from '../../lib/sessions.js';
import { readRun } from '../../lib/runs.js';

function sessionDirWithBomb() {
    const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-sec-bomb-'));
    const dir = path.join(root, 'p', 'session-bomb');
    mkdirSync(dir, { recursive: true });
    // 64MB 全零压成约 2KB（实测 32,467×）——不设单帧上限就是"先分配、后检查"
    const bomb = zlib.zstdCompressSync(Buffer.alloc(64 * 1024 * 1024, 0), { level: 19 });
    const ok = zlib.zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session', data: {} }) + '\n'));
    writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([ok, bomb]));
    return root;
}

test('解压炸弹：单帧超限整份放弃（记 unknown），不把内存打穿', () => {
    const root = sessionDirWithBomb();
    try {
        const before = process.memoryUsage().rss;
        const scan = scanSessions({ dir: root, env: {}, deep: false });
        const grewMB = (process.memoryUsage().rss - before) / 1024 / 1024;
        assert.equal(scan.scanned.length, 0);
        assert.ok(scan.errors.some((e) => e.includes('frame-too-large')), `错误应指明 frame-too-large：${scan.errors}`);
        assert.ok(grewMB < 200, `内存不应暴涨，实际 +${Math.round(grewMB)}MB`);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('解压炸弹：上限是"分配前"的（maxOutputLength），不是解完再判断', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-sec-bomb2-'));
    try {
        const dir = path.join(root, 'p', 's');
        mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'session.v4.jsonl.zstd');
        // 单帧解压后略超上限：必须被拦，而不是解出来再比较长度
        const payload = Buffer.alloc(SESSION_LIMITS.maxFrameBytes + 1024, 0x61);
        writeFileSync(file, zlib.zstdCompressSync(payload, { level: 19 }));
        const r = readTailFrames(file, SESSION_LIMITS.tailBytes);
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'frame-too-large');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('CSRF：裸 POST 403，带 x-dsh-doctor 头放行', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-sec-csrf-'));
    try {
        const handler = createReportHandler({ runsDir: root, checkOptions: { saveRuns: false, deep: false } });
        const call = (headers) =>
            new Promise((resolve) => {
                const res = { code: 0, writeHead(c) { this.code = c; }, end() { resolve(this.code); } };
                handler({ method: 'POST', url: '/dsh-doctor/api/report', headers }, res);
            });
        assert.equal(await call({}), 403, '跨源可发的裸 POST 必须被拒');
        assert.equal(await call({ 'x-dsh-doctor': '1' }), 200, '同源页面带头应放行');
        // 头名大小写不敏感；这里只看"没有被 403 拦"，因为紧接着的第二次 POST 会撞 2 秒节流（429）
        assert.notEqual(await call({ 'X-DSH-Doctor': '1' }), 403, '头名大小写不敏感');
        assert.equal(await call({ 'x-dsh-doctor': '0' }), 403, '值不对也要拒');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('日志注入：插件名不会被当成正则去匹配别的条目', () => {
    const patch = ['- insert:', '    - id: good-plugin', '      name: good-plugin'].join('\n');
    const probe = (name) =>
        buildRepairPlan(
            { findings: [{ id: 'LOG.ABI.INCOMPATIBLE', level: 'fault', area: '插件', text: 'x', meta: { plugin: name } }] },
            { patchFiles: [{ profile: 'p', path: 'C:/x/cordis.patch.yml', text: patch }] },
        );
    for (const evil of ['.*', 'good-plugin|.*', '(', 'good-plugin\\n- id: evil']) {
        assert.equal(probe(evil).actions.length, 0, `不应为 ${evil} 产生动作`);
    }
    assert.equal(probe('good-plugin').actions.length, 1, '真点名且条目存在时必须产动作');
});

test('日志注入：没有点名就不产动作（不做"最近改过"的猜测）', () => {
    const plan = buildRepairPlan({ findings: [{ id: 'LOG.PLUGINS_LOAD_FAILED', level: 'fault', area: '插件', text: '整树加载失败' }] }, {});
    assert.equal(plan.actions.length, 0);
});

test('深度嵌套 JSON：解析失败被跳过，不抛', () => {
    const deep = '['.repeat(20000) + ']'.repeat(20000);
    const text = `{"type":"assistant/message","data":{"turn":1,"message":{"content":[{"type":"text","text":${JSON.stringify(deep)}}]}}}\n{"type":"session"}`;
    const events = parseEvents(text);
    assert.ok(events.length >= 1, '至少要把合法那一行解出来');
});

test('路径穿越：历史文件名带分隔符一律拒绝', () => {
    assert.equal(readRun(os.tmpdir(), '..\\..\\windows\\win.ini').ok, false);
    assert.equal(readRun(os.tmpdir(), '../../etc/passwd').ok, false);
});
