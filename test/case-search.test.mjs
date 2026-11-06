/**
 * dsh-doctor / test/case-search.test.mjs —— 案例全文检索（0.4.0）
 *
 * 语义刻意保守：多词 **AND**、大小写不敏感、不做相似度排序。
 * 这里钉住的是"搜得准"和"看得出哪条对"（必须带命中片段）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { renderCaseSearch, resolveCaseSources, searchCases } from '../lib/cases.js';

function setup(files) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-search-'));
    const shared = path.join(root, 'shared');
    const local = path.join(root, 'local');
    mkdirSync(shared, { recursive: true });
    mkdirSync(local, { recursive: true });
    for (const [where, name, body] of files) {
        writeFileSync(path.join(where === 'shared' ? shared : local, name), body, 'utf8');
    }
    const sources = resolveCaseSources({ sharedCasesDir: shared, localCasesDir: local }, process.env, root);
    return { root, sources };
}

test('多关键词是 AND；大小写不敏感', () => {
    const { root, sources } = setup([
        ['shared', '2026-01-01-a.md', '# 甲\n\n## 症状\nGPU 子进程崩溃，界面回退软件渲染\n'],
        ['shared', '2026-01-02-b.md', '# 乙\n\n## 症状\nGPU 驱动版本过旧\n'],
    ]);
    try {
        assert.equal(searchCases(sources, 'gpu 崩溃').hits.length, 1, '两个词都出现才算命中');
        assert.equal(searchCases(sources, '崩溃').hits.length, 1);
        assert.equal(searchCases(sources, '驱动').hits.length, 1);
        assert.equal(searchCases(sources, 'gpu 量子纠缠').hits.length, 0);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('命中片段取包含关键词的那一行', () => {
    const { root, sources } = setup([
        ['shared', '2026-01-01-a.md', '# 甲\n\n## 症状\n第一行无关\n第二行有 webRuntime 这个东西\n'],
    ]);
    try {
        const [hit] = searchCases(sources, 'webruntime').hits;
        assert.ok(hit.snippet.includes('webRuntime'), '片段必须来自命中行');
        assert.equal(hit.snippet.includes('第一行无关'), false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('本地优先：同名 id 只算本地那份，且带 promoted 标记', () => {
    const { root, sources } = setup([
        ['shared', 'dup.md', '# 共享版\n\n## 症状\n同一件事\n'],
        ['local', 'dup.md', '# 本地版\n\n> promoted: shared-id\n\n## 症状\n同一件事\n'],
    ]);
    try {
        const hits = searchCases(sources, '同一件事').hits;
        assert.equal(hits.length, 1);
        assert.equal(hits[0].source, 'local');
        assert.equal(hits[0].promoted, 'shared-id');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('模板与 INDEX 不参与检索；空查询返回空', () => {
    const { root, sources } = setup([
        ['shared', '_TEMPLATE.md', '# 模板\n\n## 症状\n占位\n'],
        ['shared', '2026-01-01-a.md', '# 甲\n\n## 症状\n占位\n'],
    ]);
    try {
        const hits = searchCases(sources, '占位').hits;
        assert.deepEqual(hits.map((h) => h.id), ['2026-01-01-a']);
        assert.equal(searchCases(sources, '   ').hits.length, 0);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('limit 生效，且不会因为量大而失控', () => {
    const files = [];
    for (let i = 0; i < 8; i++) files.push(['shared', `2026-01-0${i}-x.md`, `# X${i}\n\n## 症状\n共同关键词\n`]);
    const { root, sources } = setup(files);
    try {
        assert.equal(searchCases(sources, '共同关键词', { limit: 3 }).hits.length, 3);
        assert.equal(searchCases(sources, '共同关键词', { limit: 999 }).hits.length, 8);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('renderCaseSearch：带类型标注与空结果提示', () => {
    const { root, sources } = setup([
        ['shared', '2026-01-01-a.md', '# 甲\n\n## 类型\n\nauthoring\n\n## 症状\n插件不激活\n'],
    ]);
    try {
        const md = renderCaseSearch(searchCases(sources, '不激活'));
        assert.ok(md.includes('`[authoring]`'));
        assert.ok(md.includes('2026-01-01-a'));
        const none = renderCaseSearch(searchCases(sources, '根本没有这个词'));
        assert.ok(none.includes('没有命中'));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
