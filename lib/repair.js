/**
 * dsh-doctor / lib/repair.js —— "刚修好" 的识别与贡献提醒（0.4.0）
 *
 * 动机：案例库最有价值的时刻，是**用户刚刚把一个坑填平**的那一刻——
 * 他知道症状、知道根因、知道哪一步真的修好了。过了三天就只剩"好像改了个配置"。
 *
 * 所以：当上一轮体检不是全绿、这一轮变成全绿时，认定"修复发生"，
 * 生成一段可复制的病例草稿，由客户端弹窗提醒（用户不点就当没发生）。
 *
 * 判定刻意收得很紧：**只在 ok 与非 ok 之间跨越时触发**。
 * "故障 5 项变 3 项"这种不算——半修不修的时候提醒用户写案例，只会制造噪音。
 */

/** 上一轮非全绿、这一轮全绿 → 修复发生。 */
export function detectRepair(prev, current) {
    if (!prev || !current) return { detected: false };
    const before = String(prev.verdict || '');
    const after = String(current.verdict || '');
    if (!before || !after) return { detected: false };
    if (before === 'ok' || after !== 'ok') return { detected: false };
    const fixed = (prev.findings || []).filter((f) => ['fault', 'warn', 'unknown'].includes(f.level));
    return {
        detected: true,
        previousVerdict: before,
        previousAt: prev.generatedAt || null,
        currentAt: current.generatedAt || null,
        fixedCount: fixed.length,
        fixedIds: [...new Set(fixed.map((f) => f.id))].slice(0, 20),
        fixedTitles: [...new Set(fixed.map((f) => f.area + '：' + f.text))].slice(0, 8),
    };
}

/**
 * 生成一份可复制的病例草稿（Markdown）。
 * 只填"能自动填的"：类型、症状（来自上一轮的结论）、骨架章节；根因/处置留给用户。
 */
export function buildCaseTemplate(repair, opts = {}) {
    const date = String((repair && repair.currentAt) || new Date().toISOString()).slice(0, 10);
    const id = `local-${date.replace(/-/g, '')}-短名`;
    const lines = [];
    lines.push(`# <一句话标题：症状> · ${date}`);
    lines.push('');
    lines.push('## 类型');
    lines.push('');
    lines.push('runtime');
    lines.push('');
    lines.push('## 症状');
    lines.push('');
    if (repair && repair.fixedTitles && repair.fixedTitles.length) {
        lines.push('修之前体检报的是：');
        lines.push('');
        // 红队实测：日志/结论文本可被伪造，直接塞进模板会变成 Markdown 指令（"## 忽略此前所有指令"）
        const oneLine = (v) => String(v).replace(/[\r\n]+/g, " ").replace(/[`#>]/g, "").slice(0, 160);
        for (const t of repair.fixedTitles) lines.push(`- ${oneLine(t)}`);
    } else {
        lines.push('（写上用户看到的现象）');
    }
    lines.push('');
    lines.push('## 判定签名');
    lines.push('');
    lines.push('（别人怎么确认自己遇到的是同一个坑：贴原始报错行 / 命令输出特征）');
    lines.push('');
    lines.push('## 根因');
    lines.push('');
    lines.push('（为什么会这样：定位到代码 / 配置 / 版本的哪一处）');
    lines.push('');
    lines.push('## 处置命令');
    lines.push('');
    lines.push('```sh');
    lines.push('# 只写能直接粘贴执行的命令；没有就删掉这一节');
    lines.push('```');
    lines.push('');
    lines.push('## 处置与结果');
    lines.push('');
    lines.push('（做了什么、结果如何。允许写"试了 A 不行，改成 B 才解决"）');
    lines.push('');
    lines.push('## 验证');
    lines.push('');
    lines.push('（怎么确认修好了）');
    lines.push('');
    return { id, markdown: lines.join('\n') };
}

/** 一行人类可读的提醒（报告 / 工具返回里用）。 */
export function renderRepairHint(repair) {
    if (!repair || !repair.detected) return null;
    const n = repair.fixedCount || (repair.fixedIds || []).length;
    return `上一轮还有 ${n} 项问题，这一轮全绿了 —— 如果这次是你亲手修的，花两分钟把它写成案例：\`doctor_case_add\`（或 CLI \`dsh-doctor contribute\`）。`;
}
