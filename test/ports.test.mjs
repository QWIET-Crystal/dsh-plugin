/**
 * dsh-doctor / test/ports.test.mjs —— 「装了却没在跑」这条运行层检查
 *
 * 真机背景：关掉桌面端之后，0.3.0 之前的报告一片绿 —— 因为端口层只比对
 * "profile 声明过的端口"，而 43120 不在任何 profile 里。急救包最需要看到的
 * 恰恰是这一条，所以它必须由"本机确实装了哪个宿主"反推出来。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { IDS } from '../lib/findings.js';
import { collectFindings } from '../lib/report.js';

const emptyLogScan = { hits: [], scanned: [], warnings: [], capability: { ok: true, reason: null } };

function discovery({ engines, ports }) {
    const probed = ports.map(([port, state]) => ({ port, state, open: state === 'open', ms: 1, errno: state === 'unknown' ? 'EPERM' : null }));
    return {
        generatedAt: new Date().toISOString(),
        platform: 'win32',
        node: 'v24.0.0',
        host: 'h',
        environment: {},
        homes: [{ dir: 'C:/x/.dsh', profileCount: 1, error: null, profiles: [{ name: 'desktop', dir: 'C:/x/.dsh/profiles/desktop', bundles: [], deps: ['x'], hasPatch: true, declaredPorts: [] }] }],
        engines,
        declaredPorts: [],
        probedPorts: probed,
        running: probed.filter((p) => p.state === 'open'),
        warnings: [],
        capabilities: {
            homesDenied: [],
            profilesTruncated: [],
            portUnknown: probed.filter((p) => p.state === 'unknown').map((p) => ({ port: p.port, errno: p.errno })),
        },
    };
}

const npmEngine = { kind: 'npm', label: 'npm 全局内核 0.2.1', version: '0.2.1', kernelVersion: null, path: 'C:/npm/node_modules/@deepseek-ai/dsh/package.json', dir: 'C:/npm' };
const desktopEngine = { kind: 'desktop', label: '桌面端 2.0.18', version: '2.0.18', kernelVersion: '0.2.1-rc.2', path: 'D:/DSH DESKTOP/resources/app/package.json', dir: 'D:/DSH DESKTOP' };

test('桌面端装了但没在跑 → 一条 info + 可复制启动命令', () => {
    const d = discovery({ engines: [npmEngine, desktopEngine], ports: [[3080, 'open'], [43120, 'closed']] });
    const f = collectFindings(d, emptyLogScan).filter((x) => x.id === IDS.PORT_HOST_NOT_LISTENING);
    assert.equal(f.length, 1);
    assert.equal(f[0].level, 'info');
    assert.ok(f[0].text.includes('桌面端'));
    assert.ok(f[0].text.includes('43120'));
    assert.ok(f[0].fix.length >= 1, '必须给出可复制的启动命令');
    assert.ok(f[0].fix[0].includes('DSH Desktop.exe'));
});

test('全部宿主都没在跑 → 一条 warn 且标记为"头条"', () => {
    const d = discovery({ engines: [npmEngine, desktopEngine], ports: [[3080, 'closed'], [43120, 'closed']] });
    const found = collectFindings(d, emptyLogScan);
    const all = found.find((x) => x.id === IDS.PORT_ALL_HOSTS_DOWN);
    assert.ok(all, '全崩必须有独立结论');
    assert.equal(all.level, 'warn');
    assert.equal(all.meta.headline, true);
    assert.ok(all.fix.length >= 1);
});

test('没装桌面端时不报"桌面端没在运行"（避免误报）', () => {
    const d = discovery({ engines: [npmEngine], ports: [[3080, 'open'], [43120, 'closed']] });
    const found = collectFindings(d, emptyLogScan);
    assert.equal(found.filter((x) => x.id === IDS.PORT_HOST_NOT_LISTENING).length, 0);
    assert.equal(found.filter((x) => x.id === IDS.PORT_ALL_HOSTS_DOWN).length, 0);
});

test('探测失败（unknown）不算"没在跑"', () => {
    const d = discovery({ engines: [desktopEngine], ports: [[43120, 'unknown']] });
    const found = collectFindings(d, emptyLogScan);
    assert.equal(found.filter((x) => x.id === IDS.PORT_HOST_NOT_LISTENING).length, 0);
    assert.equal(found.filter((x) => x.id === IDS.PORT_PROBE_UNKNOWN).length, 1);
});
