/**
 * dsh-doctor / test/plugin.test.mjs —— 插件入口的进程内集成测试
 *
 * 用 node_modules 里的 @deepseek-ai/dsh-tools 桩（真实宿主由 DSH 提供）验证：
 *   - apply() 能注册出六个工具，名字/参数/输出契约齐全
 *   - doctor_check 返回**结构化对象**（0.2.0 契约），但 render 出来的仍是 Markdown
 *   - 字符串工具（engines / cases / runs …）仍返回非空文本
 *   - doctor_cases 对非法 id 给出拒绝而不是抛异常
 *   - 工具注册走 ctx.effect（宿主卸载时能干净回卷）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { apply, inject as pluginInject, normalizeConfig } from '../lib/index.js';

function fakeCtx() {
    const tools = [];
    const effects = [];
    const routes = [];
    return {
        tools,
        effects,
        routes,
        ctx: {
            effect(fn, label) {
                effects.push(label);
                return fn();
            },
            webServer: {
                register(spec) {
                    routes.push(spec);
                    return { dispose() {} };
                },
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

const ALL_TOOLS = [
    'doctor_case_add',
    'doctor_cases',
    'doctor_check',
    'doctor_contribute',
    'doctor_engines',
    'doctor_export_kit',
    'doctor_runs',
];

test('apply 注册七个工具，且契约字段齐全', () => {
    const { ctx, tools, effects } = fakeCtx();
    apply(ctx, { saveRuns: false });
    assert.deepEqual(tools.map((t) => t.name).sort(), ALL_TOOLS);
    for (const t of tools) {
        assert.equal(typeof t.description, 'string');
        assert.ok(t.description.length > 10);
        assert.equal(typeof t.parameters, 'object');
        assert.equal(typeof t.output.schema, 'object');
        assert.equal(typeof t.output.render, 'function');
        assert.equal(typeof t.execute, 'function');
        assert.equal(t.isConcurrencySafe(), true);
        // render 必须返回宿主可接受的内容块数组（用各工具自己的值形状）
        const sample = t.name === 'doctor_check' ? { generatedAt: new Date().toISOString(), findings: [], summary: { fault: 0, warn: 0, unknown: 0, info: 0, ok: 0, total: 0 }, verdict: 'ok', discovery: {}, logScan: {} } : 'hello';
        const rendered = t.output.render({}, sample);
        assert.equal(Array.isArray(rendered), true);
        assert.equal(rendered[0].type, 'text');
        assert.equal(typeof rendered[0].text, 'string');
    }
    assert.equal(effects.length, 8, '七个工具 + 一条路由，都应通过 ctx.effect 注册');
    // 只有 doctor_check 是结构化对象输出，其余保持字符串（对宿主向后兼容）
    assert.equal(tools.find((t) => t.name === 'doctor_check').output.schema.type, 'object');
    for (const t of tools.filter((x) => x.name !== 'doctor_check')) {
        assert.equal(t.output.schema.type, 'string', `${t.name} 应保持字符串输出`);
    }
});

test('宿主有 webServer 时注册体检路由（kind=prefix）', () => {
    const { ctx, routes } = fakeCtx();
    apply(ctx, { saveRuns: false });
    assert.equal(routes.length, 1);
    assert.equal(routes[0].kind, 'prefix');
    assert.equal(routes[0].path, '/dsh-doctor/api/report');
    assert.equal(typeof routes[0].handler, 'function');
});

test('doctor_engines 真跑：能发现本机引擎并渲染成 Markdown', async () => {
    const { ctx, tools } = fakeCtx();
    apply(ctx, { saveRuns: false });
    const t = tools.find((x) => x.name === 'doctor_engines');
    const md = await t.execute({ refresh: true });
    assert.equal(typeof md, 'string');
    assert.ok(md.includes('DSH 引擎清单'), '标题必须是 Markdown');
    assert.ok(/DSH_HOME 数量：\d+/.test(md));
});

test('doctor_check 返回结构化对象，render 仍是 Markdown', async () => {
    const { ctx, tools } = fakeCtx();
    apply(ctx, { saveRuns: false });
    const t = tools.find((x) => x.name === 'doctor_check');
    const payload = await t.execute({});
    assert.equal(typeof payload, 'object');
    assert.equal(typeof payload.schemaVersion, 'number');
    assert.ok(Array.isArray(payload.findings));
    assert.ok(['fault', 'warn', 'unknown', 'ok'].includes(payload.verdict), '判定必须是四态之一');
    assert.ok([0, 1, 2, 3].includes(payload.exitCode), '退出码必须是 0/1/2/3');
    for (const f of payload.findings) {
        assert.equal(typeof f.id, 'string');
        assert.ok(f.id.length > 3 && f.id.includes('.'), `稳定 id 形如 AREA.CHECK：${f.id}`);
        assert.ok(['fault', 'warn', 'unknown', 'info', 'ok'].includes(f.level));
        assert.equal(typeof f.area, 'string');
        assert.equal(typeof f.text, 'string');
        assert.ok(Array.isArray(f.fix));
    }
    assert.equal(typeof payload.summary.unknown, 'number');
    const rendered = t.output.render({}, payload);
    assert.ok(rendered[0].text.includes('DSH 体检报告'));
    assert.ok(/判定：/.test(rendered[0].text));
});

test('doctor_runs：关闭历史时给出明确说明而不是空列表', async () => {
    const { ctx, tools } = fakeCtx();
    apply(ctx, { saveRuns: false });
    const t = tools.find((x) => x.name === 'doctor_runs');
    const text = await t.execute({});
    assert.ok(text.includes('saveRuns=false'));
});

test('doctor_cases：索引可读，非法 id 被拒绝而不是抛', async () => {
    const { ctx, tools } = fakeCtx();
    apply(ctx, { saveRuns: false });
    const t = tools.find((x) => x.name === 'doctor_cases');
    const index = await t.execute({});
    assert.ok(index.includes('案例库') || index.includes('不可读'));
    const evil = await t.execute({ id: '../../../etc/passwd' });
    assert.ok(evil.includes('不合法'), '带路径分隔符的 id 必须被拒');
    const missing = await t.execute({ id: 'does-not-exist' });
    assert.ok(missing.includes('读不到') || missing.includes('不可读'));
});

test('inject 必须声明 tools 与 webServer（否则访问会抛，且被降级吞掉）', () => {
    // cordis 对未声明的服务不是返回 undefined，而是**直接抛**：
    //   `cannot get property "webServer" without inject`
    // 真机后果：路由静默没注册，设置页「体检」一直显示降级页。
    assert.deepEqual([...pluginInject].sort(), ['tools', 'webServer']);
});

test('输出 schema 必须落在宿主的值 schema DSL 子集内（真机踩过的两条）', () => {
    const { ctx, tools } = fakeCtx();
    apply(ctx, { saveRuns: false });

    // 宿主对 output.schema 用的是「值 schema DSL」，不是完整 JSON Schema：
    //   1) 不支持 required；2) 每个 object 节点必须显式写 additionalProperties。
    // 这条断言不依赖宿主包，纯结构，CI 里也能跑。
    const walk = (node, path, problems) => {
        if (!node || typeof node !== 'object') return;
        if (Object.hasOwn(node, 'required')) problems.push(`${path}.required 不被值 schema DSL 支持`);
        if (node.type === 'object' && typeof node.additionalProperties !== 'boolean') {
            problems.push(`${path}.additionalProperties 必须是显式 true/false`);
        }
        if (node.type === 'array' && node.items) walk(node.items, `${path}.items`, problems);
        for (const [k, v] of Object.entries(node.properties || {})) walk(v, `${path}.properties.${k}`, problems);
        (node.oneOf || []).forEach((v, i) => walk(v, `${path}.oneOf[${i}]`, problems));
    };

    for (const t of tools) {
        const problems = [];
        walk(t.output.schema, `${t.name}.schema`, problems);
        assert.deepEqual(problems, [], `${t.name} 的输出 schema 不合法：${problems.join('；')}`);
        const s = t.output.schema;
        assert.ok(s.type || s.oneOf, `${t.name} 的 schema 必须有 type 或 oneOf`);
    }
});

test('normalizeConfig：越界值被夹紧到安全区间', () => {
    const c = normalizeConfig({ maxProfiles: 9999, maxLogBytes: 10, httpTimeoutMs: 1, cacheTtlMs: -5, ports: [0, 3080, 70000] });
    assert.equal(c.maxProfiles, 200);
    assert.equal(c.maxLogBytes, 4096);
    assert.equal(c.httpTimeoutMs, 100);
    assert.equal(c.cacheTtlMs, 0);
    assert.deepEqual(c.ports, [3080]);
});

test('normalizeConfig：历史开关与保留条数有安全默认，且能关掉', () => {
    const def = normalizeConfig({});
    assert.equal(def.saveRuns, true, '默认记历史');
    assert.equal(def.runsRetention, 30);
    assert.equal(normalizeConfig({ saveRuns: false }).saveRuns, false);
    assert.equal(normalizeConfig({ runsRetention: 9999 }).runsRetention, 500);
    assert.equal(normalizeConfig({ runsRetention: 0 }).runsRetention, 1);
});
