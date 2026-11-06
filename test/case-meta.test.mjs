/**
 * dsh-doctor / test/case-meta.test.mjs —— 案例库的元数据与生命周期（0.4.0）
 *
 * 三件事必须有测试钉着，否则会悄悄退化：
 *   - `## 类型` 缺省 runtime、写错值要被 lint 当成错；
 *   - `> promoted:` 标记能打上、幂等、且不许被随便覆盖；
 *   - 索引能同时体现「类型」和「已合入共享库」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { extractKind, extractPromoted, isCaseFile, listCases, markPromoted, renderCaseIndex, resolveCaseSources, saveLocalCase, caseSummary, caseTitle } from '../lib/cases.js';

test('caseTitle / caseSummary：摘要必须真的解析出来（真机整列空过一版）', () => {
    const text = '# 标题在这里\n\n## 症状\nx\n\n## 根因\n\n**A**：真正的原因写在这里。\n\n## 验证\ny\n';
    assert.equal(caseTitle(text), '标题在这里');
    const s = caseSummary(text);
    assert.ok(s.includes('真正的原因'), `摘要必须取到根因第一行，实际=${s}`);
    assert.notEqual(s, '—');
    // 没有根因时退回处置
    assert.ok(caseSummary('# t\n\n## 处置\n\n换个做法\n').includes('换个做法'));
    assert.equal(caseSummary('# t\n\n没有这些章节\n'), '—');
});

function tmp() {
    const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-meta-'));
    const shared = path.join(root, 'shared');
    const local = path.join(root, 'local');
    mkdirSync(shared, { recursive: true });
    mkdirSync(local, { recursive: true });
    return { root, shared, local, sources: resolveCaseSources({ sharedCasesDir: shared, localCasesDir: local }, process.env, root) };
}

test('extractKind：缺省 runtime，显式 authoring 能认，写错返回 null', () => {
    assert.equal(extractKind('# t\n\n## 症状\n'), 'runtime');
    assert.equal(extractKind('# t\n\n## 类型\n\nauthoring\n\n## 症状\n'), 'authoring');
    assert.equal(extractKind('# t\n\n**类型**：runtime\n'), 'runtime');
    assert.equal(extractKind('# t\n\n## 类型\n\n安全类\n'), null, '非法值必须能被 lint 抓出来');
});

test('extractPromoted：只认行首的 > promoted:', () => {
    assert.equal(extractPromoted('# t\n\n> 来源：x\n'), null);
    assert.equal(extractPromoted('# t\n\n> promoted: 2026-10-21-plugin-waits-removed-service\n'), '2026-10-21-plugin-waits-removed-service');
    assert.equal(extractPromoted('正文里提到 > promoted: nope\n'), null);
});

test('isCaseFile：INDEX 与下划线模板都不算案例', () => {
    assert.equal(isCaseFile('2026-01-01-x.md'), true);
    assert.equal(isCaseFile('INDEX.md'), false);
    assert.equal(isCaseFile('_TEMPLATE.md'), false);
    assert.equal(isCaseFile('readme.txt'), false);
});

test('saveLocalCase：authoring 会写一行类型，runtime 不写', () => {
    const { sources, local } = tmp();
    try {
        const a = saveLocalCase(sources, { id: 'local-authoring', title: 'A', body: '## 症状\nx\n', kind: 'authoring' });
        assert.equal(a.ok, true, a.reason);
        assert.ok(readFileSync(path.join(local, 'local-authoring.md'), 'utf8').includes('## 类型'));
        const r = saveLocalCase(sources, { id: 'local-runtime', title: 'B', body: '## 症状\ny\n' });
        assert.equal(r.ok, true);
        assert.equal(readFileSync(path.join(local, 'local-runtime.md'), 'utf8').includes('## 类型'), false);
        const bad = saveLocalCase(sources, { id: 'local-bad', title: 'C', body: 'x', kind: 'security' });
        assert.equal(bad.reason, 'bad-kind');
    } finally {
        rmSync(sources.local, { recursive: true, force: true });
        rmSync(path.dirname(sources.local), { recursive: true, force: true });
    }
});

test('markPromoted：插在来源行之后、幂等、拒绝坏 id', () => {
    const { sources, local } = tmp();
    try {
        writeFileSync(path.join(local, 'local-x.md'), '# X\n\n> 来源：本地病例库\n\n## 症状\n坏了\n', 'utf8');
        const r1 = markPromoted(sources, 'local-x', '2026-10-21-plugin-waits-removed-service');
        assert.equal(r1.ok, true, r1.reason);
        const text = readFileSync(path.join(local, 'local-x.md'), 'utf8');
        assert.ok(text.includes('> promoted: 2026-10-21-plugin-waits-removed-service'));
        // 必须在来源行之后、症状之前
        assert.ok(text.indexOf('promoted:') > text.indexOf('来源：'));
        assert.ok(text.indexOf('promoted:') < text.indexOf('## 症状'));

        const r2 = markPromoted(sources, 'local-x', '2026-10-21-plugin-waits-removed-service');
        assert.equal(r2.already, true, '重复打同一个标记要幂等');

        const r3 = markPromoted(sources, 'local-x', 'other-id');
        assert.equal(r3.ok, false);
        assert.equal(r3.reason, 'already-promoted');

        assert.equal(markPromoted(sources, '../etc/passwd', 'x').reason, 'bad-local-id');
        assert.equal(markPromoted(sources, 'local-x', '../x').reason, 'bad-shared-id');
        assert.equal(markPromoted(sources, 'not-exist', 'x').reason, 'not-found');
    } finally {
        rmSync(path.dirname(sources.local), { recursive: true, force: true });
    }
});

test('索引：authoring 标类型，promoted 标已合入', () => {
    const { sources, root, shared, local } = tmp();
    try {
        writeFileSync(path.join(shared, '2026-01-01-shared.md'), '# 共享例\n\n## 症状\nx\n', 'utf8');
        writeFileSync(path.join(local, 'local-a.md'), '# 本地例\n\n> promoted: 2026-01-01-shared\n\n## 症状\ny\n', 'utf8');
        writeFileSync(path.join(local, 'local-b.md'), '# 作者坑\n\n## 类型\n\nauthoring\n\n## 症状\nz\n', 'utf8');
        writeFileSync(path.join(local, '_TEMPLATE.md'), '# 模板\n', 'utf8');
        const listing = listCases(sources);
        assert.deepEqual(listing.merged.map((c) => c.id).sort(), ['2026-01-01-shared', 'local-a', 'local-b'], '模板不能进索引');
        const byId = Object.fromEntries(listing.merged.map((c) => [c.id, c]));
        assert.equal(byId['local-b'].kind, 'authoring');
        assert.equal(byId['local-a'].promoted, '2026-01-01-shared');
        assert.equal(byId['2026-01-01-shared'].kind, 'runtime');
        const md = renderCaseIndex(listing);
        assert.ok(md.includes('`[authoring]`'));
        assert.ok(md.includes('已合入共享库'));
        assert.equal(md.includes('_TEMPLATE'), false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
