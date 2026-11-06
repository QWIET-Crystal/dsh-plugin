/**
 * dsh-doctor / lib/findings.js —— 体检结论的统一形状：稳定 id、五级 level、判定与退出码
 *
 * 为什么要把 id 和 level 独立成模块：
 *
 * 1) **稳定 id** 是对外契约。0.1.x 的报告里只有中文散文，agent/CI 只能靠正则捞；
 *    测试也没法断言"到底是哪一条"。从 0.2.0 起每条结论都有 `AREA.CHECK.VARIANT` 形式的 id，
 *    runbook（本地）与案例库（随包）都靠它对齐，重命名文案不会破坏下游。
 *
 * 2) **`unknown` 是第五级**，也是 0.2.0 的核心修正。真机上踩到过：
 *    沙箱里 `netstat`/子进程一律拒绝访问，解析结果为空 → 每个端口都判"故障"。
 *    "我取不到证"和"我取到了、证明确实坏了"是两件事，后者才配叫 fault。
 *    因此凡是有失败可能的探测，都必须能表达 unknown，而不是静默降级成空集合。
 *
 * 判定优先级（也决定退出码）：fault(2) > unknown(3) > warn(1) > ok(0)。
 *      有确定故障时先说故障；否则"证据不全"比"有点小毛病"更需要拦住自动化流程 ——
 *      因为 unknown 意味着这份结论本身可能是错的，不该被当成绿色放行。
 */

/** 报告/JSON 契约的版本号。字段语义变化时递增。 */
export const SCHEMA_VERSION = 1;

/** 五级结论。顺序即严重度（渲染排序用）。 */
export const LEVELS = Object.freeze(['fault', 'warn', 'unknown', 'info', 'ok']);

const LEVEL_RANK = Object.freeze({ fault: 0, warn: 1, unknown: 2, info: 3, ok: 4 });

/**
 * 稳定 id 表。
 * 命名：`AREA.CHECK.VARIANT`，全大写、点分、只增不改语义（改语义就换新 id）。
 */
export const IDS = Object.freeze({
    // 发现层
    DISCOVERY_NO_HOME: 'DISCOVERY.NO_HOME',
    DISCOVERY_NO_ENGINE: 'DISCOVERY.NO_ENGINE',
    DISCOVERY_HOME_DENIED: 'DISCOVERY.HOME_DENIED',
    // 装配层
    PROFILE_NONE: 'PROFILE.NONE',
    PROFILE_BUNDLES_EMPTY: 'PROFILE.BUNDLES_EMPTY',
    PROFILE_NO_PATCH: 'PROFILE.NO_PATCH',
    PROFILE_LIMIT_REACHED: 'PROFILE.LIMIT_REACHED',
    PROFILE_LOOKS_UNINSTALLED: 'PROFILE.LOOKS_UNINSTALLED',
    // ABI 层（静态：不等出事就能预警）
    ABI_BUNDLE_MISSING: 'ABI.BUNDLE.MISSING',
    ABI_PEER_UNSATISFIED: 'ABI.PEER.UNSATISFIED',
    ABI_PEER_UNKNOWN: 'ABI.PEER.UNKNOWN',
    // 升级层
    UPGRADE_VERSION_DRIFT: 'UPGRADE.VERSION.DRIFT',
    UPGRADE_DIR_NOT_WRITABLE: 'UPGRADE.DIR.NOT_WRITABLE',
    // 引擎层
    ENGINE_DESKTOP_NO_KERNEL: 'ENGINE.DESKTOP_NO_KERNEL',
    // 端口层
    PORT_DECLARED_NOT_LISTENING: 'PORT.DECLARED.NOT_LISTENING',
    PORT_DECLARED_LISTENING: 'PORT.DECLARED.LISTENING',
    PORT_UNDECLARED_LISTENING: 'PORT.UNDECLARED.LISTENING',
    PORT_NO_DECLARATION: 'PORT.NO_DECLARATION',
    PORT_PROBE_UNKNOWN: 'PORT.PROBE.UNKNOWN',
    PORT_HOST_NOT_LISTENING: 'PORT.HOST.NOT_LISTENING',
    PORT_ALL_HOSTS_DOWN: 'PORT.ALL_HOSTS.DOWN',
    // 日志层
    LOG_ABI_INCOMPATIBLE: 'LOG.ABI.INCOMPATIBLE',
    LOG_SERVICE_REMOVED: 'LOG.SERVICE.REMOVED',
    LOG_ENTRY_NOT_ACTIVATED: 'LOG.ENTRY.NOT_ACTIVATED',
    LOG_PLUGINS_LOAD_FAILED: 'LOG.PLUGINS.LOAD_FAILED',
    LOG_GPU_CRASH: 'LOG.GPU.CRASH',
    LOG_DESKTOP_UNCLEAN_EXIT: 'LOG.DESKTOP.UNCLEAN_EXIT',
    LOG_SUPPLYCHAIN_RELEASE_AGE: 'LOG.SUPPLYCHAIN.RELEASE_AGE',
    LOG_UPGRADE_NATIVE_BUSY: 'LOG.UPGRADE.NATIVE_BUSY',
    LOG_SCAN_DENIED: 'LOG.SCAN.DENIED',
    // 历史层
    RUNS_SAVE_FAILED: 'RUNS.SAVE_FAILED',
    // 贡献层
    CASE_CONTRIBUTE_SUGGESTED: 'CASE.CONTRIBUTE.SUGGESTED',
});

/**
 * 造一条结论。
 *
 * @param {string} id      稳定 id（用 IDS.*）
 * @param {string} level   fault | warn | unknown | info | ok
 * @param {string} area    人看的分组名（插件/端口/装配……）
 * @param {string} text    人看的一句话
 * @param {object} [extra] { evidence?:string[], caseId?:string, fix?:string[], runbook?:string, meta?:object }
 */
export function finding(id, level, area, text, extra = {}) {
    return {
        id: String(id),
        level: LEVELS.includes(level) ? level : 'info',
        area: String(area),
        text: String(text),
        evidence: Array.isArray(extra.evidence) ? extra.evidence.filter(Boolean).map(String) : [],
        // 指向随包案例库的 id（docs/cases/<id>.md）；null 表示"库里还没有这条"
        caseId: extra.caseId ? String(extra.caseId) : null,
        // 可直接复制的处置命令（来自病例的「## 处置命令」块；没有就空数组）
        fix: Array.isArray(extra.fix) ? extra.fix.filter(Boolean).map(String) : [],
        // 本地 runbook 锚点：只在作者本机有意义，对外用户点不到，保留做内部对齐
        runbook: extra.runbook ? String(extra.runbook) : null,
        meta: extra.meta && typeof extra.meta === 'object' ? extra.meta : undefined,
    };
}

/** 按严重度排序（同严重度保持原顺序）。 */
export function sortFindings(findings) {
    return findings
        .map((f, i) => ({ f, i }))
        .sort((a, b) => (LEVEL_RANK[a.f.level] - LEVEL_RANK[b.f.level]) || (a.i - b.i))
        .map((x) => x.f);
}

/** 计数。 */
export function summarize(findings) {
    const out = { fault: 0, warn: 0, unknown: 0, info: 0, ok: 0, total: findings.length };
    for (const f of findings) {
        if (out[f.level] === undefined) out.info += 1;
        else out[f.level] += 1;
    }
    return out;
}

/**
 * 判定：fault > unknown > warn > ok。
 * 注意 info/ok 不参与判定（它们是上下文，不是结论）。
 */
export function verdictOf(summary) {
    if (summary.fault > 0) return 'fault';
    if (summary.unknown > 0) return 'unknown';
    if (summary.warn > 0) return 'warn';
    return 'ok';
}

/** 判定 → 退出码：fault 2 / unknown 3 / warn 1 / ok 0。 */
export function exitCodeOf(verdict) {
    return { fault: 2, unknown: 3, warn: 1, ok: 0 }[verdict] ?? 0;
}

/** 一句话判定文案（CLI 与报告共用）。 */
export function verdictText(summary, verdict) {
    const { fault, warn, unknown } = summary;
    if (verdict === 'fault') {
        const tail = [];
        if (warn) tail.push(`${warn} 项注意`);
        if (unknown) tail.push(`${unknown} 项无法取证`);
        return `**有 ${fault} 项真故障**` + (tail.length ? `、${tail.join('、')}` : '');
    }
    if (verdict === 'unknown') {
        return `**无法完整取证**（${unknown} 项探测失败${warn ? `；另有 ${warn} 项注意` : ''}）—— 本报告的"正常"结论不可信`;
    }
    if (verdict === 'warn') return `无真故障，${warn} 项注意`;
    return '**全绿**';
}
