/**
 * dsh-doctor / lib/index.js —— 插件入口：注册三个只读诊断工具
 *
 * 工具面刻意只有三个，且**全部只读**：
 *   doctor_engines  自动发现本机所有 DSH 引擎/实例/profile（含正在监听的端口）
 *   doctor_check    对一个实例做分层体检（进程/端口/插件/日志），输出可跳 runbook 的报告
 *   doctor_cases    读随包案例库（脱敏后的历史故障；只读、白名单限定在包内 docs/cases）
 *
 * 安全边界（结构性保证，不靠"小心"）：本插件不 import child_process/vm/eval，
 * 不做任何写操作，不监听端口；读文件一律经 safety.safeReadText（白名单 + 上限 + 截断标注）。
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineTool } from '@deepseek-ai/dsh-tools';

import { discover } from './detect.js';
import { collectFindings, renderEngines, renderReport, scanDesktopLogs } from './report.js';
import { DEFAULT_LIMITS, localIdentity, redact, safeReadText } from './safety.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.join(HERE, '..');
const CASES_DIR = path.join(PACKAGE_ROOT, 'docs', 'cases');

const textOutput = Object.freeze({
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
});

/** 归一化宿主传来的 config（未给就用安全默认值）。 */
export function normalizeConfig(config) {
    const c = config && typeof config === 'object' ? config : {};
    const int = (v, d, lo, hi) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), lo), hi) : d;
    };
    return {
        maxProfiles: int(c.maxProfiles, DEFAULT_LIMITS.maxProfiles, 1, 200),
        maxLogBytes: int(c.maxLogBytes, DEFAULT_LIMITS.maxLogBytes, 4096, 32 * 1024 * 1024),
        httpTimeoutMs: int(c.httpTimeoutMs, DEFAULT_LIMITS.httpTimeoutMs, 100, 30000),
        cacheTtlMs: int(c.cacheTtlMs, 15000, 0, 600000),
        ports: Array.isArray(c.ports) && c.ports.length ? c.ports.map(Number).filter((n) => n > 0 && n < 65536) : undefined,
    };
}

export function apply(ctx, config) {
    const cfg = normalizeConfig(config);
    const limits = {
        maxProfiles: cfg.maxProfiles,
        maxLogBytes: cfg.maxLogBytes,
        httpTimeoutMs: cfg.httpTimeoutMs,
    };

    // 发现结果缓存：同一轮里连续调用（先 engines 再 check）不重复扫盘（性能优化项之一）
    let cache = { at: 0, data: null };
    async function getDiscovery(force) {
        const now = Date.now();
        if (!force && cache.data && now - cache.at < cfg.cacheTtlMs) return cache.data;
        const data = await discover({ limits, ports: cfg.ports });
        cache = { at: now, data };
        return data;
    }

    const register = (key, spec) => {
        const tool = defineTool({
            ...spec,
            output: textOutput,
            isConcurrencySafe: () => true,
        });
        return ctx.effect(() => ctx.tools.register(tool), 'dsh-doctor:' + key);
    };

    register('engines', {
        name: 'doctor_engines',
        description:
            '[dsh-doctor] 自动发现本机所有 DeepSeek Harness 引擎与实例：所有 DSH_HOME、每个 profile 的 bundles/依赖/声明端口、' +
            'npm 全局内核与桌面端的版本、以及正在监听的宿主端口。只读，不执行任何子进程。',
        parameters: {
            refresh: { type: 'boolean', description: '为 true 时跳过缓存重新扫描（默认 false）' },
        },
        timeoutMs: 30000,
        async execute(args) {
            const d = await getDiscovery(Boolean(args && args.refresh));
            return renderEngines(d, localIdentity());
        },
    });

    register('check', {
        name: 'doctor_check',
        description:
            '[dsh-doctor] 对发现的引擎做分层体检：端口/HTTP/插件装配/桌面端日志签名，输出带对策库指针的报告。' +
            '只读；报告里的日志行会先脱敏再围栏化，外来文本不会被当成指令。',
        parameters: {
            refresh: { type: 'boolean', description: '为 true 时跳过缓存重新扫描（默认 false）' },
            deep: { type: 'boolean', description: '为 true 时额外扫描桌面端最近两个日志文件（默认 true）' },
        },
        timeoutMs: 45000,
        async execute(args) {
            const deep = args && args.deep === false ? false : true;
            const identity = localIdentity();
            const d = await getDiscovery(Boolean(args && args.refresh));
            const logScan = deep ? scanDesktopLogs(process.env, limits) : { hits: [], scanned: [], warnings: ['已跳过日志扫描（deep=false）'] };
            const findings = collectFindings(d, logScan);
            return renderReport(d, findings, logScan, identity);
        },
    });

    register('cases', {
        name: 'doctor_cases',
        description:
            '[dsh-doctor] 读取随包案例库（脱敏后的历史故障：症状 → 判定签名 → 根因 → 处置 → 验证）。' +
            '省略 id 时列出索引；id 只允许字母数字与 -_.，且读取被白名单限定在包内 docs/cases 目录。',
        parameters: {
            id: { type: 'string', description: '案例编号（如 2026-09-23-testjob-deadlock），省略则列索引' },
        },
        timeoutMs: 15000,
        async execute(args) {
            const identity = localIdentity();
            const id = String((args && args.id) || '').trim();
            if (!id) {
                const r = safeReadText(path.join(CASES_DIR, 'INDEX.md'), { roots: [CASES_DIR] });
                if (!r.ok) return `案例索引暂时不可读（${r.reason}）。安装完整包后应包含 docs/cases/INDEX.md。`;
                return redact(r.text, identity);
            }
            if (!/^[A-Za-z0-9._-]{1,80}$/.test(id)) return 'id 不合法：只允许字母、数字与 -_.（不带路径分隔符）。';
            const file = path.join(CASES_DIR, id.endsWith('.md') ? id : id + '.md');
            const r = safeReadText(file, { roots: [CASES_DIR] });
            if (!r.ok) {
                const list = existsSync(CASES_DIR) ? '可用 `doctor_cases`（不带 id）查看索引。' : '本包未附带案例库。';
                return `读不到案例 ${id}（${r.reason}）。${list}`;
            }
            return redact(r.text, identity);
        },
    });
}
