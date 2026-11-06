/**
 * dsh-doctor / test/repairs.test.mjs —— 修复计划（0.5.0）
 *
 * 计划是**数据**：只允许枚举的动作类型，且必须有证据才产动作。
 * 这几条断言守的是"它不会乱动"：
 *   - 没有点名插件 → 不产生"禁用"动作；
 *   - 会话类问题 → 只给人工指路，绝不产生动作；
 *   - 风险分级正确（A 可一键、B 需确认）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ACTION_TYPES, buildRepairPlan, collectPatchFiles, renderRepairPlan } from '../lib/repairs.js';

const payload = (findings) => ({ verdict: 'warn', findings });

const portDown = (port, level = 'info') => ({
    id: port === 3080 || port === 43120 ? 'PORT.HOST.NOT_LISTENING' : 'X',
    level,
    area: '运行',
    text: `${port} 没在运行`,
    caseId: '2026-09-24-frontend-dead',
    meta: { port },
});

test('端口没在跑 → A 类启动动作，验证方式是等端口监听', () => {
    const plan = buildRepairPlan(payload([portDown(43120)]));
    assert.equal(plan.actions.length, 1);
    const a = plan.actions[0];
    assert.equal(a.type, 'start-service');
    assert.equal(a.risk, 'A');
    assert.equal(a.params.service, 'desktop');
    assert.deepEqual(a.verify, { kind: 'port', port: 43120, timeoutMs: 30000 });
    assert.ok(ACTION_TYPES.includes(a.type));
});

test('全部宿主都没在跑 → 两个启动动作', () => {
    const plan = buildRepairPlan(payload([{ id: 'PORT.ALL_HOSTS.DOWN', level: 'warn', area: '运行', text: '全都停了', meta: { ports: [3080, 43120] } }]));
    assert.deepEqual(plan.actions.map((a) => a.params.service).sort(), ['desktop', 'web']);
    assert.equal(plan.summary.A, 2);
});

test('日志点名了插件 + 找到 patch 条目 → B 类禁用动作（带文件与 entryId）', () => {
    const patchText = [
        '- insert:',
        '    - id: dsh-doctor',
        '      name: dsh-doctor',
        '    - id: bad-plugin',
        '      name: bad-plugin',
    ].join('\n');
    const plan = buildRepairPlan(
        payload([
            {
                id: 'LOG.ABI.INCOMPATIBLE',
                level: 'fault',
                area: '插件',
                text: '插件 bad-plugin 与内核 0.2.1 不兼容',
                meta: { plugin: 'bad-plugin' },
            },
        ]),
        { patchFiles: [{ profile: 'desktop', path: 'C:/x/cordis.patch.yml', text: patchText }] },
    );
    assert.equal(plan.actions.length, 1);
    const a = plan.actions[0];
    assert.equal(a.type, 'disable-plugin-entry');
    assert.equal(a.risk, 'B');
    assert.equal(a.params.entryId, 'bad-plugin');
    assert.equal(a.params.file, 'C:/x/cordis.patch.yml');
    assert.equal(a.verify.kind, 'file-contains');
});

test('日志没点名 / 找不到条目 → 不产动作（只给人工指路）', () => {
    const unnamed = buildRepairPlan(payload([{ id: 'LOG.PLUGINS_LOAD_FAILED', level: 'fault', area: '插件', text: '整个插件树加载失败' }]));
    assert.equal(unnamed.actions.length, 0, '没有名字就不许猜');

    const notFound = buildRepairPlan(
        payload([{ id: 'LOG.ABI.INCOMPATIBLE', level: 'fault', area: '插件', text: 'x', meta: { plugin: 'ghost' } }]),
        { patchFiles: [{ profile: 'desktop', path: 'p', text: '- id: other\n' }] },
    );
    assert.equal(notFound.actions.length, 0);
    assert.equal(notFound.notes.length, 1);
    assert.equal(notFound.notes[0].risk, 'C');
});

test('会话类问题只出人工指路，绝不产动作', () => {
    const plan = buildRepairPlan(
        payload([
            { id: 'SESSION.EMPTY_TURN', level: 'warn', area: '会话', text: '有 3 轮空回合', caseId: '2026-11-06-reasoning-repetition-collapse' },
            { id: 'SESSION.REPETITION.COLLAPSE', level: 'warn', area: '会话', text: '重复 28428 次' },
        ]),
    );
    assert.equal(plan.actions.length, 0);
    assert.equal(plan.notes.length, 2);
    assert.equal(plan.notes[0].caseId, '2026-11-06-reasoning-repetition-collapse');
});

test('collectPatchFiles：从 discovery 里带出每个 profile 的 patch 原文', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-plan-'));
    try {
        const dir = path.join(root, 'profiles', 'desktop');
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, 'cordis.patch.yml'), '- insert:\n    - id: x\n', 'utf8');
        const files = collectPatchFiles({ homes: [{ error: null, profiles: [{ name: 'desktop', dir }] }] });
        assert.equal(files.length, 1);
        assert.equal(files[0].profile, 'desktop');
        assert.ok(files[0].text.includes('id: x'));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('renderRepairPlan：分级展示 + 人工项', () => {
    const plan = buildRepairPlan(
        payload([portDown(43120), { id: 'SESSION.EMPTY_TURN', level: 'warn', area: '会话', text: '空回合', caseId: 'x' }]),
    );
    const md = renderRepairPlan(plan);
    assert.ok(md.includes('A 类'));
    assert.ok(md.includes('需要人工处理'));
});
