#!/usr/bin/env node
/**
 * dsh-doctor / tools/build-cases.mjs —— 从本机事故归档生成**脱敏**案例库
 *
 * 用法：node tools/build-cases.mjs [源目录] [输出目录]
 *   默认源：D:\DSH\_ops\incidents    默认输出：<包>/docs/cases
 *
 * 脱敏规则（可复现，不手抄）：
 *   - 走 lib/safety.js 的 redact()：用户名/主机名/用户主目录/临时目录/疑似令牌
 *   - 额外把工作区绝对路径与盘符路径收敛成占位符
 *   - 去掉模板文件（文件名以 _ 开头）
 * 生成物：docs/cases/<原名>.md + docs/cases/INDEX.md
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { localIdentity, redact, stripControl } from '../lib/safety.js';

const SRC = process.argv[2] || 'D:\\DSH\\_ops\\incidents';
const DST = process.argv[3] || path.join(import.meta.dirname, '..', 'docs', 'cases');
const IDENT = localIdentity();
const WORKSPACE = path.resolve(process.argv[4] || 'D:\\DSH');

/** 再收一遍绝对路径：Windows 盘符路径 → <path>，工作区 → <workspace>。 */
function scrubPaths(text) {
    let s = text;
    const ws = WORKSPACE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp(ws + '(\\\\[^\\s`"\'\\)\\]]*)?', 'gi'), '<workspace>$1');
    // 剩余盘符路径（保留文件名可读性：只替换到最后一个分隔符之前）
    s = s.replace(/\b([A-Za-z]):\\(?:[^\s`"')\]:]+\\?)+/g, (m) => {
        const parts = m.split('\\').filter(Boolean);
        const leaf = parts.length > 1 ? parts[parts.length - 1] : '';
        return '<path>' + (leaf ? '\\' + leaf : '');
    });
    return s;
}

function caseId(name) {
    return name.replace(/\.md$/i, '');
}

function firstHeading(md) {
    const m = md.match(/^#\s+(.+)$/m);
    return m ? m[1].trim() : '(无标题)';
}

function pickLine(md, label) {
    const re = new RegExp('\\*\\*' + label + '\\*\\*[：:]?\\s*(.+)');
    const m = md.match(re);
    return m ? m[1].replace(/[`*]/g, '').trim().slice(0, 80) : '';
}

function main() {
    let files = [];
    try {
        files = readdirSync(SRC).filter((f) => f.toLowerCase().endsWith('.md') && !f.startsWith('_'));
    } catch (e) {
        console.error('[build-cases] 源目录不可读：' + SRC + '（' + (e && e.code) + '）');
        process.exit(2);
    }
    if (files.length === 0) {
        console.error('[build-cases] 源目录里没有可用的 .md');
        process.exit(2);
    }
    mkdirSync(DST, { recursive: true });
    const rows = [];
    for (const f of files.sort()) {
        const raw = readFileSync(path.join(SRC, f), 'utf8');
        const cleaned = scrubPaths(redact(stripControl(raw), IDENT)).trim() + '\n';
        const id = caseId(f);
        writeFileSync(path.join(DST, id + '.md'), cleaned, 'utf8');
        rows.push({
            id,
            title: firstHeading(cleaned),
            symptom: pickLine(cleaned, '症状'),
            cause: pickLine(cleaned, '根因'),
        });
    }
    const index = [
        '# 案例库（脱敏）',
        '',
        '> 全部由本机真实故障归档机械脱敏生成：路径、主机名、用户名与疑似令牌已替换为占位符。',
        '> 每条案例的结构统一为 **症状 → 判定签名 → 根因 → 处置 → 验证**，可直接对照现场取证。',
        '> 用 `doctor_cases` 工具按编号读取单条。',
        '',
        '| 编号 | 标题 | 根因摘要 |',
        '| --- | --- | --- |',
        ...rows.map((r) => `| \`${r.id}\` | ${r.title} | ${r.cause || '—'} |`),
        '',
        `共 ${rows.length} 条。`,
        '',
    ].join('\n');
    writeFileSync(path.join(DST, 'INDEX.md'), index, 'utf8');
    console.log(`[build-cases] 生成 ${rows.length} 条案例 → ${DST}`);
    for (const r of rows) console.log('  - ' + r.id + ' :: ' + r.title);
}

main();
