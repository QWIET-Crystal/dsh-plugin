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
 *   dsh-doctor check   [--json] [--no-deep] [--no-save] [--html <file>]   # 分层体检
 *   dsh-doctor fix     [--json]            # 只输出"照抄即可"的修理清单（不执行）
 *   dsh-doctor kit     --to <dir>          # 导出急救包（.cmd + .ps1 + 内置副本）
 *   dsh-doctor runs    [name] [--json]     # 体检历史
 *   dsh-doctor cases   [id] [--json]       # 两库索引 / 读单条
 *   dsh-doctor contribute --from <file> …  # 一键脱敏入册（转 tools/contribute.mjs）
 *
 * 退出码（0.2.0 起）：0 全绿 / 1 有注意项 / 2 有真故障或参数错误 / 3 无法完整取证
 *   3 的含义是"我不确定"：有探测没能完成，所以 0/1 都不能当真。有 fault 时仍然是 2。
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { runCheck } from '../lib/check.js';
import { listCases, markPromoted, readCase, renderCaseIndex, renderCaseSearch, resolveCaseSources, searchCases } from '../lib/cases.js';
import { discover } from '../lib/detect.js';
import { renderHtml } from '../lib/html.js';
import { redactPayload, renderEngines, renderPayload } from '../lib/report.js';
import { listRuns, readRun, renderRuns, resolveRunsDir } from '../lib/runs.js';
import { localIdentity, redact } from '../lib/safety.js';

const PACKAGE_ROOT = path.join(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const cmd = argv[0] || 'help';
const flags = new Set(argv.filter((a) => a.startsWith('--')));
/** 这些开关后面跟一个值，不能把它当位置参数。 */
const VALUE_FLAGS = new Set(['--html', '--to', '--from', '--repo', '--search', '--limit']);
const flagValue = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
};
const positional = argv
    .slice(1)
    .filter((a, i, arr) => !a.startsWith('--') && !VALUE_FLAGS.has(arr[i - 1] || ''));
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
                '  dsh-doctor engines [--json]             发现本机所有 DSH 引擎/实例/profile',
                '  dsh-doctor check   [--json] [--no-deep] [--no-save] [--html <file>] [--quiet]',
                '                                          分层体检（--html 出自包含报告；--quiet 只留退出码）',
                '  dsh-doctor fix     [--json]             只输出「照抄即可」的修理清单（不执行任何东西）',
                '  dsh-doctor plan    [--json]             输出「修复计划」（动作清单，供急救包执行；本命令不动手）',
                '  dsh-doctor kit     --to <目录>          导出急救包（双击即用，含 .cmd/.ps1 与内置副本）',
                '  dsh-doctor runs    [name] [--json]      体检历史：不带 name 列清单，给 name 读单条',
                '  dsh-doctor where   [--json]             宿主包解析到哪一份（工具没反应时先看它）',
                '  dsh-doctor cases   [id] [--json]        两库索引；给 id 则读单条',
                '  dsh-doctor case-from <finding-id>       从一条体检结论直接起草病例（--dry-run 只看不写）',
                '  dsh-doctor case-promote <本地id> <共享id>  合入后在本地病例里留一行 promoted 标记',
                '  dsh-doctor contribute --from <file> [--pr] [--dry-run]',
                '',
                '退出码：0 全绿 / 1 有注意项 / 2 有真故障或参数错误 / 3 无法完整取证',
            ].join('\n'),
        );
        return 0;
    }

    if (cmd === 'engines') {
        const d = await discover({});
        if (json) {
            out({
                homes: d.homes.map((h) => ({ dir: redact(h.dir, identity), profiles: h.profiles.map((p) => p.name), error: h.error || null })),
                engines: d.engines.map((e) => ({ kind: e.kind, version: e.version, kernel: e.kernelVersion })),
                running: d.running.map((r) => r.port),
                capabilities: d.capabilities,
            });
            return 0;
        }
        console.log(renderEngines(d, identity));
        return 0;
    }

    if (cmd === 'check') {
        // 默认扫日志、默认记历史：空绿比报错更危险（--no-deep / --no-save 才跳过）
        const payload = await runCheck({
            env: process.env,
            deep: !flags.has('--no-deep'),
            saveRuns: !flags.has('--no-save'),
            sessionScan: !flags.has('--no-sessions'),
            deepSessions: flags.has('--deep-sessions'),
            retention: 30,
            throttleMs: 15000,
        });
        const htmlPath = flagValue('--html');
        const quiet = flags.has('--quiet');
        if (htmlPath) {
            writeFileSync(path.resolve(htmlPath), renderHtml(redactPayload(payload), {}), 'utf8');
            if (!json && !quiet) console.error(`[dsh-doctor] HTML 报告已写入 ${path.resolve(htmlPath)}`);
        }
        if (json) out(payload);
        else if (!quiet) console.log(renderPayload(payload, identity));
        return payload.exitCode;
    }

    if (cmd === 'plan') {
        // 只产出"动作清单"，不执行：执行器在急救包里（插件与 CLI 都保持零执行面）
        const payload = await runCheck({
            env: process.env,
            deep: !flags.has('--no-deep'),
            saveRuns: false,
            sessionScan: !flags.has('--no-sessions'),
            deepSessions: flags.has('--deep-sessions'),
        });
        const { buildRepairPlan, collectPatchFiles, renderRepairPlan } = await import('../lib/repairs.js');
        const plan = buildRepairPlan(payload, { patchFiles: collectPatchFiles(payload.discovery) });
        if (json) {
            out({ ok: true, verdict: payload.verdict, plan });
            return 0;
        }
        console.log(renderRepairPlan(plan));
        return 0;
    }

    if (cmd === 'fix') {
        // 只列"照抄即可"的命令，**不执行**：执行属于急救包的职责（插件保持零执行面）
        const payload = await runCheck({
            env: process.env,
            deep: !flags.has('--no-deep'),
            saveRuns: !flags.has('--no-save'),
            sessionScan: !flags.has('--no-sessions'),
            deepSessions: flags.has('--deep-sessions'),
            retention: 30,
            throttleMs: 15000,
        });
        const withFix = payload.findings.filter((f) => (f.fix || []).length);
        const noFix = payload.findings.filter((f) => !(f.fix || []).length && ['fault', 'unknown', 'warn'].includes(f.level));
        const actionable = [...withFix, ...noFix];
        if (json) {
            out({ verdict: payload.verdict, exitCode: payload.exitCode, summary: payload.summary, actionable, withoutCommand: noFix });
            return payload.exitCode;
        }
        const lines = [];
        lines.push('# 修理清单（照抄即可；本命令不会执行任何东西）');
        lines.push('');
        if (withFix.length === 0 && noFix.length === 0) {
            lines.push('没有需要动手的项。');
        } else {
            withFix.forEach((f, i) => {
                lines.push(`## ${i + 1}. [${f.level}] ${f.area}：${f.text}`);
                if (f.caseId) lines.push(`   → 案例 ${f.caseId}`);
                for (const c of f.fix) lines.push('   $ ' + c);
                lines.push('');
            });
            if (noFix.length) {
                lines.push('## 需要看一眼，但没有可直接执行的命令');
                lines.push('');
                for (const f of noFix) {
                    lines.push(`- [${f.level}] ${f.area}：${f.text}${f.caseId ? ` → 案例 ${f.caseId}` : ''}`);
                }
                lines.push('');
                lines.push('（想补上可执行命令：把那次的处置写成病例里的 `## 处置命令` 章节，下次就会自动带出来。）');
                lines.push('');
            }
        }
        lines.push(`判定：${payload.verdict}（退出码 ${payload.exitCode}）`);
        console.log(lines.join('\n'));
        return payload.exitCode;
    }

    if (cmd === 'kit') {
        const to = flagValue('--to') || positional[0];
        if (!to) {
            console.error('用法：dsh-doctor kit --to <导出目录>');
            return 2;
        }
        const { exportKit } = await import('../lib/kit.js');
        const r = exportKit(path.resolve(to), { packageRoot: PACKAGE_ROOT });
        if (json) out(r);
        else {
            console.log(`急救包已导出到 ${r.dir}`);
            console.log(`  双击：${r.entry}`);
            console.log(`  文件：${r.files.length} 个，共 ${(r.bytes / 1024).toFixed(1)} KB`);
        }
        return r.ok ? 0 : 2;
    }

    if (cmd === 'runs') {
        const dir = resolveRunsDir(process.env);
        const name = positional[0];
        if (name) {
            const hit = readRun(dir, name);
            if (!hit.ok) {
                console.error(`读不到历史 ${name}（${hit.reason}）`);
                return 2;
            }
            if (json) out({ name, path: redact(hit.path, identity), doc: hit.doc });
            else console.log(hit.text);
            return 0;
        }
        const runs = listRuns(dir, 30);
        if (json) out({ dir: redact(dir, identity), runs });
        else console.log(renderRuns(runs, dir, (p) => redact(p, identity)));
        return 0;
    }

    if (cmd === 'case-from') {
        // 从一条体检结论直接起草病例：症状/判定签名/处置命令都已经在 finding 里
        const id = positional[0];
        if (!id) {
            console.error('用法：dsh-doctor case-from <finding-id> [--dry-run] [--json]');
            console.error('   例：dsh-doctor case-from SESSION.REPETITION.COLLAPSE');
            return 2;
        }
        const payload = await runCheck({
            env: process.env,
            deep: !flags.has('--no-deep'),
            saveRuns: false,
            sessionScan: !flags.has('--no-sessions'),
            deepSessions: flags.has('--deep-sessions'),
        });
        const finding = payload.findings.find((f) => f.id === id);
        if (!finding) {
            console.error(`这次体检里没有 ${id}。先跑 dsh-doctor check 看看现在有哪些结论（id 都在里面）。`);
            return 2;
        }
        const { draftCaseFromFinding } = await import('../lib/case-draft.js');
        const draft = draftCaseFromFinding(finding, { generatedAt: payload.generatedAt });
        const sources = resolveCaseSources({}, process.env, PACKAGE_ROOT);
        const target = path.join(sources.local, draft.filename);
        if (json) {
            out({ ok: true, id: draft.id, path: flags.has('--dry-run') ? null : redact(target, identity), markdown: draft.markdown });
            return 0;
        }
        if (flags.has('--dry-run')) {
            console.log(draft.markdown);
            console.log(`\n（预览完毕。去掉 --dry-run 就会写到 ${redact(sources.local, identity)}）`);
            return 0;
        }
        try {
            mkdirSync(sources.local, { recursive: true });
            writeFileSync(target, draft.markdown, 'utf8');
        } catch (e) {
            console.error(`写不进本地案例库：${e && e.message}`);
            return 2;
        }
        console.log(`已起草：${redact(target, identity)}`);
        console.log('');
        console.log('接下来只差两步（不用手抄）：');
        console.log('  1) 打开它，把「根因」「处置与结果」「验证」三节补成实话');
        console.log(`  2) 合进共享库：dsh-doctor case-promote ${draft.id} <共享id>，再把文件放进 docs/cases/ 提 PR`);
        return 0;
    }

    if (cmd === 'case-promote') {
        // 本地病例合入共享库后，在本地文件里留一行 `> promoted: <shared-id>`（不删文件）
        const [localId, sharedId] = positional;
        if (!localId || !sharedId) {
            console.error('用法：dsh-doctor case-promote <本地病例id> <共享库病例id>');
            return 2;
        }
        const sources = resolveCaseSources({}, process.env, PACKAGE_ROOT);
        const r = markPromoted(sources, localId, sharedId);
        if (json) out(r);
        else if (r.ok) console.log(r.already ? `已经是这个标记了：${r.path}` : `已标记为合入共享库：${r.path}`);
        else console.error(`未标记（${r.reason}）${r.previous ? `；原标记是 ${r.previous}` : ''}`);
        return r.ok ? 0 : 2;
    }

    if (cmd === 'cases') {
        const sources = resolveCaseSources({}, process.env, PACKAGE_ROOT);
        const kw = flagValue('--search');
        if (kw) {
            const result = searchCases(sources, kw, { limit: Number(flagValue('--limit')) || 20 });
            if (json) out(result);
            else console.log(renderCaseSearch(result, identity));
            return result.hits.length > 0 ? 0 : 1;
        }
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

    if (cmd === 'where') {
        // 漂移排查：宿主包到底解析到哪一份（陌生人报"工具没反应"时先看这个）
        // 动态导入：正常命令不该把整个插件入口（含宿主解析）也加载一遍
        process.env.DSH_DOCTOR_QUIET = '1';
        const { hostToolsOrigin } = await import('../lib/index.js');
        const origin = hostToolsOrigin;
        if (json) out({ hostTools: origin || null });
        else console.log(origin ? `@deepseek-ai/dsh-tools ← ${origin}` : '@deepseek-ai/dsh-tools 未解析到（工具将以最小形状注册）');
        return origin ? 0 : 1;
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

    console.error(`未知命令: ${cmd}（可用 engines / check / runs / cases / contribute，或 --help）`);
    return 2;
}

process.exitCode = await main();
