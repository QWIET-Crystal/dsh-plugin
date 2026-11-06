/**
 * dsh-doctor / lib/repairs.js —— 修复计划（0.5.0）
 *
 * 核心约定：**修复动作是数据，不是代码**。
 *
 * 这样做的三个理由：
 *   1) 急救包的执行器只需要一个百来行的解释器（无 node 也能修）；
 *   2) 计划可以被备份、被回放、被单测，出问题时能说清"它到底做了什么"；
 *   3) 动作类型是**枚举白名单**——急救包的输入包含日志、配置、用户填的内容，
 *      一旦允许"跑任意命令行"，等于把"修 DSH"变成"任意代码执行"。
 *
 * 风险分层（来自需求确认）：
 *   A 零风险 → 一键全做（启动没在跑的服务）
 *   B 需确认 → 逐条问（禁用点名的坏插件、还原配置）
 *   C 高危/破坏性 → 只出文字指路，永不产动作（改 ACL、重装内核、截断会话）
 */

import path from 'node:path';

import { safeReadText } from './safety.js';

export const ACTION_TYPES = Object.freeze(['start-service', 'disable-plugin-entry', 'restore-file', 'open-dir']);

/** 只有出现在日志里、且能解析出名字的插件才允许"禁用"——不靠 mtime 猜。 */
function pluginNameFrom(finding) {
    const meta = finding && finding.meta;
    return meta && typeof meta.plugin === 'string' && meta.plugin.trim() ? meta.plugin.trim() : null;
}

/**
 * 由一次体检结论生成修复计划。
 *
 * @param {object} payload  buildCheckPayload 的结果
 * @param {object} [ctx]    { patchFiles?: [{profile, path, text}] }
 * @returns {{actions:object[], notes:object[], summary:object}}
 */
export function buildRepairPlan(payload, ctx = {}) {
    const findings = (payload && payload.findings) || [];
    const actions = [];
    const notes = [];
    const seen = new Set();
    const push = (a) => {
        const key = a.type + ':' + JSON.stringify(a.params || {});
        if (seen.has(key)) return;
        seen.add(key);
        actions.push(a);
    };

    // ---- A 类：服务没在跑 → 启动它 ----
    for (const f of findings) {
        const port = f.meta && f.meta.port;
        if (f.id === 'PORT.HOST.NOT_LISTENING' || f.id === 'PORT.ALL_HOSTS.DOWN') {
            const ports = f.id === 'PORT.ALL_HOSTS.DOWN' ? (f.meta && f.meta.ports) || [] : [port];
            for (const p of ports) {
                const service = p === 43120 ? 'desktop' : p === 3080 ? 'web' : null;
                if (!service) continue;
                push({
                    id: `${service}`,
                    type: 'start-service',
                    risk: 'A',
                    title: service === 'web' ? '启动网页端（:3080）' : '启动桌面端（:43120）',
                    why: `体检发现 ${p} 没在监听，而本机确实装了对应宿主`,
                    params: { service },
                    verify: { kind: 'port', port: p, timeoutMs: 30000 },
                });
            }
        }
    }

    // ---- B 类：日志点名的坏插件 → 在 patch 里禁用那一条 ----
    const BAD_PLUGIN_IDS = new Set(['LOG.ABI.INCOMPATIBLE', 'LOG.PLUGINS_LOAD_FAILED', 'LOG.SERVICE.REMOVED']);
    for (const f of findings) {
        if (!BAD_PLUGIN_IDS.has(f.id)) continue;
        const name = pluginNameFrom(f);
        if (!name) continue; // 没有点名就不动手（不做"最近改过"的猜测）
        const target = (ctx.patchFiles || []).find((p) => typeof p.text === 'string' && entryLineRegex(name).test(p.text));
        if (!target) {
            notes.push({
                risk: 'C',
                title: `禁止启动时加载 ${name}`,
                why: '日志点名了这个插件，但没能在任何 profile 的 cordis.patch.yml 里找到它的条目，需要人工确认它装在哪',
            });
            continue;
        }
        push({
            id: `disable-${name}`,
            type: 'disable-plugin-entry',
            risk: 'B',
            title: `禁用插件 ${name}`,
            why: `宿主日志点名它加载失败（${f.text.slice(0, 60)}）`,
            params: { file: target.path, entryId: name, profile: target.profile },
            verify: { kind: 'file-contains', file: target.path, contains: 'disabled: true' },
        });
    }

    // ---- C 类：只给指路，不给动作 ----
    for (const f of findings) {
        if (String(f.id).startsWith('SESSION.')) {
            notes.push({
                risk: 'C',
                title: '会话内容可能已损坏',
                why: `${f.text}。这类问题要改会话文件，急救包不做自动动作`,
                caseId: f.caseId || '2026-11-06-reasoning-repetition-collapse',
            });
        }
    }

    const summary = {
        total: actions.length,
        A: actions.filter((a) => a.risk === 'A').length,
        B: actions.filter((a) => a.risk === 'B').length,
        notes: notes.length,
    };
    return { actions, notes, summary };
}

function entryLineRegex(name) {
    const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^\\s*-\\s*id:\\s*['"]?${esc}['"]?\\s*$`, 'm');
}

/** 收集所有 profile 的 cordis.patch.yml 原文（修复计划要在这里找条目）。 */
export function collectPatchFiles(discovery) {
    const out = [];
    for (const home of (discovery && discovery.homes) || []) {
        if (home.error) continue;
        for (const p of home.profiles || []) {
            const file = path.join(p.dir, 'cordis.patch.yml');
            const r = safeReadText(file, { roots: [p.dir], maxBytes: 512 * 1024 });
            if (r.ok) out.push({ profile: p.name, path: file, text: r.text });
        }
    }
    return out;
}

/** 人类可读的计划（CLI 不传 --json 时用）。 */
export function renderRepairPlan(plan) {
    const lines = [];
    lines.push('# 修复计划');
    lines.push('');
    if (plan.actions.length === 0 && plan.notes.length === 0) {
        lines.push('没有需要修复的项。');
        return lines.join('\n');
    }
    for (const risk of ['A', 'B']) {
        const group = plan.actions.filter((a) => a.risk === risk);
        if (group.length === 0) continue;
        lines.push(`## ${risk === 'A' ? 'A 类（零风险，可一键执行）' : 'B 类（需逐条确认）'}`);
        lines.push('');
        for (const a of group) {
            lines.push(`- [${a.risk}] ${a.title} —— ${a.why}`);
        }
        lines.push('');
    }
    if (plan.notes.length) {
        lines.push('## 需要人工处理（不自动执行）');
        lines.push('');
        for (const n of plan.notes) lines.push(`- ${n.title}：${n.why}${n.caseId ? `（案例 ${n.caseId}）` : ''}`);
        lines.push('');
    }
    return lines.join('\n');
}
