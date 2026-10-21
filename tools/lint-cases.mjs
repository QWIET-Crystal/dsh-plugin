#!/usr/bin/env node
/**
 * dsh-doctor / tools/lint-cases.mjs —— 共享案例库的机械检查（可为 PR 做 CI）
 *
 * 检查项（任何一条不过 → 退出码 1）：
 *   1. 文件名：YYYY-MM-DD-短名.md（小写字母数字与 -）
 *   2. 必备章节：症状 / 根因 / 处置 / 验证（判定签名可选，缺了只警告）
 *   3. 指纹泄漏：本机用户名、主机名、用户主目录、令牌形态、URL userinfo
 *   4. 体积：500 B ~ 40 KB（太短多半没写清，太大该拆文件）
 *   5. 索引一致性：每个案例都在 INDEX.md 里；INDEX.md 里也没有指向不存在文件的条目
 *
 * 只读：不修改任何文件，退出码即结论。用法：
 *   node tools/lint-cases.mjs [案例目录]
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const DIR = process.argv[2] || path.join(import.meta.dirname, '..', 'docs', 'cases');
// 允许 a.b 这种版本号片段（历史案例里有 2.0.4-to-2.0.17）
const FILE_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:[.-][a-z0-9]+)*\.md$/;
const MIN_BYTES = 500;
const MAX_BYTES = 40 * 1024;

/**
 * 概念组 → 可接受的标签写法。
 * 案例既可能用 `## 症状`，也可能用 `**症状**`（历史归档就是后者），两种都算。
 */
const CONCEPTS = {
    症状: ['症状', '现象'],
    根因: ['根因', '原因', '成因'],
    处置: ['处置', '对策', '修复', '处理'],
    验证: ['验证', '复核', '确认'],
    判定签名: ['判定签名', '判据', '认证签名'],
};

function hasConcept(text, names) {
    for (const n of names) {
        const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`^##+\\s*${esc}`, 'm').test(text)) return true;
        if (new RegExp(`\\*\\*${esc}\\*\\*`).test(text)) return true;
        if (new RegExp(`\\*\\*${esc}[（(][^*]*\\*\\*`).test(text)) return true; // **现象（用户视角的一句话）**
        if (new RegExp(`^\\s*[-*]\\s*\\*\\*${esc}`, 'm').test(text)) return true;
    }
    return false;
}

/** 指纹形态（宁可误报，也不要让真实身份泄出去）。 */
const FINGERPRINTS = [
    { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, why: 'GitHub 令牌' },
    { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/, why: 'GitHub PAT' },
    { re: /\bsk-[A-Za-z0-9_-]{16,}\b/, why: 'API key（sk-）' },
    { re: /\bAKIA[0-9A-Z]{16}\b/, why: 'AWS key' },
    { re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/, why: 'Authorization 头' },
    { re: /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i, why: 'URL 里的 userinfo' },
    { re: /C:\\Users\\[A-Za-z0-9._-]+/i, why: 'Windows 用户主目录' },
    { re: /\/(?:home|Users)\/[A-Za-z0-9._-]+\//, why: 'Unix 用户主目录' },
    { re: /\bLAPTOP-[A-Z0-9]{6,}\b/i, why: 'Windows 主机名形态' },
];

function rel(p) {
    return path.relative(DIR, p);
}

function main() {
    let names = [];
    try {
        names = readdirSync(DIR).filter((n) => n.endsWith('.md') && n !== 'INDEX.md').sort();
    } catch (e) {
        console.error(`[lint-cases] 读不到案例目录：${DIR}（${e && e.code}）`);
        process.exit(2);
    }
    const problems = [];
    const warnings = [];
    const ids = new Set();

    for (const name of names) {
        const file = path.join(DIR, name);
        const id = name.replace(/\.md$/, '');
        ids.add(id);
        const st = statSync(file);
        if (!FILE_RE.test(name)) problems.push(`${name}：文件名不符合 YYYY-MM-DD-短名.md`);
        if (st.size < MIN_BYTES) problems.push(`${name}：只有 ${st.size} B，太短（< ${MIN_BYTES} B），多半没写清`);
        if (st.size > MAX_BYTES) problems.push(`${name}：${(st.size / 1024).toFixed(1)} KB 超上限（> 40 KB），该拆文件`);

        const text = readFileSync(file, 'utf8');
        // 硬要求：必须有"症状/现象"，并且至少两项后续（根因/处置/验证）
        const hit = Object.fromEntries(Object.entries(CONCEPTS).map(([k, names]) => [k, hasConcept(text, names)]));
        if (!hit['症状']) problems.push(`${name}：缺「症状/现象」（案例至少要说清看到了什么）`);
        const followUps = ['根因', '处置', '验证'].filter((k) => hit[k]);
        if (followUps.length < 2) problems.push(`${name}：后续内容不足（根因/处置/验证 至少写两项，当前只有 ${followUps.join('、') || '0 项'}）`);
        if (!hit['判定签名']) warnings.push(`${name}：没有「判定签名/判据」章节（可选，但强烈建议——否则别人难判断是不是同一个坑）`);
        for (const { re, why } of FINGERPRINTS) {
            const m = text.match(re);
            if (m) problems.push(`${name}：疑似指纹泄漏（${why}）：${m[0].slice(0, 40)}…`);
        }
    }

    // 索引一致性
    const indexPath = path.join(DIR, 'INDEX.md');
    let indexText = '';
    try {
        indexText = readFileSync(indexPath, 'utf8');
    } catch {
        problems.push('缺 INDEX.md（用 node tools/build-cases.mjs 生成）');
    }
    if (indexText) {
        for (const id of ids) {
            if (!indexText.includes(id)) problems.push(`INDEX.md 里没有列出 ${id}`);
        }
        for (const m of indexText.matchAll(/`(\d{4}-\d{2}-\d{2}-[a-z0-9-]+)`/g)) {
            if (!ids.has(m[1])) problems.push(`INDEX.md 引用了不存在的案例 ${m[1]}`);
        }
    }

    // 汇总
    console.log(`[lint-cases] 目录 ${DIR}`);
    console.log(`[lint-cases] 案例 ${ids.size} 条；问题 ${problems.length} 条；警告 ${warnings.length} 条`);
    for (const w of warnings) console.log(`  ⚠️  ${w}`);
    for (const p of problems) console.log(`  ❌  ${p}`);
    if (problems.length === 0) {
        console.log('[lint-cases] ✅ 通过');
        process.exit(0);
    }
    console.error('[lint-cases] 机械检查未通过：修完再提 PR（人只需要审语义）');
    process.exit(1);
}

main();
