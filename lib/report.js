/**
 * dsh-doctor / lib/report.js —— 分层取证与渲染（只读；不执行任何东西）
 *
 * 每一层独立取证，不因为上一层健康就跳过下一层——这条教训来自本机 2026-09-23/24 那批事故：
 *   HTTP 有应答 ≠ 服务还在；端口在听 ≠ 插件加载成功；进程在 ≠ 会话没卡死。
 */

import path from 'node:path';
import { readdirSync } from 'node:fs';

import { discover } from './detect.js';
import { DEFAULT_LIMITS, fenceText, localIdentity, oneLine, redact, safeReadText } from './safety.js';

/** 已知故障签名 → 对策库章节（名字与 runbook 保持一致，插件报告可直接跳）。 */
export const LOG_SIGNATURES = [
    { re: /disabling profile plugin row "([^"]+)"[^\n]*incompatible with dsh ([0-9][^\s:]*)/i, level: 'fault', area: '插件', text: (m) => `插件 ${m[1]} 与内核 ${m[2]} 不兼容，已被禁用`, runbook: '#插件与内核 ABI 不符' },
    { re: /waiting for service: ([A-Za-z0-9_.\-]+)/i, level: 'warn', area: '插件', text: (m) => `有插件在等已被内核删除的服务：${m[1]}（会永久 pending）`, runbook: '#插件等已删除的服务' },
    { re: /warning: (\d+) entr(?:y|ies) did not activate/i, level: 'warn', area: '插件', text: (m) => `${m[1]} 个插件条目未激活`, runbook: '#插件等已删除的服务' },
    { re: /Failed to load plugins/i, level: 'fault', area: '插件', text: () => '整个插件树加载失败', runbook: '#插件与内核 ABI 不符' },
    { re: /child process gone[^\n]*type:\s*GPU/i, level: 'warn', area: '渲染', text: () => 'GPU 子进程崩溃，渲染可能已回退到软件渲染', runbook: '#GPU进程崩溃' },
    { re: /previous desktop run did not shut down cleanly[^\n]*/i, level: 'info', area: '历史', text: () => '上次桌面端非正常退出（历史上下文，非当前故障）', runbook: '#外壳崩溃' },
    { re: /ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION/i, level: 'warn', area: '插件安装', text: () => '插件安装被供应链冷却期（minimumReleaseAge）挡下', runbook: '#插件等已删除的服务' },
    { re: /errno:?\s*-4082|EBUSY[^\n]*libvips/i, level: 'warn', area: '升级', text: () => '升级时原生库被占用（宿主没停）', runbook: '#桌面升级需提权' },
];

function finding(level, area, text, runbook) {
    return { level, area, text, runbook: runbook || null };
}

/** 扫描桌面端日志（白名单限定在该目录内），返回命中的签名。 */
export function scanDesktopLogs(env, limits) {
    const out = { hits: [], scanned: [], warnings: [] };
    const dir = path.join(env.APPDATA || path.join(env.USERPROFILE || '', 'AppData', 'Roaming'), 'DSH Desktop', 'logs');
    let names = [];
    try {
        names = readdirSync(dir).filter((n) => /^dsh-.*\.log$/.test(n)).sort();
    } catch {
        out.warnings.push('桌面端日志目录不存在或不可读（非桌面端宿主正常）');
        return out;
    }
    // 只看最近 2 个文件，且按字节上限读；不遍历历史
    for (const name of names.slice(-2)) {
        const file = path.join(dir, name);
        const r = safeReadText(file, { roots: [dir], maxBytes: limits.maxLogBytes });
        if (!r.ok) {
            out.warnings.push(`日志 ${name} 读取失败：${r.reason}`);
            continue;
        }
        out.scanned.push({ file: name, bytes: r.bytes, truncated: r.truncated });
        // 只扫"最近一次启动"之后的日志：否则修好之后历史行还会反复报警（误报比不报更糟）
        const marker = 'host outbound proxy policy installed';
        const cut = r.text.lastIndexOf(marker);
        const currentRun = cut >= 0 ? r.text.slice(cut) : r.text;
        const lines = currentRun.split(/\r?\n/);
        for (const line of lines) {
            for (const sig of LOG_SIGNATURES) {
                const m = line.match(sig.re);
                if (m) out.hits.push({ ...finding(sig.level, sig.area, sig.text(m), sig.runbook), evidence: oneLine(line, 240) });
            }
        }
    }
    return out;
}

/** 汇总一个实例的体检结论（纯计算，不做 I/O）。 */
export function collectFindings(discovery, logScan) {
    const findings = [];
    if (discovery.homes.length === 0) findings.push(finding('warn', '发现', '没找到任何 DSH_HOME', '#前端进程死亡'));
    for (const home of discovery.homes) {
        if (home.profileCount === 0) findings.push(finding('warn', 'profile', `${home.dir} 下没有任何 profile`, '#前端进程死亡'));
        for (const p of home.profiles) {
            if (p.bundles.length === 0) findings.push(finding('warn', 'profile', `profile ${p.name} 的 bundles 为空（插件不会加载）`, '#插件与内核 ABI 不符'));
            if (!p.hasPatch) findings.push(finding('info', 'profile', `profile ${p.name} 没有 cordis.patch.yml（用默认装配）`, null));
        }
    }
    for (const e of discovery.engines) {
        if (e.kind === 'desktop' && !e.kernelVersion) findings.push(finding('info', '引擎', `桌面端 ${e.version} 没找到内置内核包（可能是精简安装）`, null));
    }
    const openPorts = new Set(discovery.running.map((r) => r.port));
    const declared = new Set(discovery.declaredPorts);
    // 声明了却没在听 → 注意；声明了在听 → 正常
    for (const port of declared) {
        if (!openPorts.has(port)) findings.push(finding('warn', '运行', `profile 声明的端口 ${port} 没在监听`, '#前端进程死亡'));
        else findings.push(finding('ok', '运行', `端口 ${port} 在监听（profile 声明）`, null));
    }
    // 在听但没声明 → 信息（可能是别的程序，或端口写在别处；不当故障）
    for (const port of openPorts) {
        if (!declared.has(port)) findings.push(finding('info', '运行', `端口 ${port} 在听，但没有 profile 声明它（可能属于别的程序）`, null));
    }
    if (declared.size === 0) {
        findings.push(finding('info', '运行', '没有任何 profile 声明端口 —— 已按常见默认端口探测（见引擎清单的端口段）', null));
    }
    // 日志命中：同名签名只报一次（最近一次的证据）
    const seen = new Set();
    for (const hit of logScan.hits) {
        const key = hit.area + '|' + hit.text;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push(finding(hit.level, hit.area, hit.text, hit.runbook));
    }
    return findings;
}

function levelTag(level) {
    return { fault: '故障', warn: '注意', ok: '正常', info: '信息' }[level] || '信息';
}

/** 常见宿主的默认端口（启发式标签；不据此断定归属，只帮人认端口）。 */
export const PORT_LABELS = {
    3080: '网页端 DSH 常用默认端口',
    43120: '桌面端 DSH 常用默认端口',
    19372: '桌宠 harness 常用默认端口',
    3081: '网页端备用端口',
    8080: '通用 HTTP 端口（可能被其它程序占用）',
};

/** 渲染"引擎清单"（供 doctor_engines 工具返回）。 */
export function renderEngines(discovery, identity = localIdentity()) {
    const lines = [];
    lines.push(`# DSH 引擎清单（${discovery.generatedAt}）`);
    lines.push('');
    lines.push(`- 平台：${discovery.platform} · Node ${discovery.node}`);
    lines.push(`- DSH_HOME 数量：${discovery.homes.length} · 引擎安装：${discovery.engines.length} · 在监听端口：${discovery.running.length}`);
    lines.push('');
    lines.push('## DSH_HOME 与 profile');
    if (discovery.homes.length === 0) lines.push('_（无）_');
    for (const home of discovery.homes) {
        lines.push(`- \`${redact(home.dir, identity)}\` —— ${home.profileCount} 个 profile`);
        for (const p of home.profiles) {
            lines.push(`  - **${p.name}**：${p.bundles.length} 个 bundle / ${p.deps.length} 个依赖${p.declaredPorts.length ? ' / 端口 ' + p.declaredPorts.join(',') : ''}`);
        }
    }
    lines.push('');
    lines.push('## 引擎安装');
    if (discovery.engines.length === 0) lines.push('_（无）_');
    for (const e of discovery.engines) {
        lines.push(`- [${e.kind}] **${e.label}**${e.kernelVersion ? ' · 内核 ' + e.kernelVersion : ''} —— \`${redact(e.path, identity)}\``);
    }
    lines.push('');
    lines.push('## 端口');
    lines.push(discovery.probedPorts
        .map((p) => {
            const label = PORT_LABELS[p.port] ? `（${PORT_LABELS[p.port]}）` : '';
            return `- ${p.port}${label}: ${p.open ? '在听 ' + p.ms + 'ms' : '未监听'}`;
        })
        .join('\n'));
    if (discovery.warnings.length) {
        lines.push('');
        lines.push('## 提示');
        for (const w of discovery.warnings) lines.push('- ' + w);
    }
    return lines.join('\n');
}

/** 渲染完整体检报告（供 doctor_check 工具返回）。 */
export function renderReport(discovery, findings, logScan, identity = localIdentity()) {
    const order = { fault: 0, warn: 1, info: 2, ok: 3 };
    const sorted = [...findings].sort((a, b) => (order[a.level] ?? 9) - (order[b.level] ?? 9));
    const faults = findings.filter((f) => f.level === 'fault');
    const warns = findings.filter((f) => f.level === 'warn');
    const lines = [];
    lines.push(`# DSH 体检报告（${discovery.generatedAt}）`);
    lines.push('');
    const scanned = logScan.scanned || [];
    const scanLine = scanned.length
        ? `已扫描 ${scanned.length} 个文件：` + scanned.map((s) => `${s.file}${s.truncated ? '(截断)' : ''} ${s.bytes}B`).join('、')
        : `**未扫描**（${(logScan.warnings && logScan.warnings[0]) || '没有可读的桌面端日志'}）`;
    lines.push(`- 扫描日志：${scanLine}`);
    lines.push(`- 判定：${faults.length ? `**有 ${faults.length} 项真故障**、${warns.length} 项注意` : warns.length ? `无真故障，${warns.length} 项注意` : '**全绿**'}`);
    lines.push('');
    for (const f of sorted) {
        const rb = f.runbook ? `  → 对策库 ${f.runbook}` : '';
        lines.push(`- [${levelTag(f.level)}] ${f.area}：${redact(f.text, identity)}${rb}`);
    }
    if (logScan.hits.length) {
        lines.push('');
        lines.push('## 证据（原始日志行，已脱敏、已围栏化）');
        const uniq = [];
        const seen = new Set();
        for (const h of logScan.hits) {
            if (seen.has(h.evidence)) continue;
            seen.add(h.evidence);
            uniq.push(h);
        }
        for (const h of uniq.slice(0, 8)) lines.push(fenceText(redact(h.evidence, identity), { lang: 'text' }));
    }
    const notes = (logScan.warnings || []).filter(Boolean);
    if (notes.length) {
        lines.push('');
        lines.push('## 提示');
        for (const n of notes) lines.push('- ' + redact(n, identity));
    }
    return lines.join('\n');
}

export { DEFAULT_LIMITS, discover };
