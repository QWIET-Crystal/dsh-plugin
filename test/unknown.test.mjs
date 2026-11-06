/**
 * dsh-doctor / test/unknown.test.mjs —— 0.2.0 的核心修正：「取不到证」不是「故障」，也不是「正常」
 *
 * 真机背景（2026-11-06 复现）：受限令牌下 `netstat`/子进程一律拒绝访问，
 * 0.1.x 的解析结果变成空集合，于是每个端口都被判成"无监听 —— 故障"，
 * 而当时 `:3080` 与 `:43120` 都活得好好的。这个测试就是钉住那条边界。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { classifyPortResult, probePort } from '../lib/detect.js';
import { IDS, exitCodeOf, finding, summarize, verdictOf } from '../lib/findings.js';
import { buildCheckPayload, collectFindings, renderPayload } from '../lib/report.js';

function fakeDiscovery(over = {}) {
    return {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        platform: process.platform,
        node: process.version,
        host: 'test-host',
        environment: { platform: process.platform, node: process.version, host: 'test-host', dshHome: 'C:/tmp/.dsh' },
        homes: [
            {
                dir: 'C:/tmp/.dsh',
                profileCount: 1,
                error: null,
                profiles: [{ name: 'desktop', bundles: ['dsh-doctor'], deps: [], hasPatch: true, declaredPorts: [3080] }],
            },
        ],
        // 故意不放假引擎：让 ABI 静态检查不参与本文件的断言（它有自己的测试文件）
        engines: [],
        declaredPorts: [3080],
        probedPorts: [{ port: 3080, state: 'open', open: true, ms: 1, errno: null }],
        running: [{ port: 3080, state: 'open' }],
        warnings: [],
        capabilities: { homesDenied: [], profilesTruncated: [], portUnknown: [] },
        ...over,
    };
}

const emptyLogScan = { hits: [], scanned: [], warnings: [], capability: { ok: true, reason: null } };

test('classifyPortResult：只有 ECONNREFUSED 才算"确定没人听"', () => {
    assert.equal(classifyPortResult(null), 'closed');
    assert.equal(classifyPortResult('ECONNREFUSED'), 'closed');
    assert.equal(classifyPortResult({ code: 'ECONNREFUSED' }), 'closed');
    for (const code of ['ETIMEDOUT', 'EPERM', 'EACCES', 'EMFILE', 'ENETUNREACH', 'EUNKNOWN']) {
        assert.equal(classifyPortResult({ code }), 'unknown', `${code} 必须判 unknown 而不是 closed`);
    }
});

test('probePort：活着的服务判 open，没人听的端口判 closed', async () => {
    const server = net.createServer((s) => s.end());
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    const live = server.address().port;
    const open = await probePort(live, 1200);
    assert.equal(open.state, 'open');
    assert.equal(open.open, true);
    await new Promise((res) => server.close(res));

    const dead = await probePort(live, 600); // 刚关掉，必然是 ECONNREFUSED
    assert.equal(dead.state, 'closed');
    assert.equal(dead.open, false);
});

test('端口探测失败 → unknown（不是 fault，也不是 ok）', () => {
    const d = fakeDiscovery({
        probedPorts: [
            { port: 3080, state: 'open', open: true, ms: 1, errno: null },
            { port: 43120, state: 'unknown', open: false, ms: 1200, errno: 'ETIMEDOUT' },
        ],
        running: [{ port: 3080, state: 'open' }],
        capabilities: { homesDenied: [], profilesTruncated: [], portUnknown: [{ port: 43120, errno: 'ETIMEDOUT' }] },
    });
    const findings = collectFindings(d, emptyLogScan);
    const unknown = findings.filter((f) => f.id === IDS.PORT_PROBE_UNKNOWN);
    assert.equal(unknown.length, 1);
    assert.equal(unknown[0].level, 'unknown');
    assert.equal(findings.filter((f) => f.level === 'fault').length, 0, '探测失败不能变成故障');

    const summary = summarize(findings);
    const verdict = verdictOf(summary);
    assert.equal(verdict, 'unknown');
    assert.equal(exitCodeOf(verdict), 3);
});

test('判定优先级：fault > unknown > warn', () => {
    const fault = summarize([finding(IDS.LOG_ABI_INCOMPATIBLE, 'fault', '插件', 'x')]);
    const unknown = summarize([finding(IDS.PORT_PROBE_UNKNOWN, 'unknown', '运行', 'x')]);
    const warn = summarize([finding(IDS.PORT_DECLARED_NOT_LISTENING, 'warn', '运行', 'x')]);
    assert.equal(verdictOf(fault), 'fault');
    assert.equal(verdictOf(unknown), 'unknown');
    assert.equal(verdictOf(warn), 'warn');
    assert.equal(verdictOf(summarize([])), 'ok');

    const mixed = summarize([
        finding(IDS.LOG_ABI_INCOMPATIBLE, 'fault', '插件', 'x'),
        finding(IDS.PORT_PROBE_UNKNOWN, 'unknown', '运行', 'x'),
    ]);
    assert.equal(verdictOf(mixed), 'fault', '有确定故障时先说故障');
    assert.equal(exitCodeOf('fault'), 2);
    assert.equal(exitCodeOf('unknown'), 3);
    assert.equal(exitCodeOf('warn'), 1);
    assert.equal(exitCodeOf('ok'), 0);
});

test('capabilities：读不动的 home / 被截断的 profile 都变成 unknown', () => {
    const d = fakeDiscovery({
        homes: [{ dir: 'C:/tmp/.dsh', profiles: [], profileCount: null, error: 'EACCES' }],
        declaredPorts: [],
        probedPorts: [],
        running: [],
        capabilities: {
            homesDenied: [{ dir: 'C:/tmp/.dsh', error: 'EACCES' }],
            profilesTruncated: [{ dir: 'C:/tmp/.dsh', total: 40, scanned: 32 }],
            portUnknown: [],
        },
    });
    const findings = collectFindings(d, emptyLogScan);
    const ids = findings.map((f) => f.id);
    assert.ok(ids.includes(IDS.DISCOVERY_HOME_DENIED));
    assert.ok(ids.includes(IDS.PROFILE_LIMIT_REACHED));
    assert.equal(findings.filter((f) => f.level === 'fault').length, 0);
    assert.equal(verdictOf(summarize(findings)), 'unknown');
});

test('日志读不动 → unknown 并且报告里有「无法取证」段', () => {
    const d = fakeDiscovery({
        capabilities: { homesDenied: [], profilesTruncated: [], portUnknown: [{ port: 43120, errno: 'EPERM' }] },
        probedPorts: [{ port: 3080, state: 'open', open: true, ms: 1, errno: null }],
    });
    const logScan = { hits: [], scanned: [], warnings: ['读不动'], capability: { ok: false, reason: 'EACCES' } };
    const findings = collectFindings(d, logScan);
    assert.ok(findings.some((f) => f.id === IDS.LOG_SCAN_DENIED && f.level === 'unknown'));

    const payload = buildCheckPayload(d, findings, logScan);
    assert.equal(payload.verdict, 'unknown');
    assert.equal(payload.exitCode, 3);
    const md = renderPayload(payload);
    assert.ok(md.includes('无法取证'), '报告必须显式说明这一轮没取到哪些证');
    assert.ok(md.includes('43120'));
});

test('buildCheckPayload：契约字段稳定，findings 带 id 与五级 level', () => {
    const d = fakeDiscovery();
    const findings = collectFindings(d, emptyLogScan);
    const payload = buildCheckPayload(d, findings, emptyLogScan);
    assert.equal(typeof payload.schemaVersion, 'number');
    assert.equal(typeof payload.generatedAt, 'string');
    assert.equal(typeof payload.summary.total, 'number');
    assert.ok(['fault', 'unknown', 'warn', 'ok'].includes(payload.verdict));
    assert.ok([0, 1, 2, 3].includes(payload.exitCode));
    for (const f of payload.findings) {
        assert.ok(f.id.includes('.'));
        assert.ok(['fault', 'warn', 'unknown', 'info', 'ok'].includes(f.level));
    }
});
