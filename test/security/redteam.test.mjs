/**
 * dsh-doctor / test/security/redteam.test.mjs —— 红队实测问题的回归钉子（0.5.2）
 *
 * 每条对应一次真实跑通的攻击。攻击一旦被修好，就必须有东西盯着它别回来。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

import { runCheck } from '../../lib/check.js';
import { scanDesktopLogs } from '../../lib/report.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function withLog(lines, fn) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-rt-log-'));
    try {
        const dir = path.join(root, 'DSH Desktop', 'logs');
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, 'dsh-2026-01-01.log'), lines.join('\n') + '\n', 'utf8');
        return fn(root);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

test('ReDoS：1.2MB 单行日志不能把主线程按死（红队实测 94 秒 → 现在 < 2 秒）', () => {
    withLog(['EBUSY '.repeat(200000)], (root) => {
        const t0 = Date.now();
        const r = scanDesktopLogs({ APPDATA: root }, { maxLogBytes: 2 * 1024 * 1024 });
        const ms = Date.now() - t0;
        assert.ok(ms < 2000, `扫描耗时 ${ms}ms，正则又退化成 O(n²) 了`);
        assert.equal(r.hits.length, 0);
    });
});

test('日志注入：裸短语不能"擦掉"之前的故障（只认结构化启动事件）', () => {
    const fault = '{"source":"host","message":"1 entry did not activate: waiting for service: gone"}';
    withLog([fault], (root) => {
        assert.equal(scanDesktopLogs({ APPDATA: root }, { maxLogBytes: 2 * 1024 * 1024 }).hits.length, 1);
    });
    withLog([fault, '{"source":"host","message":"host outbound proxy policy installed"}'], (root) => {
        const r = scanDesktopLogs({ APPDATA: root }, { maxLogBytes: 2 * 1024 * 1024 });
        assert.equal(r.hits.length, 1, '插件 console.log 一行就能掩盖真故障');
        assert.equal(r.scope, 'all');
    });
    withLog([fault, '{"source":"renderer.boot","event":"shell-load.start"}'], (root) => {
        const r = scanDesktopLogs({ APPDATA: root }, { maxLogBytes: 2 * 1024 * 1024 });
        assert.equal(r.hits.length, 0, '真重启后旧故障不再重复报警');
        assert.equal(r.scope, 'since-last-start');
    });
});

test('返回值脱敏：check --json / HTTP 里不能再出现令牌', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-rt-tok-'));
    try {
        const dir = path.join(root, 'DSH Desktop', 'logs');
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, 'dsh-2026-01-01.log'), 'waiting for service: svc ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ glpat-abcdefghijklmnop xoxb-123456789012-abc\n', 'utf8');
        const payload = await runCheck({
            env: { ...process.env, APPDATA: root, DSH_HOME: path.join(root, '.dsh') },
            deep: true,
            saveRuns: false,
            sessionScan: false,
        });
        const text = JSON.stringify(payload);
        for (const token of ['ghp_ABCDEF', 'glpat-abcdefghij', 'xoxb-123456789012']) {
            assert.equal(text.includes(token), false, `返回值里还有 ${token}`);
        }
        assert.ok(text.includes('<redacted-token>'), '应该留下脱敏占位符');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('结论数量上限：3 万行日志不能放大成几十 MB 报告', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-rt-amp-'));
    try {
        const dir = path.join(root, 'DSH Desktop', 'logs');
        mkdirSync(dir, { recursive: true });
        const lines = [];
        for (let i = 0; i < 5000; i++) lines.push(`{"message":"waiting for service: svc${i}"}`);
        writeFileSync(path.join(dir, 'dsh-2026-01-01.log'), lines.join('\n') + '\n', 'utf8');
        const payload = await runCheck({
            env: { ...process.env, APPDATA: root, DSH_HOME: path.join(root, '.dsh') },
            deep: true,
            saveRuns: false,
            sessionScan: false,
        });
        assert.ok(payload.findings.length <= 201, `结论数 ${payload.findings.length}，上限没生效`);
        assert.ok(payload.findings.some((f) => f.id === 'REPORT.FINDINGS.TRUNCATED'), '应有"结论过多"的提示');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('--html 不覆盖非本工具生成的文件（第三条写路径）', async () => {
    const { canOverwriteHtmlReport } = await import('../../lib/html.js');
    const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-rt-html-'));
    try {
        const victim = path.join(root, 'victim.yml');
        writeFileSync(victim, 'important: config\n', 'utf8');
        assert.equal(canOverwriteHtmlReport(victim).ok, false, '非本工具生成的报告必须拒绝覆盖');
        assert.equal(canOverwriteHtmlReport(victim, { force: true }).ok, true, '显式 --force 放行');
        const fresh = path.join(root, 'ok.html');
        assert.equal(canOverwriteHtmlReport(fresh).ok, true, '不存在的新文件直接写');
        writeFileSync(fresh, '<!doctype html><html></html>', 'utf8');
        assert.equal(canOverwriteHtmlReport(fresh).ok, true, '覆盖自己的报告放行');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('本地病例的命令带"未审核"标注（同名覆盖不再是隐形的）', async () => {
    const { commandsForCase } = await import('../../lib/cases.js');
    const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-rt-case-'));
    try {
        const shared = path.join(root, 'shared');
        const local = path.join(root, 'local');
        mkdirSync(shared, { recursive: true });
        mkdirSync(local, { recursive: true });
        const body = ['# x', '', '## 处置命令', '', '```sh', 'echo owned', '```', ''].join('\n');
        writeFileSync(path.join(shared, 'case-a.md'), body, 'utf8');
        writeFileSync(path.join(local, 'case-a.md'), body, 'utf8');
        const cmds = commandsForCase({ shared, local, prefer: 'local' }, 'case-a');
        assert.ok(cmds[0].startsWith('# 本地病例草稿'), `本地命令必须带标注，实际：${cmds[0]}`);
        const sharedOnly = commandsForCase({ shared, local: path.join(root, 'nope'), prefer: 'local' }, 'case-a');
        assert.equal(sharedOnly[0], 'echo owned', '共享库的命令不带标注');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
