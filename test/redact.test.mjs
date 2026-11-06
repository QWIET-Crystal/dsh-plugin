/**
 * dsh-doctor / test/redact.test.mjs —— 落盘/上网前的脱敏（真机泄漏过的回归）
 *
 * 现场：第一版 `redactPayload` 是"挑字段脱敏"，漏了 `engines[].id`
 * （形如 `npm:C:\Users\<user>\AppData\Roaming\npm`），用户名直接落了盘。
 * 结论：整字段白名单迟早起漏，改成**无条件递归**，并用一条"全文不含身份"的断言守着。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCheckPayload, redactPayload, renderPayload } from '../lib/report.js';

const IDENTITY = {
    userName: 'someone',
    hostName: 'DESKTOP-ABC123',
    homeDir: 'C:\\Users\\someone',
    tempDir: 'C:\\Users\\someone\\AppData\\Local\\Temp',
};

function payload() {
    const discovery = {
        generatedAt: new Date().toISOString(),
        platform: 'win32',
        node: 'v24.0.0',
        host: 'DESKTOP-ABC123',
        environment: { platform: 'win32', node: 'v24.0.0', host: 'DESKTOP-ABC123', dshHome: 'C:\\Users\\someone\\.dsh' },
        homes: [
            {
                dir: 'C:\\Users\\someone\\.dsh',
                profileCount: 1,
                error: null,
                profiles: [{ name: 'desktop', dir: 'C:\\Users\\someone\\.dsh\\profiles\\desktop', bundles: [], deps: [], hasPatch: true, declaredPorts: [] }],
            },
        ],
        engines: [
            {
                kind: 'npm',
                // ← 泄漏就出在这个字段：它没被第一版白名单覆盖
                id: 'npm:C:\\Users\\someone\\AppData\\Roaming\\npm',
                label: 'npm 全局内核 0.2.1',
                version: '0.2.1',
                path: 'C:\\Users\\someone\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\package.json',
                dir: 'C:\\Users\\someone\\AppData\\Roaming\\npm',
            },
        ],
        declaredPorts: [],
        probedPorts: [],
        running: [],
        warnings: [],
        capabilities: { homesDenied: [], profilesTruncated: [], portUnknown: [] },
    };
    const findings = [
        {
            id: 'X.Y',
            level: 'warn',
            area: 'a',
            text: '读 C:\\Users\\someone\\.dsh\\profiles 失败',
            evidence: ['C:\\Users\\someone\\x.log: token ghp_abcdefghijklmnop'],
            fix: ['cd C:\\Users\\someone'],
            caseId: null,
            runbook: null,
            meta: { dir: 'C:\\Users\\someone\\.dsh' },
        },
    ];
    return buildCheckPayload(discovery, findings, { scanned: [], warnings: [], hits: [] });
}

test('redactPayload：整份 JSON 里不出现用户名 / 主机名 / 用户主目录', () => {
    const out = redactPayload(payload(), IDENTITY);
    const text = JSON.stringify(out);
    for (const needle of ['someone', 'DESKTOP-ABC123', 'C:\\Users\\someone']) {
        assert.equal(text.includes(needle), false, `不应出现 ${needle}`);
    }
    // 占位符确实生效（说明不是"什么都没做"）
    assert.ok(text.includes('<home>'), '主目录应被替换成 <home>');
    assert.ok(text.includes('<host>'), '主机名应被替换成 <host>');
});

test('redactPayload：结构不被破坏（渲染仍然可用）', () => {
    const out = redactPayload(payload(), IDENTITY);
    assert.equal(typeof out.schemaVersion, 'number');
    assert.ok(Array.isArray(out.findings));
    assert.ok(Array.isArray(out.discovery.engines));
    const md = renderPayload(out, IDENTITY);
    assert.ok(md.includes('DSH 体检报告'));
});

test('redactPayload：不改原对象（避免把内存里的真路径也抹掉）', () => {
    const src = payload();
    const before = JSON.stringify(src.discovery.engines[0]);
    redactPayload(src, IDENTITY);
    assert.equal(JSON.stringify(src.discovery.engines[0]), before);
});
