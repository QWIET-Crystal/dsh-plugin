/**
 * dsh-doctor / test/upgrade.test.mjs —— 「升级假成功」这条线
 *
 * 真教训（2026-10-11）：桌面端安装器退出码 0，但一个文件都没换 —— 因为安装目录
 * 的 ACL 只给读，而没提权时它连报错都不报。0.1.x 完全没有这条检查。
 *
 * 0.2.0 的做法刻意保守：
 *   - 版本漂移：info（多宿主内核不一致很常见，不该报成故障）；
 *   - 写权限：默认不探；打开 deepWriteProbe 才真写一个空文件判定，失败才 fault。
 *     —— 因为 `fs.access(W_OK)` 在 Windows 上看的是只读属性、不是 ACL，用它等于永远报绿。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { probeDirWritable } from '../lib/detect.js';
import { IDS } from '../lib/findings.js';
import { collectFindings } from '../lib/report.js';

const emptyLogScan = { hits: [], scanned: [], warnings: [], capability: { ok: true, reason: null } };

function base(over = {}) {
    return {
        generatedAt: new Date().toISOString(),
        platform: process.platform,
        node: process.version,
        host: 'h',
        environment: {},
        homes: [],
        engines: [],
        declaredPorts: [],
        probedPorts: [],
        running: [],
        warnings: [],
        capabilities: { homesDenied: [], profilesTruncated: [], portUnknown: [] },
        ...over,
    };
}

test('probeDirWritable：可写目录返回 writable=true，不留下探针文件', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-probe-'));
    try {
        const r = probeDirWritable(dir);
        assert.equal(r.writable, true);
        assert.equal(r.error, null);
        // 探针必须清理干净
        assert.equal(readdirSync(dir).length, 0);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('probeDirWritable：目录不存在 → writable=false 且有 errno', () => {
    const r = probeDirWritable(path.join(os.tmpdir(), 'dsh-doctor-not-exist-' + Date.now()));
    assert.equal(r.writable, false);
    assert.ok(r.error);
});

test('版本漂移只报 info，不影响判定', () => {
    const d = base({
        engines: [
            { kind: 'npm', version: '0.2.1', kernelVersion: null, path: 'C:/npm/x', dir: 'C:/npm' },
            { kind: 'desktop', version: '2.0.18', kernelVersion: '0.2.0', path: 'D:/d/resources/app/package.json', dir: 'D:/d' },
        ],
    });
    const findings = collectFindings(d, emptyLogScan);
    const drift = findings.filter((f) => f.id === IDS.UPGRADE_VERSION_DRIFT);
    assert.equal(drift.length, 1);
    assert.equal(drift[0].level, 'info');
    assert.ok(findings.every((f) => f.level !== 'fault' && f.level !== 'unknown'));
});

test('内核版本一致时不报漂移（少一条噪音）', () => {
    const d = base({
        engines: [
            { kind: 'npm', version: '0.2.1', kernelVersion: null, path: 'C:/npm/x', dir: 'C:/npm' },
            { kind: 'desktop', version: '2.0.18', kernelVersion: '0.2.1', path: 'D:/d/resources/app/package.json', dir: 'D:/d' },
        ],
    });
    const findings = collectFindings(d, emptyLogScan);
    assert.equal(findings.filter((f) => f.id === IDS.UPGRADE_VERSION_DRIFT).length, 0);
});

test('写权限探针命中 → fault，并指向升级案例', () => {
    const d = base({
        engines: [{ kind: 'desktop', version: '2.0.18', kernelVersion: '0.2.1', path: 'D:/d/resources/app/package.json', dir: 'D:/d' }],
        writeProbe: [{ dir: 'D:/d', writable: false, error: 'EPERM' }],
    });
    const findings = collectFindings(d, emptyLogScan);
    const hit = findings.find((f) => f.id === IDS.UPGRADE_DIR_NOT_WRITABLE);
    assert.ok(hit);
    assert.equal(hit.level, 'fault');
    assert.equal(hit.caseId, '2026-10-11-desktop-upgrade-2.0.4-to-2.0.17');
});

test('没开探针时不会有任何写权限结论', () => {
    const d = base({
        engines: [{ kind: 'desktop', version: '2.0.18', kernelVersion: '0.2.1', path: 'D:/d/resources/app/package.json', dir: 'D:/d' }],
    });
    const findings = collectFindings(d, emptyLogScan);
    assert.equal(findings.filter((f) => f.id === IDS.UPGRADE_DIR_NOT_WRITABLE).length, 0);
});
