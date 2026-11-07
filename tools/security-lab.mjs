/**
 * dsh-doctor / tools/security-lab.mjs —— 搭一个"封闭"攻防沙箱（0.5.1）
 *
 * 本机没有 Docker / Windows Sandbox，所以"严格封闭"只能是**逻辑隔离**：
 *   - 一份独立的插件副本（攻击者随便改，不影响真仓库）
 *   - 一个假 DSH_HOME（假会话、假 profile、假案例库）
 *   - 一个假 APPDATA（假桌面端日志；插件按 env.APPDATA 定位日志目录）
 *   - 一个带审计的命令包装器（每条攻击命令落盘）
 *
 * 诚实的边界：这是**目录级**隔离，不是内核级。跑完由审计日志复核。
 *
 * 用法：node tools/security-lab.mjs [--root <目录>]
 */

import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const argv = process.argv.slice(2);
const rootFlag = argv.indexOf('--root');
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const repoRoot = path.join(import.meta.dirname, '..');
const root = path.resolve(rootFlag >= 0 ? argv[rootFlag + 1] : path.join('D:/DSH/_securitylab', 'run-' + stamp));

if (existsSync(root) && argv.indexOf('--force') < 0) {
    console.error(`目标已存在：${root}（要覆盖加 --force）`);
    process.exit(2);
}

const dirs = {
    plugin: path.join(root, 'plugin'),
    home: path.join(root, 'home', '.dsh'),
    appdata: path.join(root, 'appdata'),
    audit: path.join(root, 'audit'),
    findings: path.join(root, 'findings'),
};
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });

// ---------- 1. 插件副本（不含 .git / test / node_modules / 沙箱自身） ----------
cpSync(repoRoot, dirs.plugin, {
    recursive: true,
    filter: (src) => {
        const rel = path.relative(repoRoot, src);
        if (!rel) return true;
        const top = rel.split(path.sep)[0];
        return !['.git', 'node_modules', 'test', '_securitylab', '.github'].includes(top);
    },
});

// ---------- 2. 假 DSH_HOME ----------
const profileDir = path.join(dirs.home, 'profiles', 'lab');
mkdirSync(profileDir, { recursive: true });
writeFileSync(
    path.join(dirs.home, 'cordis.patch.yml'),
    ['# 沙箱根 patch', '- insert:', '    - id: dsh-doctor', '      name: dsh-doctor', ''].join('\n'),
    'utf8',
);
writeFileSync(
    path.join(profileDir, 'cordis.patch.yml'),
    [
        '# 沙箱 profile patch（攻击者可改这份）',
        '- insert:',
        '    - id: dsh-doctor',
        '      name: dsh-doctor',
        '    - id: evil-plugin',
        '      name: evil-plugin',
        '    - id: lab-plugin',
        '      name: lab-plugin',
        '',
    ].join('\n'),
    'utf8',
);

// 假会话：两帧 zstd，含一轮正常对话 + 一轮"只有推理"的空回合
const events = [
    { type: 'session', version: 4, id: 'session-lab01', cwd: 'D:/lab' },
    { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', seq: 2, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: '先想一下。' }, { type: 'text', text: '你好，这是一次沙箱会话。' }] } } },
    { type: 'step/end', seq: 3, data: { turn: 1, step: 1 } },
    { type: 'step/start', seq: 4, data: { turn: 2, step: 1 } },
    { type: 'assistant/message', seq: 5, data: { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: '只有推理，没有正文。' }] } } },
    { type: 'step/end', seq: 6, data: { turn: 2, step: 1 } },
];
const sessionDir = path.join(dirs.home, 'sessions', '--D-DSH--', 'session-lab01');
mkdirSync(sessionDir, { recursive: true });
const frames = [];
for (let i = 0; i < events.length; i += 2) {
    frames.push(zlib.zstdCompressSync(Buffer.from(events.slice(i, i + 2).map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')));
}
writeFileSync(path.join(sessionDir, 'session.v4.jsonl.zstd'), Buffer.concat(frames));

// 假本地案例库
const casesDir = path.join(dirs.home, 'dsh-doctor', 'cases');
mkdirSync(casesDir, { recursive: true });
writeFileSync(
    path.join(casesDir, 'local-20260101-lab-case.md'),
    ['# 沙箱案例', '', '## 类型', '', 'runtime', '', '## 症状', '', '沙箱假案例。', '', '## 判定签名', '', '`LAB.CASE`', '', '## 根因', '', '沙箱。', ''].join('\n'),
    'utf8',
);

// ---------- 3. 假 APPDATA（桌面端日志） ----------
const logDir = path.join(dirs.appdata, 'DSH Desktop', 'logs');
mkdirSync(logDir, { recursive: true });
writeFileSync(
    path.join(logDir, 'dsh-2026-01-01.log'),
    [
        '{"source":"shell","event":"shell-load.start","time":"2026-01-01T00:00:00.000Z"}',
        '{"source":"plugin","message":"disabling profile plugin row \\"lab-plugin\\" because it is incompatible with dsh 0.1.0","time":"2026-01-01T00:00:01.000Z"}',
        '{"source":"plugin","message":"1 entry did not activate: pending (waiting for service: labService)","time":"2026-01-01T00:00:02.000Z"}',
        '',
    ].join('\n'),
    'utf8',
);

// ---------- 4. 审计包装器 ----------
writeFileSync(
    path.join(dirs.audit, 'run.mjs'),
    `import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
// 用法：node audit/run.mjs <攻击者名> <命令...>
const [who, ...cmd] = process.argv.slice(2);
if (!who || cmd.length === 0) { console.error('usage: node audit/run.mjs <attacker> <cmd...>'); process.exit(2); }
const started = new Date().toISOString();
const r = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit', shell: false });
appendFileSync(path.join(import.meta.dirname, who + '.log'), JSON.stringify({ ts: started, who, cmd: cmd.join(' '), code: r.status }) + '\\n');
process.exit(r.status ?? 1);
`,
    'utf8',
);

// ---------- 5. 交战规则 ----------
writeFileSync(
    path.join(root, 'README.md'),
    `# 攻防沙箱

你是攻击方。目标：让 \`plugin/\` 这份 dsh-doctor 副本表现出它不该有的行为。

## 允许
- 在**本目录内**任意读写、执行、改副本。
- 用 \`node audit/run.mjs <你的名字> <命令...>\` 跑命令（会记审计日志）。
- 读 \`home/\`（假 DSH_HOME）、\`appdata/\`（假桌面端日志）。

## 禁止
- 访问 \`${root}\` 以外的任何路径（尤其是真实的 \`C:\\Users\\kaiple\\.dsh\`）。
- 联网（模型 API 除外）。
- 修改仓库本体（你只有副本）。

## 目标面
- \`plugin/lib/\`：插件本体（会话读取、HTTP 路由、修复计划、脱敏）
- \`plugin/bin/dsh-doctor.mjs\`：CLI
- \`plugin/rescue/\`：急救包（可执行的那一面）

## 交回来
每条攻击写进 \`findings/<你的名字>.md\`：攻击点 / 具体做法 / 实际效果 / 你用的命令。
没攻破的也写一行，注明你试过什么。
`,
    'utf8',
);

console.log(JSON.stringify({ root, dirs }, null, 2));
