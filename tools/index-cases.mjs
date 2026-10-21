#!/usr/bin/env node
/**
 * dsh-doctor / tools/index-cases.mjs —— 只重建 docs/cases/INDEX.md（不碰案例正文）
 *
 * 为什么需要它：docs/cases 现在是**共享库的源**（PR 直接改这里），
 * 而 tools/build-cases.mjs 是从本机事故归档"生成"案例的一次性 bootstrap。
 * 用生成器重建索引会把手工/PR 加入的案例冲掉，所以索引单独由本脚本维护。
 *
 * 用法：node tools/index-cases.mjs [案例目录]
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DIR = process.argv[2] || path.join(import.meta.dirname, '..', 'docs', 'cases');
const OUT = path.join(DIR, 'INDEX.md');

function firstHeading(md) {
    const m = md.match(/^#\s+(.+)$/m);
    return m ? m[1].trim() : '(无标题)';
}

function summaryLine(md) {
    // 优先取"根因"段的第一行；没有就退回"处置"
    for (const label of ['根因', '处置', '原因', '对策']) {
        const re = new RegExp(`(?:^##+\\s*${label}[^\\n]*\\n+|\\*\\*${label}\\*\\*[：:]?\\s*)([^\\n\\r]+)`);
        const m = md.match(re);
        if (m) return m[1].replace(/[`*|]/g, '').trim().slice(0, 90);
    }
    return '—';
}

function main() {
    let names = [];
    try {
        names = readdirSync(DIR).filter((n) => n.endsWith('.md') && n !== 'INDEX.md').sort();
    } catch (e) {
        console.error(`[index-cases] 读不到目录：${DIR}（${e && e.code}）`);
        process.exit(2);
    }
    const rows = names.map((name) => {
        const file = path.join(DIR, name);
        const md = readFileSync(file, 'utf8');
        return {
            id: name.replace(/\.md$/, ''),
            title: firstHeading(md),
            summary: summaryLine(md),
            kb: (statSync(file).size / 1024).toFixed(1),
        };
    });
    const index = [
        '# 案例库（脱敏）',
        '',
        '> 全部由真实故障归档机械脱敏生成；后续新增通过 PR 合入。',
        '> 每条案例的结构统一为 **症状 → 判定签名 → 根因 → 处置 → 验证**，可直接对照现场取证。',
        '> 用 `doctor_cases` 工具按编号读取单条。',
        '> 索引由 `node tools/index-cases.mjs` 维护；机械检查用 `node tools/lint-cases.mjs`。',
        '',
        '| 编号 | 标题 | 根因摘要 |',
        '| --- | --- | --- |',
        ...rows.map((r) => `| \`${r.id}\` | ${r.title} | ${r.summary} |`),
        '',
        `共 ${rows.length} 条。`,
        '',
    ].join('\n');
    writeFileSync(OUT, index, 'utf8');
    console.log(`[index-cases] 写入 ${rows.length} 条 → ${OUT}`);
}

main();
