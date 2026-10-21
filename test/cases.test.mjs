/**
 * dsh-doctor / test/cases.test.mjs —— 两个案例库（共享 + 本地）的解析与写守卫
 *
 * 覆盖：
 *   - 默认路径推导：共享库 = 包内 docs/cases；本地库 = <DSH_HOME>/dsh-doctor/cases
 *   - 合并索引：同名 id 本地覆盖共享，并在索引里标注
 *   - 读取优先级：casesPrefer 决定 local/shared 谁先命中
 *   - 写守卫：只写本地库、id 不带分隔符、落盘内容强制脱敏、默认不覆盖
 *   - allowLocalCaseWrite=false 时彻底只读
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { listCases, readCase, renderCaseIndex, resolveCaseSources, saveLocalCase } from '../lib/cases.js';

const IDENT = { userName: 'alice', hostName: 'BOX-42', homeDir: 'C:\\Users\\alice', tempDir: 'C:\\Temp' };

function fixture() {
    const root = mkdtempSync(path.join(tmpdir(), 'dsh-doctor-cases-'));
    const shared = path.join(root, 'pkg', 'docs', 'cases');
    const home = path.join(root, 'home');
    const local = path.join(home, 'dsh-doctor', 'cases');
    mkdirSync(shared, { recursive: true });
    mkdirSync(local, { recursive: true });
    writeFileSync(path.join(shared, 'a.md'), '# 共享案例 A\n\n症状……\n', 'utf8');
    writeFileSync(path.join(shared, 'b.md'), '# 共享版 B\n\n旧内容\n', 'utf8');
    writeFileSync(path.join(local, 'b.md'), '# 本地版 B\n\n本机修订\n', 'utf8');
    writeFileSync(path.join(local, 'c.md'), '# 本地案例 C\n\n只有本机有\n', 'utf8');
    return { root, shared, home, local, pkgRoot: path.join(root, 'pkg') };
}

test('resolveCaseSources：共享库在包内、本地库在 DSH_HOME 下', () => {
    const { root, home, pkgRoot, shared, local } = fixture();
    try {
        const s = resolveCaseSources({}, { DSH_HOME: home }, pkgRoot);
        assert.equal(s.shared, shared);
        assert.equal(s.local, local);
        assert.equal(s.prefer, 'local');
        assert.equal(s.writeLocal, true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('listCases：两库都列，同名 id 本地覆盖并标注', () => {
    const { root, pkgRoot, home } = fixture();
    try {
        const s = resolveCaseSources({}, { DSH_HOME: home }, pkgRoot);
        const listing = listCases(s);
        assert.equal(listing.counts.shared, 2);
        assert.equal(listing.counts.local, 2);
        assert.equal(listing.counts.total, 3);
        const b = listing.merged.find((c) => c.id === 'b');
        assert.equal(b.source, 'local');
        assert.equal(b.shadowedSource, 'shared');
        assert.equal(b.title, '本地版 B');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('readCase：按 casesPrefer 决定优先级', () => {
    const { root, pkgRoot, home } = fixture();
    try {
        const preferLocal = resolveCaseSources({}, { DSH_HOME: home }, pkgRoot);
        assert.equal(readCase(preferLocal, 'b').source, 'local');
        const preferShared = resolveCaseSources({ casesPrefer: 'shared' }, { DSH_HOME: home }, pkgRoot);
        assert.equal(readCase(preferShared, 'b').source, 'shared');
        assert.equal(readCase(preferLocal, 'c').source, 'local');
        assert.equal(readCase(preferLocal, 'nope'), null);
        assert.deepEqual(readCase(preferLocal, '../evil'), { error: 'bad-id' });
        assert.deepEqual(readCase(preferLocal, 'a/b'), { error: 'bad-id' });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('saveLocalCase：写入本地库、内容强制脱敏、默认不覆盖', () => {
    const { root, pkgRoot, home, local } = fixture();
    try {
        const s = resolveCaseSources({}, { DSH_HOME: home }, pkgRoot);
        const body = '路径 C:\\Users\\alice\\.dsh，主机 BOX-42，令牌 ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
        const r = saveLocalCase(s, { id: 'local-1', title: '新病例', body }, { identity: IDENT });
        assert.equal(r.ok, true);
        const text = require_read(r.path);
        assert.ok(!text.includes('C:\\Users\\alice'), 'home 必须被脱敏');
        assert.ok(!text.includes('BOX-42'), '主机名必须被脱敏');
        assert.ok(!text.includes('ghp_ABCDEF'), '令牌必须被脱敏');
        assert.ok(text.startsWith('# 新病例'));

        const again = saveLocalCase(s, { id: 'local-1', title: 'x', body: 'y' }, { identity: IDENT });
        assert.equal(again.ok, false);
        assert.equal(again.reason, 'exists');
        const forced = saveLocalCase(s, { id: 'local-1', title: '改过', body: 'z' }, { identity: IDENT, force: true });
        assert.equal(forced.ok, true);
        assert.ok(require_read(forced.path).startsWith('# 改过'));

        assert.equal(saveLocalCase(s, { id: '../escape', title: 'x', body: 'y' }, { identity: IDENT }).reason, 'bad-id');
        assert.equal(saveLocalCase(s, { id: 'ok-id', title: 'x', body: '   ' }, { identity: IDENT }).reason, 'empty-body');
        // 仍应只落在本地库
        assert.equal(existsSync(path.join(local, 'ok-id.md')), false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('saveLocalCase：allowLocalCaseWrite=false 时彻底只读', () => {
    const { root, pkgRoot, home } = fixture();
    try {
        const s = resolveCaseSources({ allowLocalCaseWrite: false }, { DSH_HOME: home }, pkgRoot);
        const r = saveLocalCase(s, { id: 'x1', title: 't', body: 'b' }, { identity: IDENT });
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'local-write-disabled');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('saveLocalCase：本地库目录还不存在时也能首次写入（真机回归）', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'dsh-doctor-cases-missing-'));
    try {
        const home = path.join(root, 'home');
        mkdirSync(home, { recursive: true });
        const pkg = path.join(root, 'pkg');
        mkdirSync(path.join(pkg, 'docs', 'cases'), { recursive: true });
        const s = resolveCaseSources({}, { DSH_HOME: home }, pkg);
        assert.equal(existsSync(s.local), false, '前置：本地库目录应不存在');
        const r = saveLocalCase(s, { id: 'first', title: 't', body: 'b' }, { identity: IDENT });
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(existsSync(path.join(s.local, 'first.md')), true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('renderCaseIndex：两个库都出现，并说明覆盖规则', () => {
    const { root, pkgRoot, home } = fixture();
    try {
        const s = resolveCaseSources({}, { DSH_HOME: home }, pkgRoot);
        const md = renderCaseIndex(listCases(s), IDENT);
        assert.ok(md.includes('共享库'));
        assert.ok(md.includes('本地库'));
        assert.ok(md.includes('本地覆盖共享'));
        assert.ok(md.includes('shared-count') === false); // 不泄漏内部字段
        assert.ok(md.includes('2 条') || md.includes('—— 2 条'));
        assert.ok(md.includes('[home]') || md.includes('<home>') || md.includes('home'), '路径必须脱敏');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

// 小工具：同步读文件（测试里足够）
const require_read = (p) => readFileSync(p, 'utf8');
