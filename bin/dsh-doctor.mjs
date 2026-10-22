#!/usr/bin/env node
/**
 * dsh-doctor / bin/dsh-doctor.mjs —— 脱离宿主的离线入口
 *
 * 为什么需要它（吸取同类项目的经验，见 README 的对比一节）：
 *   插件只在宿主活着的时候可用；而"DSH 起不来"恰恰是最需要诊断的时刻。
 *   所以这里提供一个不依赖 DSH 的 CLI：只要有 Node，就能体检、看案例、贡献病例。
 *
 * 用法：
 *   dsh-doctor engines [--json]            # 发现本机所有引擎/实例
 *   dsh-doctor check   [--json] [--deep]   # 分层体检（端口/装配/日志）
 *   dsh-doctor cases   [id] [--json]       # 两库索引 / 读单条
 *   dsh-doctor contribute --from <file> …  # 一键脱敏入册（转 tools/contribute.mjs）
 *
 * 退出码：0 全绿 / 1 有注意项 / 2 有真故障或参数错误
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { listCases, readCase, renderCaseIndex, resolveCaseSources } from '../lib/cases.js';
import { discover } from '../lib/detect.js';
import { collectFindings, renderEngines, renderReport, scanDesktopLogs } from '../lib/report.js';
import { localIdentity, redact } from '../lib/safety.js';

const PACKAGE_ROOT = path.join(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const cmd = argv[0] || 'help';
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positional = argv.slice(1).filter((a) => !a.startsWith('--'));
const json = flags.has('--json');

function out(obj) {
    if (json) console.log(JSON.stringify(obj, null, 2));
}

async function main() {
    const identity = localIdentity();
    if (cmd === 'help' || flags.has('--help')) {
        console.log(
            [
                'dsh-doctor —— 脱离宿主的离线体检与案例库工具',
                '',
                '  dsh-doctor engines [--json]           发现本机所有 DSH 引擎/实例/profile',
                '  dsh-doctor check   [--json] [--deep]  分层体检（端口 / profile 装配 / 桌面端日志）',
                '  dsh-doctor cases   [id] [--json]      两库索引；给 id 则读单条',
                '  dsh-doctor contribute --from <file> [--pr] [--dry-run]',
                '',
                '退出码：0 全绿 / 1 有注意项 / 2 有真故障或参数错误',
            ].join('\n'),
        );
        return 0;
    }

    if (cmd === 'engines') {
        const d = await discover({});
        if (json) {
            out({ homes: d.homes.map((h) => ({ dir: redact(h.dir, identity), profiles: h.profiles.map((p) => p.name) })), engines: d.engines.map((e) => ({ kind: e.kind, version: e.version, kernel: e.kernelVersion })), running: d.running.map((r) => r.port) });
            return 0;
        }
        console.log(renderEngines(d, identity));
        return 0;
    }

    if (cmd === 'check') {
        const d = await discover({});
        const logScan = flags.has('--deep') === false ? { hits: [], scanned: [], warnings: ['已跳过日志扫描（--deep 关闭）'] } : scanDesktopLogs(process.env, { maxLogBytes: 2 * 1024 * 1024, httpTimeoutMs: 1200 });
        const findings = collectFindings(d, logScan);
        if (json) {
            out({ findings, scanned: logScan.scanned });
        } else {
            console.log(renderReport(d, findings, logScan, identity));
        }
        const faults = findings.filter((f) => f.level === 'fault').length;
        const warns = findings.filter((f) => f.level === 'warn').length;
        return faults > 0 ? 2 : warns > 0 ? 1 : 0;
    }

    if (cmd === 'cases') {
        const sources = resolveCaseSources({}, process.env, PACKAGE_ROOT);
        const id = positional[0];
        if (!id) {
            const listing = listCases(sources);
            if (json) out({ counts: listing.counts, merged: listing.merged });
            else console.log(renderCaseIndex(listing, identity));
            return 0;
        }
        const hit = readCase(sources, id);
        if (!hit) {
            console.error(`读不到案例 ${id}（本地库与共享库都没有）`);
            return 2;
        }
        if (json) out({ source: hit.source, dir: redact(hit.dir, identity), text: hit.text });
        else console.log(`> 来源：${hit.source === 'local' ? '本地库' : '共享库'}\n\n` + redact(hit.text, identity));
        return 0;
    }

    if (cmd === 'contribute') {
        // 交给 tools/contribute.mjs（stdio 继承，参数原样透传）
        const script = path.join(PACKAGE_ROOT, 'tools', 'contribute.mjs');
        try {
            execFileSync(process.execPath, [script, ...argv.slice(1)], { stdio: 'inherit', cwd: PACKAGE_ROOT });
            return 0;
        } catch (e) {
            return typeof e.status === 'number' ? e.status : 1;
        }
    }

    console.error(`未知命令: ${cmd}（可用 engines / check / cases / contribute，或 --help）`);
    return 2;
}

process.exitCode = await main();
