#!/usr/bin/env node
/**
 * dsh-doctor / tools/contribute.mjs —— 一条命令完成"脱敏 → 入册 → 索引 → 校验 → 提交 → 推送 → 开 PR"
 *
 * 为什么做成 CLI 而不是插件工具：
 *   插件运行在宿主里，宿主挂了插件也不在；而"贡献病例"最常发生在刚修完故障的时候。
 *   所以上传链路放在**脱离宿主**的 CLI 里，插件只负责生成草稿（见 doctor_contribute 工具）。
 *
 * 用法：
 *   node tools/contribute.mjs --from <病例.md> [选项]
 *   node tools/contribute.mjs --from -            # 从 stdin 读
 *
 * 选项：
 *   --id <YYYY-MM-DD-slug>   病例编号（默认从 --from 文件名或标题推导）
 *   --title <一句话标题>      覆盖正文里的标题
 *   --repo <目录>             仓库工作副本（默认本包根目录）
 *   --dry-run                只演算，不落盘、不提交
 *   --no-push                只提交，不推送
 *   --pr                     建分支 + 推送 + 开 PR（需要 gh 已登录）
 *   --force                  允许覆盖已存在的同名病例
 *   --json                   机器可读输出
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { localIdentity, redact, stripControl } from '../lib/safety.js';

const ROOT_DEFAULT = path.join(import.meta.dirname, '..');

function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('--')) {
            out._.push(arg);
            continue;
        }
        const key = arg.slice(2);
        if (['dry-run', 'no-push', 'pr', 'force', 'json', 'help'].includes(key)) out[key] = true;
        else out[key] = argv[++i];
    }
    return out;
}

function run(cmd, args, opts = {}) {
    try {
        const stdout = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
        return { ok: true, stdout: String(stdout).trim() };
    } catch (e) {
        return { ok: false, stdout: String(e.stdout || '').trim(), stderr: String(e.stderr || e.message || '').trim(), code: e.status ?? 1 };
    }
}

/** 把任意事故文档整理成病例骨架：缺哪节报哪节，不猜内容。 */
export function toCaseDoc(raw, { id, title }) {
    const text = stripControl(String(raw || '')).trim();
    if (!text) return { ok: false, reason: 'empty-source' };
    const missing = [];
    for (const heading of ['症状', '根因', '处置', '验证']) {
        const re = new RegExp(`(?:^##+\\s*${heading}|\\*\\*${heading}\\*\\*|\\*\\*${heading}[（(])`, 'm');
        if (!re.test(text)) missing.push(heading);
    }
    if (!/^#\s+/m.test(text) && !title) missing.push('标题');
    if (missing.length) return { ok: false, reason: 'missing-sections', missing };

    let body = text;
    if (title) {
        body = /^#\s+/m.test(body) ? body.replace(/^#\s+.*$/m, `# ${title}`) : `# ${title}\n\n${body}`;
    }
    if (!/^##\s*判定签名/m.test(body) && /^##\s*根因/m.test(body)) {
        body = body.replace(/^##\s*根因/m, '## 判定签名\n\n（待补：怎么稳定识别这是同一个坑）\n\n## 根因');
    }
    return { ok: true, body: body.trim() + '\n', id };
}

/** 脱敏：本机身份 + 盘符路径 + 主机名形态。 */
export function scrub(text, identity = localIdentity(), workspace = 'D:\\DSH') {
    let out = redact(stripControl(text), identity);
    const ws = workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(ws + '(\\\\[^\\s`"\'\\)\\]]*)?', 'gi'), '<workspace>$1');
    out = out.replace(/\b([A-Za-z]):\\(?:[^\s`"')\]:]+\\?)+/g, (m) => {
        const leaf = m.split('\\').filter(Boolean).pop() || '';
        return '<path>' + (leaf ? '\\' + leaf : '');
    });
    return out;
}

function deriveId(args, sourcePath, body) {
    if (args.id) return String(args.id);
    const stem = sourcePath && sourcePath !== '-' ? path.basename(sourcePath, '.md') : '';
    const date = new Date().toISOString().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}-[a-z0-9.-]+$/.test(stem)) return stem;
    const h = String(body).match(/^#\s+(.+)$/m);
    const slug = (h ? h[1] : stem || 'case')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'case';
    // 中文标题转不了 slug 时退回日期 + 序号
    const safeSlug = /^[a-z0-9-]+$/.test(slug) ? slug : 'plugin-issue';
    return `${date}-${safeSlug}`;
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const repo = path.resolve(args.repo || ROOT_DEFAULT);
    const casesDir = path.join(repo, 'docs', 'cases');
    const workspace = process.env.DSH_WORKSPACE || 'D:\\DSH';
    const json = (obj) => {
        if (args.json) console.log(JSON.stringify(obj, null, 2));
        else for (const [k, v] of Object.entries(obj)) if (v !== undefined) console.log(`  ${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
    };

    if (args.help) {
        console.log(readFileSync(new URL(import.meta.url)).toString().split('\n').slice(1, 30).join('\n'));
        return 0;
    }
    if (!args.from) {
        json({ ok: false, reason: 'missing --from（病例源文件，或 - 表示 stdin）' });
        return 2;
    }

    let raw;
    const source = String(args.from);
    if (source === '-') raw = readFileSync(0, 'utf8');
    else if (existsSync(source)) raw = readFileSync(source, 'utf8');
    else {
        json({ ok: false, reason: `找不到源文件: ${source}` });
        return 2;
    }

    const id = deriveId(args, source, raw);
    const built = toCaseDoc(scrub(raw, localIdentity(), workspace), { id, title: args.title });
    if (!built.ok) {
        json({ ok: false, reason: built.reason, missing: built.missing, hint: '病例需要 症状 / 根因 / 处置 / 验证（判定签名可自动补空节）' });
        return 2;
    }
    const target = path.join(casesDir, `${id}.md`);
    if (existsSync(target) && !args.force) {
        json({ ok: false, reason: `已存在同名病例（加 --force 覆盖）: ${path.relative(repo, target)}` });
        return 2;
    }

    const steps = [];
    if (args['dry-run']) {
        json({ ok: true, mode: 'dry-run', repo: path.relative(process.cwd(), repo) || '.', id, target: path.relative(repo, target), bytes: Buffer.byteLength(built.body), head: built.body.split('\n').slice(0, 3).join(' / ') });
        return 0;
    }

    mkdirSync(casesDir, { recursive: true });
    writeFileSync(target, built.body, 'utf8');
    steps.push(`写入 ${path.relative(repo, target)}（${Buffer.byteLength(built.body)} 字节，已脱敏）`);

    const index = run('node', [path.join(repo, 'tools', 'index-cases.mjs')], { cwd: repo });
    steps.push(index.ok ? '重建索引 OK' : `重建索引失败: ${index.stderr || index.stdout}`);
    if (!index.ok) {
        json({ ok: false, steps, reason: 'index-failed' });
        return 1;
    }

    const lint = run('node', [path.join(repo, 'tools', 'lint-cases.mjs')], { cwd: repo });
    steps.push(lint.ok ? '机械检查通过' : `机械检查未通过:\n${lint.stdout}\n${lint.stderr}`);
    if (!lint.ok) {
        json({ ok: false, steps, reason: 'lint-failed' });
        return 1;
    }

    const add = run('git', ['add', 'docs/cases'], { cwd: repo });
    if (!add.ok) {
        json({ ok: false, steps, reason: 'git-add-failed', stderr: add.stderr });
        return 1;
    }
    const inRepo = run('git', ['rev-parse', '--show-toplevel'], { cwd: repo });
    if (!inRepo.ok) {
        json({ ok: false, steps, reason: 'not-a-git-repo', repo: path.relative(process.cwd(), repo) });
        return 1;
    }
    const commit = run('git', ['commit', '-m', `case: ${id}`, '-m', '来源：dsh-doctor 一键贡献（已脱敏；机械检查通过）'], { cwd: repo });
    steps.push(commit.ok ? '已提交' : `提交失败（可能无改动）: ${commit.stderr || commit.stdout}`);

    const branch = `case/${id}`;
    if (args.pr) {
        const co = run('git', ['checkout', '-b', branch], { cwd: repo });
        steps.push(co.ok ? `新建分支 ${branch}` : `建分支失败: ${co.stderr}`);
        const push = run('git', ['push', '-u', 'origin', branch], { cwd: repo });
        steps.push(push.ok ? '已推送' : `推送失败: ${push.stderr}`);
        if (push.ok) {
            const pr = run('gh', ['pr', 'create', '--title', `case: ${id}`, '--body', `新增病例 \`${id}\`（脱敏 + 机械检查通过）。\n\n- 症状/判定签名/根因/处置/验证 齐全\n- 生成方式：dsh-doctor 一键贡献`, '--base', 'main', '--head', branch], { cwd: repo });
            steps.push(pr.ok ? `PR: ${pr.stdout}` : `开 PR 失败: ${pr.stderr}`);
            json({ ok: pr.ok, steps, pr: pr.ok ? pr.stdout : undefined });
            return pr.ok ? 0 : 1;
        }
        json({ ok: false, steps });
        return 1;
    }

    if (!args['no-push']) {
        const push = run('git', ['push', 'origin', 'HEAD'], { cwd: repo });
        steps.push(push.ok ? '已推送' : `推送失败: ${push.stderr}`);
        json({ ok: push.ok, steps });
        return push.ok ? 0 : 1;
    }

    json({ ok: true, steps, next: '未推送（--no-push）。要开 PR：node tools/contribute.mjs --from <源> --pr' });
    return 0;
}

import { fileURLToPath } from 'node:url';

const IS_MAIN = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (IS_MAIN) process.exitCode = main();
