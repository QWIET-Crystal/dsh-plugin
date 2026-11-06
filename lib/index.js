/**
 * dsh-doctor / lib/index.js —— 插件入口：注册六个诊断工具
 *
 * 工具面（0.2.0 起六个，取证类全部只读）：
 *   doctor_engines    自动发现本机所有 DSH 引擎/实例/profile（含正在监听的端口）
 *   doctor_check      分层体检，返回**结构化对象**（渲染仍是 Markdown）
 *   doctor_runs       读体检历史（回答"什么时候开始坏的"）
 *   doctor_cases      读两个案例库（共享库随包只读 / 本地库可写）
 *   doctor_case_add   把故障沉淀进本地案例库（写点①）
 *   doctor_contribute 写本地草稿并给出上传命令（写点①）
 *
 * 安全边界（结构性保证，不靠"小心"）：本插件不 import child_process/vm/eval，
 * 不监听端口；读文件一律经 safety.safeReadText（白名单 + 上限 + 截断标注）。
 * 写只有两处，且都可关：本地案例库（allowLocalCaseWrite）、体检历史（saveRuns）。
 */

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.join(HERE, '..');

import { listCases, readCase, renderCaseIndex, renderCaseSearch, resolveCaseSources, saveLocalCase, searchCases } from './cases.js';
import { runCheck } from './check.js';
import { discover } from './detect.js';
import { renderEngines, renderPayload } from './report.js';
import { registerReportRoute } from './http.js';
import { exportKit } from './kit.js';
import { listRuns, readRun, renderRuns, resolveRunsDir } from './runs.js';
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
if (!HOST_TOOLS && process.env.DSH_DOCTOR_QUIET !== '1') {
    console.warn('[dsh-doctor] 未解析到宿主的 @deepseek-ai/dsh-tools；工具将以最小形状注册（测试环境下属正常）');
}

// 导出 Config 后，DSH 的设置页会自动出现一栏（title 由 cordis.patch.yml 的 label 决定）。
// Config 是纯数据的 Standard Schema 对象，不依赖 schemastery（见 lib/config.js 头部说明）。
export { Config } from './config.js';

/**
 * 必须声明依赖的服务，否则宿主在 apply 里访问 ctx.tools 会直接抛
 * `Error: cannot get property "tools" without inject`（真机日志，2026-10-22）。
 *
 * 0.2.0 补上 `webServer`：设置页「体检」页要读自己的路由，而 cordis 对**未声明的服务**
 * 一律抛错（不是返回 undefined）。之前只声明了 tools，`ctx.webServer` 被 try/catch 吞掉，
 * 于是路由静默没注册、面板一直显示降级页 —— 真机重启时才发现。
 */
export const inject = ['tools', 'webServer'];

const textOutput = Object.freeze({
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
});

/**
 * doctor_check 的输出契约：**结构化对象**（0.2.0）。
 *
 * 0.1.x 只返回 Markdown 字符串，agent 想用就得解析散文。改成对象后：
 *   - `render` 仍然吐同一份 Markdown —— 人看到的观感不变；
 *   - agent 可以直接读 `findings[].id / level / caseId / fix`；
 *   - CLI `--json` 与工具返回**同一份形状**，契约只有一处定义。
 *
 * ⚠️ 宿主对 `output.schema` 用的是**值 schema DSL**，不是完整 JSON Schema（真机踩过）：
 *   - 不支持 `required`（报 `schema.required is not supported by the value schema DSL`）；
 *   - **每个 object 节点**都必须显式写 `additionalProperties: true|false`
 *     （少了会报 `schema.additionalProperties must be explicitly true or false`）。
 * 所以这里刻意不写 required —— 必填字段靠 render/消费方自己容错。
 */
const checkOutput = Object.freeze({
    schema: {
        type: 'object',
        properties: {
            schemaVersion: { type: 'number', description: '报告契约版本' },
            generatedAt: { type: 'string', description: '本次取证时间（ISO）' },
            environment: { type: 'object', description: '平台 / Node / 主机名 / DSH_HOME', additionalProperties: true },
            discovery: { type: 'object', description: '发现层原始数据（homes/engines/端口/能力账本）', additionalProperties: true },
            logScan: { type: 'object', description: '日志层：扫了哪些文件、有什么提示', additionalProperties: true },
            findings: {
                type: 'array',
                description: '结论数组，每条含 id / level(fault|warn|unknown|info|ok) / area / text / caseId / fix',
                items: { type: 'object', description: '单条结论', additionalProperties: true },
            },
            summary: { type: 'object', description: '五级计数', additionalProperties: true },
            verdict: { type: 'string', enum: ['fault', 'warn', 'unknown', 'ok'], description: '判定' },
            exitCode: { type: 'number', description: '对应退出码：fault=2 / unknown=3 / warn=1 / ok=0' },
            history: { type: 'object', description: '本次是否记进历史（runs/）', additionalProperties: true },
        },
        additionalProperties: true,
    },
    render: (_args, value) => [{ type: 'text', text: renderPayload(value, localIdentity()) }],
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
        // 体检历史（0.2.0 的第二个写点；saveRuns=false 就回到纯只读）
        saveRuns: c.saveRuns !== false,
        runsRetention: int(c.runsRetention, 30, 1, 500),
        runsDir: typeof c.runsDir === 'string' && c.runsDir.trim() ? c.runsDir.trim() : undefined,
        // 写权限真探针（默认关：它是写操作）
        deepWriteProbe: c.deepWriteProbe === true,
        // 会话头部小徽章（默认开；设 false 就隐藏）
        headerBadge: c.headerBadge !== false,
        // 会话层检查（0.5.0）：默认只扫最近一个会话的尾部；deepSessions 放宽到 24h
        sessionScan: c.sessionScan !== false,
        deepSessions: c.deepSessions === true,
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
            // 允许单个工具自带输出契约（doctor_check 是结构化对象，其余仍是字符串）
            output: spec.output || textOutput,
            isConcurrencySafe: () => true,
        });
        return ctx.effect(() => ctx.tools.register(tool), 'dsh-doctor:' + key);
    };

    // 历史目录：只写**当前宿主自己**的 DSH_HOME（写别人的 home 是越界）
    const runsDir = resolveRunsDir(process.env, cfg.runsDir);

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
            '[dsh-doctor] 分层体检：端口（纯 TCP）/ profile 装配 / 桌面端日志签名，返回**结构化结论**（findings 带稳定 id、' +
            'level 为 fault|warn|unknown|info|ok、caseId 指向随包案例库），同时可直接按 Markdown 阅读。' +
            '取不到证时给 unknown 而不是故障；日志行先脱敏再围栏化。',
        parameters: {
            refresh: { type: 'boolean', description: '为 true 时跳过缓存重新扫描（默认 false）' },
            deep: { type: 'boolean', description: '为 true 时额外扫描桌面端最近两个日志文件（默认 true）' },
            sessionDeep: { type: 'boolean', description: '为 true 时把会话扫描放宽到最近 24 小时内所有会话（默认只扫最近一个的尾部）' },
        },
        timeoutMs: 45000,
        output: checkOutput,
        async execute(args) {
            const deep = args && args.deep === false ? false : true;
            const d = await getDiscovery(Boolean(args && args.refresh));
            return runCheck({
                discovery: d,
                deep,
                env: process.env,
                limits,
                saveRuns: cfg.saveRuns,
                runsDir,
                retention: cfg.runsRetention,
                throttleMs: cfg.cacheTtlMs,
                deepWriteProbe: cfg.deepWriteProbe,
                sessionScan: cfg.sessionScan,
                deepSessions: Boolean(args && args.sessionDeep) || cfg.deepSessions,
            });
        },
    });

    register('runs', {
        name: 'doctor_runs',
        description:
            '[dsh-doctor] 读体检历史（`$DSH_HOME/dsh-doctor/runs/`，只写宿主自己那份）。' +
            '不带 name 时列最近的若干条（时间 / 判定 / 计数）；带 name 时返回一条完整结论。' +
            '用途：回答"什么时候开始坏的"——只读，不触发新的体检。',
        parameters: {
            limit: { type: 'number', description: '最多列多少条（默认 30，上限 500）' },
            name: { type: 'string', description: '历史文件名（如 2026-11-06T12-45-00-123Z-0a1b2c3d.json）；给了就返回该条完整结论' },
        },
        timeoutMs: 15000,
        async execute(args) {
            const identity = localIdentity();
            const name = String((args && args.name) || '').trim();
            if (name) {
                const hit = readRun(runsDir, name);
                if (!hit.ok) return `读不到历史 \`${name}\`（${hit.reason}）。用不带 name 的 \`doctor_runs\` 看清单。`;
                return `> 来源：\`${redact(hit.path, identity)}\`\n\n` + '```json\n' + hit.text.slice(0, 200 * 1024) + '\n```';
            }
            const limit = Number((args && args.limit) || 30);
            if (!cfg.saveRuns) {
                return [
                    '# 体检历史',
                    '',
                    '`config.saveRuns=false`：历史记录被关闭，本插件回到纯只读。',
                    '想启用就在设置页把「保存体检历史」打开（或把 saveRuns 设为 true）。',
                ].join('\n');
            }
            const runs = listRuns(runsDir, Number.isFinite(limit) ? limit : 30);
            return renderRuns(runs, runsDir, (p) => redact(String(p), identity));
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
            kind: { type: 'string', enum: ['runtime', 'authoring'], description: '案例类型：runtime=DSH 运行期故障（缺省）；authoring=插件/工具开发时踩的坑' },
            force: { type: 'boolean', description: '覆盖同名本地病例（默认 false）' },
        },
        timeoutMs: 20000,
        async execute(args) {
            const id = String((args && args.id) || '').trim();
            const body = String((args && args.body) || '').trim();
            if (!id || !body) return '需要 id 与 body（title 可省略）。';
            const r = saveLocalCase(caseSources, { id, title: String((args && args.title) || ''), body, kind: args && args.kind }, { identity: localIdentity(), force: Boolean(args && args.force) });
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
            '省略参数时列出两库索引（同名 id 本地覆盖共享）；给 `id` 时返回正文并标注来源；给 `search` 时做全文检索' +
            '（多个关键词要求同时出现，结果带命中片段）。',
        parameters: {
            id: { type: 'string', description: '案例编号（如 2026-09-23-testjob-deadlock 或本地 id），省略则列索引' },
            search: { type: 'string', description: '全文检索关键词（空格分隔多个词，要求同时出现）' },
            source: { type: 'string', enum: ['all', 'local', 'shared'], description: '只列某一库（默认 all）' },
        },
        timeoutMs: 15000,
        async execute(args) {
            const identity = localIdentity();
            const id = String((args && args.id) || '').trim();
            const search = String((args && args.search) || '').trim();
            if (!id && search) {
                return renderCaseSearch(searchCases(caseSources, search), identity);
            }
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
            kind: { type: 'string', enum: ['runtime', 'authoring'], description: '案例类型：runtime=DSH 运行期故障（缺省）；authoring=插件/工具开发时踩的坑' },
            force: { type: 'boolean', description: '为 true 时覆盖同名本地病例（默认 false）' },
        },
        timeoutMs: 20000,
        async execute(args) {
            const id = String((args && args.id) || '').trim();
            const title = String((args && args.title) || '').trim();
            const body = String((args && args.body) || '').trim();
            if (!id || !body) return '需要 id 与 body（title 可省略，默认用 id）。';
            const r = saveLocalCase(caseSources, { id, title, body, kind: args && args.kind }, { identity: localIdentity(), force: Boolean(args && args.force) });
            if (!r.ok) {
                const why = {
                    'bad-id': 'id 不合法：只允许字母、数字与 -_.（不带路径分隔符）。',
                    'bad-kind': 'kind 只能是 runtime 或 authoring。',
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

    register('kit', {
        name: 'doctor_export_kit',
        description:
            '[dsh-doctor] 导出**急救包**到指定目录：宿主全部崩溃、Agent 也不在场时，人双击「急救.cmd」就能体检并拉起服务。' +
            '急救包 = ASCII 门铃 .cmd + 带 BOM 的中文 PowerShell 菜单 + 内置副本 + kit.json（薄启动器会优先用插件目录里的最新代码）。',
        parameters: {
            to: { type: 'string', description: '导出目录（绝对路径；建议桌面或固定目录，便于以后找到）' },
        },
        timeoutMs: 30000,
        async execute(args) {
            const to = String((args && args.to) || '').trim();
            if (!to) return '需要 to（导出目录的绝对路径），例如 `C:\\Users\\你\\Desktop\\DSH急救`。';
            const r = exportKit(to, { packageRoot: PACKAGE_ROOT });
            if (!r.ok) {
                const why = {
                    'templates-missing': '包内 templates 缺失（安装不完整？）',
                    'cmd-not-ascii': '门铃 .cmd 里出现了非 ASCII 字符（cmd.exe 会按 GBK 解成乱码命令）',
                    'package-json-missing': '读不到 package.json',
                    'mkdir-failed': '无法创建导出目录（权限/路径）',
                }[r.reason] || r.reason;
                return `未导出：${why}`;
            }
            return [
                `急救包已导出：\`${r.dir}\``,
                '',
                `- 双击：\`${r.entry}\``,
                `- 文件：${r.files.length} 个，共 ${(r.bytes / 1024).toFixed(1)} KB`,
                `- 版本：急救包 v${r.kit.kitVersion} / 插件 ${r.kit.pluginVersion}`,
                '',
                '它做三件事：体检并出 HTML 报告 → 按数字拉起网页端/桌面端 → 打开日志与配置目录。',
                '**不改配置、不删文件、不执行看不见的动作**；每一步都会先打印再问。',
            ].join('\n');
        },
    });

    // 设置页「体检」的数据源：宿主提供 webServer 时注册路由；没有就返回 null（页面降级为复制命令）
    registerReportRoute(ctx, {
        runsDir,
        // 客户端靠 GET 返回的 ui 字段决定要不要显示头部徽章（客户端模块拿不到插件 config）
        ui: { headerBadge: cfg.headerBadge },
        checkOptions: {
            env: process.env,
            limits,
            saveRuns: cfg.saveRuns,
            retention: cfg.runsRetention,
            throttleMs: cfg.cacheTtlMs,
            deepWriteProbe: cfg.deepWriteProbe,
        },
    });
}
