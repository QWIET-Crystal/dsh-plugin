#!/usr/bin/env node
/**
 * dsh-doctor / tools/index-cases.mjs —— 只重建 docs/cases/INDEX.md（不碰案例正文）
 *
 * 为什么需要它：docs/cases 现在是**共享库的源**（PR 直接改这里），
 * 而 tools/build-cases.mjs 是从本机事故归档"生成"案例的一次性 bootstrap。
 * 用生成器重建索引会把手工/PR 加入的案例冲掉，所以索引单独由本脚本维护。
 *
 * 标题/摘要/类型的解析都放在 lib/cases.js 里，便于单测（真机上摘要列曾经因为
 * 少了 `m` 标志而**全部显示 "—"**，静默错了一版）。
 *
 * 用法：node tools/index-cases.mjs [案例目录]
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { caseSummary, caseTitle, extractKind, isCaseFile } from '../lib/cases.js';

const DIR = process.argv[2] || path.join(import.meta.dirname, '..', 'docs', 'cases');
const OUT = path.join(DIR, 'INDEX.md');

function main() {
    let names = [];
    try {
        names = readdirSync(DIR).filter(isCaseFile).sort();
    } catch (e) {
        console.error(`[index-cases] 读不到目录：${DIR}（${e && e.code}）`);
        process.exit(2);
    }
    const rows = names.map((name) => {
        const file = path.join(DIR, name);
        const md = readFileSync(file, 'utf8');
        return {
            id: name.replace(/\.md$/, ''),
            title: caseTitle(md),
            summary: caseSummary(md),
            kind: extractKind(md) || 'runtime',
            kb: (statSync(file).size / 1024).toFixed(1),
        };
    });
    const index = [
        '# 案例库（脱敏）',
        '',
        '> 全部由真实故障归档机械脱敏生成；后续新增通过 PR 合入。',
        '> 每条案例的结构统一为 **症状 → 判定签名 → 根因 → 处置 → 验证**，可直接对照现场取证。',
        '> **类型**：`runtime` = DSH 运行期故障（必须有判定签名）；`authoring` = 插件/工具开发时踩的坑。缺省为 `runtime`。',
        '> 用 `doctor_cases` 工具按编号读取单条；`doctor_cases --search 关键词` 做全文检索。',
        '> 索引由 `node tools/index-cases.mjs` 维护；机械检查用 `node tools/lint-cases.mjs`。',
        '',
        '| 编号 | 类型 | 标题 | 根因摘要 |',
        '| --- | --- | --- | --- |',
        ...rows.map((r) => `| \`${r.id}\` | ${r.kind} | ${r.title} | ${r.summary} |`),
        '',
        `共 ${rows.length} 条。`,
        '',
    ].join('\n');
    writeFileSync(OUT, index, 'utf8');
    console.log(`[index-cases] 写入 ${rows.length} 条 → ${OUT}`);
}

main();
