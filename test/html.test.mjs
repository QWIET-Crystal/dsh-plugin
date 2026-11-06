/**
 * dsh-doctor / test/html.test.mjs —— 自包含 HTML 报告的契约测试
 *
 * 这份报告是给"不会敲命令的人"看的：必须有且只有一句「现在该做什么」，
 * 且所有动态内容都要转义（日志是外来文本，不能让它在报告里变成标签）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { escapeHtml, headline, renderHtml } from '../lib/html.js';
import { buildCheckPayload } from '../lib/report.js';

function payload(findings) {
    const discovery = {
        generatedAt: '2026-11-06T08:00:00.000Z',
        platform: 'win32',
        node: 'v24.0.0',
        host: '<host>',
        environment: { platform: 'win32', node: 'v24.0.0', host: '<host>', dshHome: '<home>/.dsh' },
        homes: [],
        engines: [],
        declaredPorts: [],
        probedPorts: [],
        running: [],
        warnings: [],
        capabilities: { homesDenied: [], profilesTruncated: [], portUnknown: [] },
    };
    return buildCheckPayload(discovery, findings, { scanned: [], warnings: [], hits: [] });
}

const mk = (level, text, extra = {}) => ({ id: 'T.X', level, area: '运行', text, evidence: [], fix: [], caseId: null, runbook: null, ...extra });

test('escapeHtml：标签与引号都被中和', () => {
    assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
    assert.equal(escapeHtml('a"b\'c&d'), 'a&quot;b&#39;c&amp;d');
});

test('headline：故障优先于注意，且只给一个动作', () => {
    const p = payload([
        mk('warn', '注意项', { fix: ['echo warn'] }),
        mk('fault', '真故障', { fix: ['dsh plugin --profile desktop add x@latest'] }),
    ]);
    const h = headline(p);
    assert.equal(h.tone, 'fault');
    assert.equal(h.action, 'dsh plugin --profile desktop add x@latest');
});

test('headline：unknown 会明确说"正常不能当真"', () => {
    const h = headline(payload([mk('unknown', '端口探测没结果')]));
    assert.equal(h.tone, 'unknown');
    assert.ok(h.body.includes('不能当真'));
});

test('headline：全绿时给一句人话', () => {
    const h = headline(payload([mk('info', '端口在听')]));
    assert.equal(h.tone, 'ok');
    assert.ok(h.title.includes('一切正常'));
});

test('renderHtml：三段式齐全（顶部动作 / 问题列表 / 折叠 JSON）', () => {
    const html = renderHtml(payload([mk('warn', '端口没在听', { fix: ['dsh web --port 3080'], caseId: '2026-09-24-frontend-dead' })]));
    assert.ok(html.startsWith('<!doctype html>'), '必须是完整 HTML');
    assert.ok(html.includes('下一步'), '顶部必须给一个动作');
    assert.ok(html.includes('dsh web --port 3080'));
    assert.ok(html.includes('2026-09-24-frontend-dead'), '要能指到案例');
    assert.ok(html.includes('<details>'), '技术细节必须折叠在下面');
    assert.ok(html.includes('技术细节'), '折叠区要有中文标签');
    // 单文件零依赖：不许引用外部资源
    assert.equal(/<link\b/i.test(html), false, '不能引用外部样式');
    assert.equal(/<script[^>]+src=/i.test(html), false, '不能引用外部脚本');
});

test('renderHtml：外来文本被转义，不能变成标签', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const html = renderHtml(payload([mk('fault', evil, { fix: [`echo "${evil}"`] })]));
    assert.equal(html.includes(evil), false, '原始标签不能出现');
    assert.ok(html.includes('&lt;img'), '必须转义后展示');
});

test('renderHtml：kit 模式下补上探测链与版本', () => {
    const html = renderHtml(payload([mk('ok', '正常')]), { kit: { version: '1.0.0', pluginVersion: '0.3.0', chain: '第 2 级：npm 全局 node' } });
    assert.ok(html.includes('第 2 级：npm 全局 node'));
    assert.ok(html.includes('0.3.0'));
});
