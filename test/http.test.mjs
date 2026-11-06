/**
 * dsh-doctor / test/http.test.mjs —— 设置页数据源（宿主路由）的离线契约测试
 *
 * 不开真服务器：直接构造假 req/res 喂给 handler。
 * 重点钉住三件事：
 *   - 只允许 GET/POST，其余 405；
 *   - GET 不触发新的取证（只读历史）；
 *   - 宿主没有 webServer 时 registerReportRoute 返回 null（页面据此降级，而不是崩）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { REPORT_ROUTE, createReportHandler, registerReportRoute } from '../lib/http.js';
import { saveRun } from '../lib/runs.js';

function fakeRes() {
    const res = {
        code: null,
        headers: null,
        body: '',
        writeHead(code, headers) {
            res.code = code;
            res.headers = headers || {};
        },
        end(body) {
            res.body = body || '';
        },
    };
    return res;
}

function payload(generatedAt = new Date().toISOString()) {
    return {
        schemaVersion: 1,
        generatedAt,
        findings: [{ id: 'A.B', level: 'warn', area: 'x', text: 't', evidence: [], fix: [], caseId: null }],
        summary: { fault: 0, warn: 1, unknown: 0, info: 0, ok: 0, total: 1 },
        verdict: 'warn',
        exitCode: 1,
    };
}

test('GET：没有历史时返回空列表而不是 500', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-http-'));
    try {
        const handler = createReportHandler({ runsDir: dir, checkOptions: { saveRuns: false } });
        const res = fakeRes();
        await handler({ method: 'GET', url: '/dsh-doctor/api/report' }, res);
        assert.equal(res.code, 200);
        const body = JSON.parse(res.body);
        assert.equal(body.ok, true);
        assert.deepEqual(body.runs, []);
        assert.equal(body.latest, null);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('GET：读最近一次历史（不触发新的体检）', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-http2-'));
    try {
        saveRun(dir, payload('2026-11-06T01:00:00.000Z'), { retention: 30, throttleMs: 0 });
        const handler = createReportHandler({ runsDir: dir, checkOptions: { saveRuns: false } });
        const res = fakeRes();
        await handler({ method: 'GET', url: '/dsh-doctor/api/report' }, res);
        const body = JSON.parse(res.body);
        assert.equal(body.runs.length, 1);
        assert.equal(body.latest.verdict, 'warn');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('GET ?run=<file>：读单条；不存在 → 404', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-http3-'));
    try {
        const r = saveRun(dir, payload('2026-11-06T02:00:00.000Z'), { retention: 30, throttleMs: 0 });
        const name = path.basename(r.path);
        const handler = createReportHandler({ runsDir: dir });

        const ok = fakeRes();
        await handler({ method: 'GET', url: `/dsh-doctor/api/report?run=${name}` }, ok);
        assert.equal(ok.code, 200);
        assert.equal(JSON.parse(ok.body).run.verdict, 'warn');

        const missing = fakeRes();
        await handler({ method: 'GET', url: '/dsh-doctor/api/report?run=nope.json' }, missing);
        assert.equal(missing.code, 404);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('其它方法 → 405', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-http4-'));
    try {
        const handler = createReportHandler({ runsDir: dir });
        const res = fakeRes();
        await handler({ method: 'DELETE', url: '/dsh-doctor/api/report' }, res);
        assert.equal(res.code, 405);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('registerReportRoute：宿主没有 webServer 时返回 null（页面降级，而不是崩）', () => {
    const bare = { effect: (fn) => fn() };
    assert.equal(registerReportRoute(bare, {}), null);

    const throwing = {
        get webServer() {
            throw new Error('cannot get property "webServer" without inject');
        },
        effect: (fn) => fn(),
    };
    assert.equal(registerReportRoute(throwing, {}), null);

    const ok = {
        webServer: {
            register(spec) {
                assert.equal(spec.kind, 'prefix');
                assert.equal(spec.path, REPORT_ROUTE);
                assert.equal(typeof spec.handler, 'function');
                return { dispose() {} };
            },
        },
        effect(fn) {
            return fn();
        },
    };
    const disposed = registerReportRoute(ok, {});
    assert.ok(disposed, '正常宿主必须完成注册');
});
