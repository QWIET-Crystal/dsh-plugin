/**
 * dsh-doctor / test/abi.test.mjs —— 静态 ABI 检查
 *
 * 目标不是"把 semver 实现完整"，而是**在内核升级前就能说出哪些插件会挂**，
 * 同时保证不猜：看不懂的范围一律 unknown。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { compareVersion, parseVersion, satisfies } from '../lib/semver-lite.js';
import { inspectBundles, isKernelProvided, kernelProfileOf, peerRangeOf } from '../lib/packages.js';
import { IDS, summarize, verdictOf } from '../lib/findings.js';
import { collectFindings } from '../lib/report.js';

const emptyLogScan = { hits: [], scanned: [], warnings: [], capability: { ok: true, reason: null } };

test('semver-lite：支持的语法判对，不支持的返 null（不猜）', () => {
    assert.deepEqual(parseVersion('v0.2.1-rc.2'), { major: 0, minor: 2, patch: 1, pre: ['rc', '2'] });
    assert.equal(parseVersion('0.2'), null);

    assert.equal(satisfies('0.2.1', '^0.2.0'), true);
    assert.equal(satisfies('0.3.0', '^0.2.0'), false);
    assert.equal(satisfies('1.2.9', '~1.2.0'), true);
    assert.equal(satisfies('1.3.0', '~1.2.0'), false);
    assert.equal(satisfies('0.2.1', '>=0.2.0 <0.3.0-0'), true);
    assert.equal(satisfies('0.3.0', '>=0.2.0 <0.3.0-0'), false);
    assert.equal(satisfies('0.2.1', '=0.2.1'), true);
    assert.equal(satisfies('0.2.1', '*'), true);
    assert.equal(satisfies('0.2.1', '^0.2.0 || ^0.3.0'), true);
    // 预发布排序：0.2.0-rc.2 > 0.2.0-rc.1
    assert.equal(satisfies('0.2.0-rc.1', '>=0.2.0-rc.2'), false);
    assert.equal(satisfies('0.2.0-rc.2', '>=0.2.0-rc.2'), true);
    assert.equal(compareVersion(parseVersion('0.2.1'), parseVersion('0.2.0')), 1);

    // 不支持的写法必须返 null，而不是 false
    for (const bad of ['workspace:*', 'file:../x', 'npm:@deepseek-ai/dsh@0.2.1', '1.x', 'latest', '']) {
        assert.equal(satisfies('0.2.1', bad), null, `${bad} 应判 unknown`);
    }
});

test('packages：内核自带的 bundle 不解析、不判定', () => {
    assert.equal(isKernelProvided('@deepseek-ai/dsh-base'), true);
    assert.equal(isKernelProvided('dsh-better-sidebar'), false);
    const rows = inspectBundles({ dir: '/nonexistent', bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] }, ['0.2.1']);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.skipped === true));
});

test('packages：解析得到 / 缺失 / peer 不满足三种情况', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-abi-'));
    try {
        const profileDir = path.join(root, 'profile');
        mkdirSync(path.join(profileDir, 'node_modules', 'old-plugin'), { recursive: true });
        writeFileSync(
            path.join(profileDir, 'node_modules', 'old-plugin', 'package.json'),
            JSON.stringify({ name: 'old-plugin', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh': '^0.3.0' } }),
        );
        mkdirSync(path.join(profileDir, 'node_modules', 'any-plugin'), { recursive: true });
        writeFileSync(
            path.join(profileDir, 'node_modules', 'any-plugin', 'package.json'),
            JSON.stringify({ name: 'any-plugin', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh': 'workspace:*' } }),
        );

        const profile = { dir: profileDir, bundles: ['old-plugin', 'any-plugin', 'ghost-plugin'] };
        const rows = inspectBundles(profile, ['0.2.1']);
        const by = Object.fromEntries(rows.map((r) => [r.name, r]));

        assert.equal(by['old-plugin'].found, true);
        assert.equal(by['old-plugin'].satisfied, false, '内核 0.2.1 不满足 ^0.3.0');
        assert.equal(by['any-plugin'].satisfied, true, 'workspace:* 是占位范围，不算不满足');
        assert.equal(by['ghost-plugin'].found, false);
        assert.equal(peerRangeOf({ peerDependencies: {} }), null);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('kernelProfileOf：npm 引擎的 version 就是内核版本', () => {
    const kp = kernelProfileOf({
        engines: [
            { kind: 'npm', version: '0.2.1', dir: 'C:/npm', path: 'C:/npm/node_modules/@deepseek-ai/dsh/package.json' },
            { kind: 'desktop', version: '2.0.18', kernelVersion: '0.2.1', dir: 'D:/DSH DESKTOP' },
        ],
    });
    assert.deepEqual(kp.versions, ['0.2.1']);
    assert.ok(kp.dirs.length >= 1);
});

function discoveryWithProfile(profileDir, bundles, kernelVersions) {
    return {
        generatedAt: new Date().toISOString(),
        platform: process.platform,
        node: process.version,
        host: 'h',
        environment: {},
        homes: [{ dir: profileDir, profileCount: 1, error: null, profiles: [{ name: 'desktop', dir: profileDir, bundles, deps: [], hasPatch: true, hasNodeModules: true, declaredPorts: [] }] }],
        engines: kernelVersions.map((v) => ({ kind: 'npm', label: `npm ${v}`, version: v, kernelVersion: null, path: `${profileDir}/x`, dir: profileDir })),
        declaredPorts: [],
        probedPorts: [],
        running: [],
        warnings: [],
        capabilities: { homesDenied: [], profilesTruncated: [], portUnknown: [] },
    };
}

test('没有自己的 node_modules → 聚合成一条 info，不逐条刷"装不到"', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-abi3-'));
    try {
        const profileDir = path.join(root, 'backup-profile');
        mkdirSync(profileDir, { recursive: true }); // 故意不建 node_modules
        const d = discoveryWithProfile(profileDir, ['a-plugin', 'b-plugin', 'c-plugin'], ['0.2.1']);
        d.homes[0].profiles[0].hasNodeModules = false;
        const findings = collectFindings(d, emptyLogScan);
        assert.equal(findings.filter((f) => f.id === IDS.ABI_BUNDLE_MISSING).length, 0, '不该逐条报');
        const agg = findings.filter((f) => f.id === IDS.PROFILE_LOOKS_UNINSTALLED);
        assert.equal(agg.length, 1);
        assert.equal(agg[0].level, 'info', '备份目录不该把判定拖成 warn');
        assert.ok(agg[0].text.includes('3 个 bundle'));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('有 node_modules 但某个包解析不到 → 仍然逐条报（真问题不能被聚合掉）', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-abi2-'));
    try {
        const profileDir = path.join(root, 'profile');
        mkdirSync(path.join(profileDir, 'node_modules', 'old-plugin'), { recursive: true });
        writeFileSync(
            path.join(profileDir, 'node_modules', 'old-plugin', 'package.json'),
            JSON.stringify({ name: 'old-plugin', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh': '^0.3.0' } }),
        );
        const d = discoveryWithProfile(profileDir, ['old-plugin', 'ghost-plugin'], ['0.2.1']);
        const findings = collectFindings(d, emptyLogScan);
        const ids = findings.map((f) => f.id);
        assert.ok(ids.includes(IDS.ABI_BUNDLE_MISSING), '解析不到的 bundle 必须报出来');
        assert.ok(ids.includes(IDS.ABI_PEER_UNSATISFIED));
        // 静态检查只能证明"这个 profile 里装不对"，证明不了"当前宿主正在用它" → 不当故障
        assert.equal(findings.find((f) => f.id === IDS.ABI_BUNDLE_MISSING).level, 'warn');
        assert.equal(findings.find((f) => f.id === IDS.ABI_PEER_UNSATISFIED).level, 'warn');
        assert.equal(verdictOf(summarize(findings)), 'warn');
        assert.equal(findings.filter((f) => f.level === 'fault').length, 0);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
