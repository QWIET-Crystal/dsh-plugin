/**
 * dsh-doctor / test/repair.test.mjs —— "刚修好"的识别与贡献提醒（0.4.0）
 *
 * 动机：案例库最有价值的时刻是用户刚把坑填平的那一刻。
 * 但提醒不能多嘴：**只在 ok 与非 ok 之间跨越时触发**，半修不修不算。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runCheck } from '../lib/check.js';
import { IDS } from '../lib/findings.js';
import { buildCaseTemplate, detectRepair, renderRepairHint } from '../lib/repair.js';
import { saveRun, readLatestRun } from '../lib/runs.js';

const prevRun = (verdict, findings = []) => ({
    schemaVersion: 1,
    generatedAt: '2026-11-06T00:00:00.000Z',
    verdict,
    findings,
    summary: { fault: 0, warn: verdict === 'warn' ? findings.length : 0, unknown: 0, info: 0, ok: 0, total: findings.length },
});

test('detectRepair：只在"非全绿 → 全绿"时触发', () => {
    const fixed = [{ id: 'PORT.HOST.NOT_LISTENING', level: 'info', area: '运行', text: '桌面端没在运行' }];
    const warnRun = prevRun('warn', [{ id: 'ABI.BUNDLE.MISSING', level: 'warn', area: 'ABI', text: '缺包' }]);

    assert.equal(detectRepair(warnRun, { verdict: 'ok', generatedAt: 'now' }).detected, true);
    assert.equal(detectRepair(prevRun('ok'), { verdict: 'ok' }).detected, false, '一直全绿不该提醒');
    assert.equal(detectRepair(warnRun, { verdict: 'warn' }).detected, false, '还是黄的，不算修好');
    assert.equal(detectRepair(null, { verdict: 'ok' }).detected, false, '没有上一轮不算');
    assert.equal(detectRepair(prevRun('fault', fixed), { verdict: 'unknown' }).detected, false, '变成 unknown 不算修好');

    const r = detectRepair(warnRun, { verdict: 'ok', generatedAt: '2026-11-06T01:00:00.000Z' });
    assert.equal(r.previousVerdict, 'warn');
    assert.equal(r.fixedCount, 1);
    assert.ok(r.fixedIds.includes('ABI.BUNDLE.MISSING'));
});

test('buildCaseTemplate：骨架填好类型与上一轮症状', () => {
    const repair = { detected: true, currentAt: '2026-11-06T01:00:00.000Z', fixedCount: 2, fixedTitles: ['运行：桌面端没在运行'] };
    const { id, markdown } = buildCaseTemplate(repair);
    assert.ok(id.startsWith('local-20261106'));
    for (const section of ['## 类型', '## 症状', '## 判定签名', '## 根因', '## 处置命令', '## 验证']) {
        assert.ok(markdown.includes(section), `模板缺 ${section}`);
    }
    assert.ok(markdown.includes('runtime'), '默认类型是 runtime');
    assert.ok(markdown.includes('桌面端没在运行'), '症状应带上一轮的结论');
});

test('renderRepairHint：给出人话与下一步', () => {
    const hint = renderRepairHint({ detected: true, fixedCount: 2 });
    assert.ok(hint.includes('2 项'));
    assert.ok(hint.includes('doctor_case_add'));
    assert.equal(renderRepairHint({ detected: false }), null);
});

// ---- 集成：真的跑一轮，把"上一轮 warn、这一轮 ok"复现出来 ----

function healthyDiscovery(profileDir) {
    return {
        generatedAt: new Date().toISOString(),
        platform: process.platform,
        node: process.version,
        host: 'h',
        environment: {},
        homes: [
            {
                dir: profileDir,
                profileCount: 1,
                error: null,
                profiles: [{ name: 'p', dir: path.join(profileDir, 'profiles', 'p'), bundles: ['ok-plugin'], deps: ['x'], hasPatch: true, hasNodeModules: true, declaredPorts: [] }],
            },
        ],
        // 不放引擎：ABI 静态检查需要内核版本，没有内核就整层跳过 → 这轮只剩 info
        engines: [],
        declaredPorts: [],
        probedPorts: [],
        running: [],
        warnings: [],
        capabilities: { homesDenied: [], profilesTruncated: [], portUnknown: [] },
    };
}

test('runCheck：上一轮 warn + 这一轮 ok → 附带 repair 与模板，并给出一条 info', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-repair-'));
    try {
        const runsDir = path.join(root, 'runs');
        const profileDir = path.join(root, 'profile');
        mkdirSync(path.join(profileDir, 'profiles', 'p', 'node_modules', 'ok-plugin'), { recursive: true });
        writeFileSync(path.join(profileDir, 'profiles', 'p', 'node_modules', 'ok-plugin', 'package.json'), JSON.stringify({ name: 'ok-plugin', version: '1.0.0' }), 'utf8');
        // 上一轮：一条 warn
        saveRun(runsDir, prevRun('warn', [{ id: 'ABI.BUNDLE.MISSING', level: 'warn', area: 'ABI', text: '缺包' }]), { retention: 30, throttleMs: 0 });

        const payload = await runCheck({ discovery: healthyDiscovery(profileDir), deep: false, saveRuns: true, runsDir, retention: 30, throttleMs: 0, sessionScan: false });
        assert.equal(payload.verdict, 'ok', '这一轮应该是全绿');
        assert.equal(payload.repair.detected, true);
        assert.equal(payload.repair.previousVerdict, 'warn');
        assert.ok(payload.repair.template && payload.repair.template.includes('## 症状'), 'payload 里要带模板供客户端复制');
        assert.ok(payload.findings.some((f) => f.id === IDS.CASE_CONTRIBUTE_SUGGESTED && f.level === 'info'));

        // 关键：repair 必须**落盘**——客户端是从 runs/ 读最近一次来弹提醒的
        const saved = readLatestRun(runsDir);
        assert.ok(saved, '应该写出了新的 run');
        assert.equal(saved.repair && saved.repair.detected, true, '落盘的 run 里必须带 repair');
        assert.ok(saved.repair.template && saved.repair.template.includes('## 症状'), '落盘模板要能直接复制');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('runCheck：没有历史时不触发提醒', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-repair2-'));
    try {
        const runsDir = path.join(root, 'runs');
        const profileDir = path.join(root, 'profile');
        mkdirSync(path.join(profileDir, 'profiles', 'p', 'node_modules', 'ok-plugin'), { recursive: true });
        writeFileSync(path.join(profileDir, 'profiles', 'p', 'node_modules', 'ok-plugin', 'package.json'), JSON.stringify({ name: 'ok-plugin', version: '1.0.0' }), 'utf8');
        const payload = await runCheck({ discovery: healthyDiscovery(profileDir), deep: false, saveRuns: true, runsDir, retention: 30, throttleMs: 0, sessionScan: false });
        assert.equal(payload.repair.detected, false);
        assert.equal(payload.findings.some((f) => f.id === IDS.CASE_CONTRIBUTE_SUGGESTED), false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
