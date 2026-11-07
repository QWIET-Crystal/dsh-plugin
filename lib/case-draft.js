/**
 * dsh-doctor / lib/case-draft.js —— 从一条体检结论直接起草病例（0.5.1）
 *
 * 动机：写病例最贵的一步不是"写"，是**从零回忆**。
 * 而体检结论里已经有三节现成的素材：
 *   症状 = 结论原文；判定签名 = finding id + 怎么复核；处置命令 = fix[]。
 * 所以让用户从"一条结论"出发，而不是从空白模板出发。
 *
 * 隐私：只搬运 finding 里**已经脱敏过**的文本，不读会话正文、不读原始日志行。
 */

const LEVEL_LABEL = { fault: '故障', warn: '注意', unknown: '无法取证', info: '信息', ok: '正常' };

function slugOf(id) {
    return String(id || 'finding')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'finding';
}

function today(now) {
    const d = now ? new Date(now) : new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 由一条 finding 生成病例草稿。
 *
 * @param {object} finding  payload.findings 里的一条
 * @param {object} [opts]   { generatedAt, now }
 * @returns {{id:string, filename:string, title:string, markdown:string}}
 */
export function draftCaseFromFinding(finding, opts = {}) {
    if (!finding || !finding.id) throw new Error('需要一条带 id 的 finding');
    const date = today(opts.now || opts.generatedAt);
    const id = `local-${date.replace(/-/g, '')}-${slugOf(finding.id)}`;
    const title = `[${LEVEL_LABEL[finding.level] || finding.level}] ${finding.area || ''}：${String(finding.text || '').slice(0, 40)}`;

    const lines = [];
    lines.push(`# ${title} · ${date}`);
    lines.push('');
    lines.push('## 类型');
    lines.push('');
    lines.push('runtime');
    lines.push('');
    lines.push('## 症状');
    lines.push('');
    lines.push(String(finding.text || '').trim() || '（补一句你实际看到的现象）');
    lines.push('');
    lines.push(`- 体检级别：\`${finding.level}\`，区域：${finding.area || '—'}`);
    lines.push(`- 结论 id：\`${finding.id}\``);
    if (finding.caseId) lines.push(`- 关联案例：\`${finding.caseId}\``);
    if (opts.generatedAt) lines.push(`- 发现时间：${opts.generatedAt}`);
    lines.push('');
    lines.push('## 判定签名');
    lines.push('');
    lines.push('别人怎么确认自己遇到的是同一个坑：重跑一次体检，输出里应出现同一条结论 id。');
    lines.push('');
    lines.push('```sh');
    lines.push('dsh-doctor check');
    lines.push('```');
    lines.push('');
    lines.push('如果现象是间歇性的，补一句"在什么条件下必现"——这比 id 更有用。');
    lines.push('');
    lines.push('## 根因');
    lines.push('');
    lines.push('（为什么会这样：定位到代码 / 配置 / 版本的哪一处。不允许写"大概是"。）');
    lines.push('');

    const fix = (finding.fix || []).filter((c) => typeof c === 'string' && c.trim());
    if (fix.length) {
        lines.push('## 处置命令');
        lines.push('');
        lines.push('```sh');
        for (const c of fix.slice(0, 6)) lines.push(c.trim());
        lines.push('```');
        lines.push('');
    }

    lines.push('## 处置与结果');
    lines.push('');
    lines.push('（做了什么、结果如何。允许写"试了 A 不行，改成 B 才解决"。）');
    lines.push('');
    lines.push('## 验证');
    lines.push('');
    lines.push(`（怎么确认修好了：体检不再出现 \`${finding.id}\`，且原本的现象消失。）`);
    lines.push('');
    return { id, filename: `${id}.md`, title, markdown: lines.join('\n') };
}
