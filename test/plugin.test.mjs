/**
 * dsh-doctor / test/plugin.test.mjs —— 插件入口的进程内集成测试
 *
 * 用 node_modules 里的 @deepseek-ai/dsh-tools 桩（真实宿主由 DSH 提供）验证：
 *   - apply() 能注册出三个工具，名字/参数/输出契约齐全
 *   - 三个工具的 execute() 都真的能跑，且返回非空 Markdown 文本
 *   - doctor_cases 对非法 id 给出拒绝而不是抛异常
 *   - 工具注册走 ctx.effect（宿主卸载时能干净回卷）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { apply, normalizeConfig } from '../lib/index.js';

function fakeCtx() {
    const tools = [];
    const effects = [];
    return {
        tools,
        effects,
        ctx: {
            effect(fn, label) {
                effects.push(label);
                return fn();
            },
            tools: {
                register(tool) {
                    tools.push(tool);
                    return { dispose() {} };
                },
            },
        },
    };
}

test('apply 注册五个工具，且契约字段齐全', () => {
    const { ctx, tools, effects } = fakeCtx();
    apply(ctx, {});
    assert.deepEqual(tools.map((t) => t.name).sort(), ['doctor_case_add', 'doctor_cases', 'doctor_check', 'doctor_contribute', 'doctor_engines']);
    for (const t of tools) {
        assert.equal(typeof t.description, 'string');
        assert.ok(t.description.length > 10);
        assert.equal(typeof t.parameters, 'object');
        assert.equal(typeof t.output.schema, 'object');
        assert.equal(typeof t.output.render, 'function');
        assert.equal(typeof t.execute, 'function');
        assert.equal(t.isConcurrencySafe(), true);
        // render 必须返回宿主可接受的内容块数组
        const rendered = t.output.render({}, 'hello');
        assert.equal(Array.isArray(rendered), true);
        assert.equal(rendered[0].type, 'text');
        assert.equal(rendered[0].text, 'hello');
    }
    assert.equal(effects.length, 5, '每个工具都应通过 ctx.effect 注册');
});

test('doctor_engines 真跑：能发现本机引擎并渲染成 Markdown', async () => {
    const { ctx, tools } = fakeCtx();
    apply(ctx, {});
    const t = tools.find((x) => x.name === 'doctor_engines');
    const md = await t.execute({ refresh: true });
    assert.equal(typeof md, 'string');
    assert.ok(md.includes('DSH 引擎清单'), '标题必须是 Markdown');
    assert.ok(/DSH_HOME 数量：\d+/.test(md));
});

test('doctor_check 真跑：给出判定行与对策库指针格式', async () => {
    const { ctx, tools } = fakeCtx();
    apply(ctx, {});
    const t = tools.find((x) => x.name === 'doctor_check');
    const md = await t.execute({});
    assert.ok(md.includes('DSH 体检报告'));
    assert.ok(/判定：/.test(md));
});

test('doctor_cases：索引可读，非法 id 被拒绝而不是抛', async () => {
    const { ctx, tools } = fakeCtx();
    apply(ctx, {});
    const t = tools.find((x) => x.name === 'doctor_cases');
    const index = await t.execute({});
    assert.ok(index.includes('案例库') || index.includes('不可读'));
    const evil = await t.execute({ id: '../../../etc/passwd' });
    assert.ok(evil.includes('不合法'), '带路径分隔符的 id 必须被拒');
    const missing = await t.execute({ id: 'does-not-exist' });
    assert.ok(missing.includes('读不到') || missing.includes('不可读'));
});

test('normalizeConfig：越界值被夹紧到安全区间', () => {
    const c = normalizeConfig({ maxProfiles: 9999, maxLogBytes: 10, httpTimeoutMs: 1, cacheTtlMs: -5, ports: [0, 3080, 70000] });
    assert.equal(c.maxProfiles, 200);
    assert.equal(c.maxLogBytes, 4096);
    assert.equal(c.httpTimeoutMs, 100);
    assert.equal(c.cacheTtlMs, 0);
    assert.deepEqual(c.ports, [3080]);
});
