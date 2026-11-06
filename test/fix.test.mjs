/**
 * dsh-doctor / test/fix.test.mjs —— 结论 → 案例 → 可复制命令
 *
 * 约定：只从病例里的 `## 处置命令` 章节抽命令，**绝不从散文/表格里猜**。
 * 这条约定是有代价的（有些病例没命令），但猜错一条命令的代价更大。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { commandsForCase, extractCommands, resolveCaseSources } from '../lib/cases.js';
import { runCheck } from '../lib/check.js';

function writeCase(dir, id, body) {
    writeFileSync(path.join(dir, `${id}.md`), `# ${id}\n\n${body}\n`, 'utf8');
}

test('extractCommands：只认「处置命令」章节里的围栏块', () => {
    const text = [
        '# x',
        '',
        '## 症状',
        '',
        '跑 `node --test` 会卡住（这是散文里的反引号，不是命令）。',
        '',
        '## 处置与结果',
        '',
        '| 步骤 | 动作 |',
        '|---|---|',
        '| 1 | 掐掉 worker |',
        '',
        '## 处置命令',
        '',
        '```sh',
        '# 注释行会被丢掉',
        'node --test --test-concurrency=2',
        'node --test --test-timeout=60000',
        '```',
        '',
        '## 验证',
        '',
        '```sh',
        'echo 这不在处置命令章节里，不该被抓到',
        '```',
        '',
    ].join('\n');
    assert.deepEqual(extractCommands(text), ['node --test --test-concurrency=2', 'node --test --test-timeout=60000']);
});

test('extractCommands：没有该章节 → 空数组（不猜）', () => {
    const text = '## 处置\n\n重跑 `pnpm i` 即可。\n';
    assert.deepEqual(extractCommands(text), []);
});

test('commandsForCase：从案例库按 id 取命令；不存在返回空', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-fix-'));
    try {
        const shared = path.join(root, 'shared');
        mkdirSync(shared, { recursive: true });
        writeCase(shared, '2026-01-01-demo', '## 症状\n\n坏了\n\n## 处置命令\n\n```powershell\nRestart-Service Foo\n```\n');
        const sources = resolveCaseSources({ sharedCasesDir: shared, localCasesDir: path.join(root, 'local') }, process.env, root);
        assert.deepEqual(commandsForCase(sources, '2026-01-01-demo'), ['Restart-Service Foo']);
        assert.deepEqual(commandsForCase(sources, 'nope'), []);
        assert.deepEqual(commandsForCase(sources, '../etc/passwd'), []);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('runCheck：结论自动带上案例里的处置命令', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-fix2-'));
    try {
        const shared = path.join(root, 'shared');
        mkdirSync(shared, { recursive: true });
        writeCase(shared, '2026-09-24-frontend-dead', '## 症状\n\n端口没了\n\n## 处置命令\n\n```sh\ndsh web --port 3080\n```\n');
        const caseSources = resolveCaseSources({ sharedCasesDir: shared, localCasesDir: path.join(root, 'local') }, process.env, root);

        const discovery = {
            generatedAt: new Date().toISOString(),
            platform: process.platform,
            node: process.version,
            host: 'h',
            environment: {},
            homes: [
                {
                    dir: 'C:/tmp/.dsh',
                    profileCount: 1,
                    error: null,
                    profiles: [{ name: 'desktop', dir: 'C:/tmp/.dsh/profiles/desktop', bundles: [], deps: ['x'], hasPatch: true, declaredPorts: [3080] }],
                },
            ],
            engines: [],
            declaredPorts: [3080],
            probedPorts: [{ port: 3080, state: 'closed', open: false, ms: 1, errno: 'ECONNREFUSED' }],
            running: [],
            warnings: [],
            capabilities: { homesDenied: [], profilesTruncated: [], portUnknown: [] },
        };

        const payload = await runCheck({ discovery, deep: false, saveRuns: false, caseSources });
        const hit = payload.findings.find((f) => f.caseId === '2026-09-24-frontend-dead');
        assert.ok(hit, '端口没监听应当指向 #前端进程死亡 案例');
        assert.deepEqual(hit.fix, ['dsh web --port 3080'], 'fix 必须来自案例的「处置命令」章节');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
