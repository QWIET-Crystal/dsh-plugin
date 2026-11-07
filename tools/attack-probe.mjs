/**
 * 攻防探针（0.5.1）—— 跑一遍，看每条攻击是否被拦。
 *
 * 只读仓库、只写临时目录，跑完即删；不碰真实会话与配置。
 * 用法：node tools/attack-probe.mjs    （最后一行 ALL-BLOCKED 表示全部被拦）
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { scanSessions, parseEvents } from '../lib/sessions.js';
import { createReportHandler } from '../lib/http.js';
import { buildRepairPlan } from '../lib/repairs.js';

const results = [];
const record = (id, pass, detail) => results.push({ id, pass, detail });

// ---------- 1. 解压炸弹：一帧 64MB 全零 ----------
{
    const root = mkdtempSync(path.join(os.tmpdir(), 'atk-bomb-'));
    try {
        const dir = path.join(root, 'p', 'session-bomb');
        mkdirSync(dir, { recursive: true });
        const bomb = zlib.zstdCompressSync(Buffer.alloc(64 * 1024 * 1024, 0), { level: 19 });
        const line = JSON.stringify({ type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'x' }] } } }) + '\n';
        writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([zlib.zstdCompressSync(Buffer.from(line)), bomb]));
        const before = process.memoryUsage().rss;
        const t0 = Date.now();
        const scan = scanSessions({ dir: root, env: {}, deep: false });
        const ms = Date.now() - t0;
        const grewMB = Math.round((process.memoryUsage().rss - before) / 1024 / 1024);
        const blocked = scan.scanned.length === 0 && scan.errors.some((e) => /frame-too-large|too-large/.test(e));
        record('解压炸弹（64MB/帧）', blocked && grewMB < 200, `scanned=${scan.scanned.length} errors=${JSON.stringify(scan.errors)} rss+${grewMB}MB ${ms}ms`);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

// ---------- 2. CSRF：裸 POST vs 带自定义头 ----------
{
    const root = mkdtempSync(path.join(os.tmpdir(), 'atk-csrf-'));
    try {
        const handler = createReportHandler({ runsDir: root, checkOptions: { saveRuns: false, deep: false } });
        const call = (headers) =>
            new Promise((resolve) => {
                const res = {
                    code: 0,
                    writeHead(c) {
                        this.code = c;
                    },
                    end() {
                        resolve(this.code);
                    },
                };
                handler(
                    { method: 'POST', url: '/dsh-doctor/api/report', headers },
                    res,
                );
            });
        const noHeader = await call({});
        const withHeader = await call({ 'x-dsh-doctor': '1' });
        record('CSRF：裸 POST 被拒', noHeader === 403, `裸=${noHeader} 带头=${withHeader}`);
        record('CSRF：同源请求仍可用', withHeader === 200, `带头=${withHeader}`);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

// ---------- 3. 日志注入：伪装点名 + 正则元字符 ----------
{
    const patch = ['- insert:', '    - id: good-plugin', '      name: good-plugin'].join('\n');
    const evilNames = ['bad-plugin', '.*', 'good-plugin|.*', '('];
    const outcomes = [];
    for (const name of evilNames) {
        const plan = buildRepairPlan(
            { findings: [{ id: 'LOG.ABI.INCOMPATIBLE', level: 'fault', area: '插件', text: 'x', meta: { plugin: name } }] },
            { patchFiles: [{ profile: 'p', path: 'C:/x/cordis.patch.yml', text: patch }] },
        );
        outcomes.push({ name, actions: plan.actions.length, files: plan.actions.map((a) => a.params.entryId) });
    }
    const onlyExact = outcomes.every((o) => (o.name === 'bad-plugin' ? o.actions === 0 : o.name === 'good-plugin|.*' ? o.actions === 0 : o.actions === 0));
    record('日志注入：正则元字符不误匹配', onlyExact, JSON.stringify(outcomes));

    // 正面：真点名且条目存在 → 必须产出一条动作
    const hit = buildRepairPlan(
        { findings: [{ id: 'LOG.ABI.INCOMPATIBLE', level: 'fault', area: '插件', text: 'x', meta: { plugin: 'good-plugin' } }] },
        { patchFiles: [{ profile: 'p', path: 'C:/x/cordis.patch.yml', text: patch }] },
    );
    record('日志注入：真点名仍能产动作', hit.actions.length === 1, `actions=${hit.actions.length}`);
}

// ---------- 4. 深度嵌套 JSON ----------
{
    let deep = '['.repeat(20000) + ']'.repeat(20000);
    const text = `{"type":"assistant/message","data":{"turn":1,"message":{"content":[{"type":"text","text":${JSON.stringify(deep)}}]}}}`;
    const t0 = Date.now();
    let ok = true;
    try {
        parseEvents(text + '\n' + '{"type":"session"}');
    } catch {
        ok = false;
    }
    record('深度嵌套 JSON 不抛', ok, `${Date.now() - t0}ms`);
}

// ---------- 5. 路径穿越（历史文件名） ----------
{
    const { readRun } = await import('../lib/runs.js');
    const bad = readRun(os.tmpdir(), '..\\..\\windows\\win.ini');
    record('路径穿越：history 文件名带分隔符被拒', bad.ok === false, JSON.stringify(bad).slice(0, 80));
}

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
console.log(failed.length === 0 ? 'ALL-BLOCKED' : 'FAILED=' + failed.map((f) => f.id).join(','));
