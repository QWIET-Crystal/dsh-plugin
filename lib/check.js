/**
 * dsh-doctor / lib/check.js —— 一轮体检的完整流程（工具、CLI、面板共用同一条路径）
 *
 * 0.1.x 里这段逻辑抄了两份（index.js 的工具里一份、bin/dsh-doctor.mjs 里一份），
 * 很快就开始漂移。0.2.0 收敛到这里：发现 → 取证 → 汇总 → 打包 → （可选）记历史。
 *
 * 唯一的副作用是"记历史"，而且：
 *   - 由 `saveRuns` 显式控制（默认开，可关）；
 *   - 写失败只追加一条 info，**不改变结论**（取证不能因为"记不住"而失败）。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { commandsForCase, resolveCaseSources } from './cases.js';
import { discover, probeDirWritable } from './detect.js';
import { IDS, finding } from './findings.js';
import { buildCheckPayload, collectFindings, redactPayload, scanDesktopLogs } from './report.js';
import { buildCaseTemplate, detectRepair, renderRepairHint } from './repair.js';
import { readLatestRun, resolveRunsDir, saveRun } from './runs.js';
import { DEFAULT_LIMITS } from './safety.js';

const PACKAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const SKIPPED_LOG_SCAN = {
    hits: [],
    scanned: [],
    warnings: ['已跳过日志扫描（deep=false）'],
    capability: { ok: true, reason: 'skipped' },
};

/**
 * 跑一轮体检。
 *
 * @param {object} [options]
 * @param {object} [options.discovery] 已发现的结果（宿主里配合缓存用；不传就自己 discover）
 * @param {boolean} [options.deep=true] 是否扫桌面端日志
 * @param {object} [options.env]       环境变量（测试注入用）
 * @param {object} [options.limits]    上限
 * @param {number[]} [options.ports]   要探测的端口
 * @param {boolean} [options.saveRuns=false] 是否记历史
 * @param {string} [options.runsDir]   历史目录
 * @param {number} [options.retention] 保留条数
 * @param {number} [options.throttleMs] 同内容去重窗口
 * @returns {Promise<object>} 结构化 payload（见 report.buildCheckPayload）
 */
export async function runCheck(options = {}) {
    const env = options.env || process.env;
    const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
    let discovery = options.discovery || (await discover({ env, limits, ports: options.ports }));

    // 写权限真探针：只有显式打开才跑（它是写操作）。结果挂到 discovery 上，由 report 纯函数消费。
    if (options.deepWriteProbe) {
        const probed = [];
        for (const e of discovery.engines || []) {
            if (e.kind !== 'desktop' || !e.dir) continue;
            probed.push(probeDirWritable(e.dir));
        }
        discovery = { ...discovery, writeProbe: probed };
    }

    const deep = options.deep !== false;
    const logScan = deep ? scanDesktopLogs(env, limits) : SKIPPED_LOG_SCAN;
    const findings = collectFindings(discovery, logScan);

    // 给每条结论挂上"复制即用"的处置命令：只从病例的 `## 处置命令` 章节取，不猜
    const caseSources = options.caseSources || resolveCaseSources(options.caseConfig || {}, env, PACKAGE_ROOT);
    const fixCache = new Map();
    for (const f of findings) {
        if (!f.caseId) continue;
        if (!fixCache.has(f.caseId)) fixCache.set(f.caseId, commandsForCase(caseSources, f.caseId));
        const cmds = fixCache.get(f.caseId);
        if (cmds.length) f.fix = cmds.slice(0, 4);
    }

    const history = { enabled: Boolean(options.saveRuns), saved: false, skipped: false, ok: null, reason: null, dir: null, path: null };

    // ---- 修复识别：上一轮不是全绿、这一轮全绿 → 提醒把这次的坑写成案例 ----
    // 需要历史，所以只在 saveRuns 时做（CLI --no-save 就没有"上一轮"可比）
    let repair = { detected: false };
    if (options.saveRuns) {
        const dir = options.runsDir || resolveRunsDir(env);
        const prevRun = readLatestRun(dir);
        repair = detectRepair(prevRun, buildCheckPayload(discovery, findings, logScan));
        if (repair.detected) {
            // 草稿也一起生成：客户端弹窗直接"复制模板"，不需要它自己拼一份（单一实现）
            const tpl = buildCaseTemplate(repair);
            repair.templateId = tpl.id;
            repair.template = tpl.markdown;
            findings.push(
                finding(IDS.CASE_CONTRIBUTE_SUGGESTED, 'info', '案例', renderRepairHint(repair), {
                    meta: { repair },
                }),
            );
        }
    }

    if (options.saveRuns) {
        const dir = options.runsDir || resolveRunsDir(env);
        history.dir = dir;
        // 先按"还没失败"的内容算 hash：即使这次写失败，重复调用也不会每次都重试写
        const probePayload = buildCheckPayload(discovery, findings, logScan);
        // 同内容判定只看结论本身（generatedAt / 端口耗时每次都变，不能进 hash）
        const hashSource = {
            findings: probePayload.findings.map((f) => ({ id: f.id, level: f.level, area: f.area, text: f.text })),
            summary: probePayload.summary,
            verdict: probePayload.verdict,
        };
        const r = saveRun(dir, redactPayload(probePayload), { retention: options.retention, throttleMs: options.throttleMs, hashSource });
        history.ok = Boolean(r.ok);
        history.saved = Boolean(r.ok && !r.skipped);
        history.skipped = Boolean(r.ok && r.skipped);
        history.reason = r.reason || null;
        history.path = r.path || null;
        if (!r.ok) {
            // 降级成一条 info：结论不变，但用户知道"这次没记上"
            findings.push(
                finding(IDS.RUNS_SAVE_FAILED, 'info', '历史', `这次没能记进体检历史（${r.reason}）—— 结论不受影响`, {
                    meta: { reason: r.reason, dir },
                }),
            );
        }
    }

    const payload = buildCheckPayload(discovery, findings, logScan);
    payload.history = history;
    payload.repair = repair;
    return payload;
}
