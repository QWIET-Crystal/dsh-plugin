/**
 * dsh-doctor / test/case-draft.test.mjs —— 从结论起草病例（0.5.1）
 *
 * 目标只有一个：**用户不用从空白模板开始**。
 * 症状、判定签名、处置命令三节必须自动填；根因/处置/验证留给人。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { draftCaseFromFinding } from '../lib/case-draft.js';

const finding = {
    id: 'SESSION.REPETITION.COLLAPSE',
    level: 'warn',
    area: '会话',
    text: '会话 abcd1234 第 3 轮有一条 300,000 字符的消息，同一短语重复 15,000 次（占 99.9%）',
    caseId: '2026-11-06-reasoning-repetition-collapse',
    fix: ['dsh-doctor check', 'dsh-doctor runs'],
};

test('draftCaseFromFinding：三节自动填好，根因留空给人', () => {
    const d = draftCaseFromFinding(finding, { generatedAt: '2026-11-07T03:00:00.000Z' });
    assert.equal(d.id, 'local-20261107-session-repetition-collapse');
    assert.equal(d.filename, d.id + '.md');
    assert.ok(d.markdown.includes('## 症状'));
    assert.ok(d.markdown.includes('同一短语重复 15,000 次'), '症状要带结论原文');
    assert.ok(d.markdown.includes('## 判定签名'));
    assert.ok(d.markdown.includes('`SESSION.REPETITION.COLLAPSE`'), '判定签名要带 id');
    assert.ok(d.markdown.includes('## 处置命令'));
    assert.ok(d.markdown.includes('dsh-doctor check'), '处置命令来自 fix[]');
    assert.ok(d.markdown.includes('## 根因'));
    assert.ok(d.markdown.includes('（为什么会这样'), '根因必须是待填占位，不能自动编造');
    assert.ok(d.markdown.includes('## 验证'));
});

test('draftCaseFromFinding：类型缺省 runtime（体检类结论都是运行时问题）', () => {
    const d = draftCaseFromFinding(finding, {});
    assert.ok(d.markdown.includes('## 类型\n\nruntime'));
});

test('draftCaseFromFinding：没有 fix[] 时不留空的「处置命令」章节', () => {
    const d = draftCaseFromFinding({ id: 'X.Y', level: 'info', area: 'A', text: 't' }, {});
    assert.equal(d.markdown.includes('## 处置命令'), false, '空章节会让 lint 报"有章节没命令"');
});

test('draftCaseFromFinding：id 只含安全字符（会变成文件名）', () => {
    const d = draftCaseFromFinding({ id: 'PORT.ALL_HOSTS.DOWN', level: 'warn', area: '运行', text: 'x' }, {});
    assert.match(d.id, /^local-\d{8}-[a-z0-9-]+$/);
    assert.equal(/[\\/:*?"<>|]/.test(d.filename), false);
});

test('draftCaseFromFinding：没有 id 直接报错（不允许生成无法检索的草稿）', () => {
    assert.throws(() => draftCaseFromFinding({ text: 'x' }), /带 id/);
});
