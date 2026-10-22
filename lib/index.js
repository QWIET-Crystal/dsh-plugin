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

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.join(HERE, '..');

import { listCases, readCase, renderCaseIndex, resolveCaseSources, saveLocalCase } from './cases.js';
import { discover } from './detect.js';
import { collectFindings, renderEngines, renderReport, scanDesktopLogs } from './report.js';
import { DEFAULT_LIMITS, localIdentity, redact } from './safety.js';

/**
 * 解析宿主包时可用的根目录。
 * 关键：宿主真实入口（process.argv[1]）的祖先链 —— web 宿主从 `<内核>/lib/bin.js` 启动，
 * `@deepseek-ai/dsh-tools` 在内核安装的嵌套 node_modules 里，只有沿这条链才找得到。
 */
function candidateToolBases() {
    const bases = new Set();
    const add = (p) => {
        if (p && typeof p === 'string') bases.add(path.resolve(p));
    };
    add(process.cwd());
    add(path.dirname(process.execPath));
    if (typeof process.resourcesPath === 'string') add(path.join(process.resourcesPath, 'app'));
    add(path.join(path.dirname(process.execPath), 'resources', 'app'));
    if (process.env.DSH_HOME) add(process.env.DSH_HOME);
    let cur = process.argv[1] ? path.dirname(path.resolve(process.argv[1])) : null;
    for (let depth = 0; cur && depth < 5; depth++) {
        add(cur);
        const parent = path.dirname(cur);
        if (parent === cur) break;
        cur = parent;
    }
    return [...bases];
}

/**
 * 解析宿主提供的 @deepseek-ai/dsh-tools。
 *
 * 为什么不能只写一行 `import`：`link:` 安装时本包的真实路径在 profile 之外，
 * 裸导入可能解析不到宿主那份（此时若有同名包在包内 node_modules，就会被它顶掉 —— 真机踩过）。
 * 顺序：裸导入 → 工作目录 → 宿主可执行文件目录；都失败则退化成最小实现并**显式告警**。
 */
async function resolveDefineTool() {
    const accept = (m) => (m && typeof m.defineTool === 'function' ? m.defineTool : null);
    try {
        const m = await import('@deepseek-ai/dsh-tools');
        const hit = accept(m);
        if (hit) return { fn: hit, from: 'bare-import' };
    } catch {
        /* 继续尝试路径式解析 */
    }
    for (const base of candidateToolBases()) {
        try {
            const req = createRequire(path.join(base, 'noop.cjs'));
            const hit = accept(req('@deepseek-ai/dsh-tools'));
            if (hit) return { fn: hit, from: base };
        } catch {
            /* 下一个候选 */
        }
        try {
            const req = createRequire(path.join(base, 'noop.cjs'));
            const resolved = req.resolve('@deepseek-ai/dsh-tools');
            const hit = accept(await import(pathToFileURL(resolved).href));
            if (hit) return { fn: hit, from: resolved };
        } catch {
            /* 下一个候选 */
        }
    }
    return null;
}

const HOST_TOOLS = await resolveDefineTool();
const defineTool = HOST_TOOLS ? HOST_TOOLS.fn : (spec) => spec;
/** 解析到的宿主包来源（CLI `dsh-doctor where` 用它排查"工具没反应"）。 */
export const hostToolsOrigin = HOST_TOOLS ? HOST_TOOLS.from : null;
if (!HOST_TOOLS) {
    console.warn('[dsh-doctor] 未解析到宿主的 @deepseek-ai/dsh-tools；工具将以最小形状注册（测试环境下属正常）');
}

// 导出 Config 后，DSH 的设置页会自动出现一栏（title 由 cordis.patch.yml 的 label 决定）。
// Config 是纯数据的 Standard Schema 对象，不依赖 schemastery（见 lib/config.js 头部说明）。
export { Config } from './config.js';

/**
 * 必须声明依赖的服务，否则宿主在 apply 里访问 ctx.tools 会直接抛
 * `Error: cannot get property "tools" without inject`（真机日志，2026-10-22）。
 */
export const inject = ['tools'];

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
        // 两个案例库
        localCasesDir: typeof c.localCasesDir === 'string' && c.localCasesDir.trim() ? c.localCasesDir.trim() : undefined,
        sharedCasesDir: typeof c.sharedCasesDir === 'string' && c.sharedCasesDir.trim() ? c.sharedCasesDir.trim() : undefined,
        casesPrefer: c.casesPrefer === 'shared' ? 'shared' : 'local',
        allowLocalCaseWrite: c.allowLocalCaseWrite !== false,
    };
}

export function apply(ctx, config) {
    const cfg = normalizeConfig(config);
    const limits = {
        maxProfiles: cfg.maxProfiles,
        maxLogBytes: cfg.maxLogBytes,
        httpTimeoutMs: cfg.httpTimeoutMs,
    };

    // 两个案例库：共享库随包只读，本地库在 DSH_HOME 下可写（本插件唯一写点）
    const caseSources = resolveCaseSources(
        {
            localCasesDir: cfg.localCasesDir,
            sharedCasesDir: cfg.sharedCasesDir,
            casesPrefer: cfg.casesPrefer,
            allowLocalCaseWrite: cfg.allowLocalCaseWrite,
        },
        process.env,
        PACKAGE_ROOT,
    );

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

    register('contribute', {
        name: 'doctor_contribute',
        description:
            '[dsh-doctor] 一键贡献：把这次的故障写进**本地**案例库（自动脱敏），并给出**一条**可复制的上传命令 —— ' +
            '脱敏入册 → 重建索引 → 机械检查 → 提交/推送/开 PR（由 tools/contribute.mjs 在宿主外完成，插件本身不执行子进程）。',
        parameters: {
            id: { type: 'string', description: '病例编号（字母数字与 -_.，建议 local-YYYYMMDD-短名）' },
            title: { type: 'string', description: '一句话标题（症状）' },
            body: { type: 'string', description: '正文：症状 / 判定签名 / 根因 / 处置 / 验证（落盘前强制脱敏）' },
            force: { type: 'boolean', description: '覆盖同名本地病例（默认 false）' },
        },
        timeoutMs: 20000,
        async execute(args) {
            const id = String((args && args.id) || '').trim();
            const body = String((args && args.body) || '').trim();
            if (!id || !body) return '需要 id 与 body（title 可省略）。';
            const r = saveLocalCase(caseSources, { id, title: String((args && args.title) || ''), body }, { identity: localIdentity(), force: Boolean(args && args.force) });
            if (!r.ok) return `未写入：${r.reason}`;
            const script = path.join(PACKAGE_ROOT, 'tools', 'contribute.mjs');
            return [
                `已写入本地案例库：\`${r.path}\`（${r.bytes} 字节，已脱敏）`,
                '',
                '一键上传（会脱敏入册 → 重建索引 → 机械检查 → 建分支 → 推送 → 开 PR）：',
                '',
                '```',
                `node "${script}" --from "${r.path}" --pr`,
                '```',
                '',
                '只想先看会怎么做：把 `--pr` 换成 `--dry-run`。',
            ].join('\n');
        },
    });

    register('cases', {
        name: 'doctor_cases',
        description:
            '[dsh-doctor] 读取案例库：**共享库**（随包分发、只读，由作者审核合入）与**本地库**（本机沉淀、可写）。' +
            '省略 id 时列出两库索引（同名 id 本地覆盖共享）；给 id 时返回正文并标注来源。',
        parameters: {
            id: { type: 'string', description: '案例编号（如 2026-09-23-testjob-deadlock 或本地 id），省略则列索引' },
            source: { type: 'string', enum: ['all', 'local', 'shared'], description: '只列某一库（默认 all）' },
        },
        timeoutMs: 15000,
        async execute(args) {
            const identity = localIdentity();
            const id = String((args && args.id) || '').trim();
            if (!id) {
                const listing = listCases(caseSources);
                const only = String((args && args.source) || 'all');
                if (only !== 'all') {
                    listing.merged = listing.merged.filter((c) => c.source === only);
                }
                return renderCaseIndex(listing, identity);
            }
            const hit = readCase(caseSources, id);
            if (!hit) return `读不到案例 ${id}（两库都没有）。用 \`doctor_cases\`（不带 id）看索引。`;
            if (hit.error) return 'id 不合法：只允许字母、数字与 -_.（不带路径分隔符）。';
            const label = hit.source === 'local' ? '本地库' : '共享库';
            return `> 来源：**${label}**（${hit.source === 'local' ? '本机沉淀' : '随包分发'}）\n\n` + redact(hit.text, identity);
        },
    });

    register('case-add', {
        name: 'doctor_case_add',
        description:
            '[dsh-doctor] 把这次遇到的故障沉淀进**本地案例库**（唯一写操作：只写本地库目录、内容强制脱敏、默认不覆盖）。' +
            '共享库只读——要贡献给所有人，请把生成的文件开 PR 到插件仓库。',
        parameters: {
            id: { type: 'string', description: '病例编号（字母数字与 -_.，建议 local-YYYYMMDD-短名）' },
            title: { type: 'string', description: '一句话标题（症状）' },
            body: { type: 'string', description: '正文：症状 / 判定签名 / 根因 / 处置 / 验证（会先脱敏再落盘）' },
            force: { type: 'boolean', description: '为 true 时覆盖同名本地病例（默认 false）' },
        },
        timeoutMs: 20000,
        async execute(args) {
            const id = String((args && args.id) || '').trim();
            const title = String((args && args.title) || '').trim();
            const body = String((args && args.body) || '').trim();
            if (!id || !body) return '需要 id 与 body（title 可省略，默认用 id）。';
            const r = saveLocalCase(caseSources, { id, title, body }, { identity: localIdentity(), force: Boolean(args && args.force) });
            if (!r.ok) {
                const why = {
                    'bad-id': 'id 不合法：只允许字母、数字与 -_.（不带路径分隔符）。',
                    'local-write-disabled': 'config.allowLocalCaseWrite=false，本地库写入被关闭。',
                    'outside-local-dir': '目标路径离开了本地库目录，已拒绝。',
                    'empty-body': 'body 为空（脱敏后为空也算空）。',
                    exists: '同名本地病例已存在；要覆盖请传 force=true。',
                    'mkdir-failed': '无法创建本地库目录（检查 DSH_HOME 权限或 localCasesDir 配置）。',
                    'write-failed': '写入失败（磁盘/权限）。',
                }[r.reason] || r.reason;
                return `未写入：${why}`;
            }
            return `已写入本地案例库：\`${r.path}\`（${r.bytes} 字节，内容已脱敏）。\n\n想看效果：\`doctor_cases\`（不带 id）会在"本地库"分组里列出 \`${id}\`。`;
        },
    });
}
