/**
 * dsh-doctor / test/config.test.mjs —— 设置栏（Config schema）的契约测试
 *
 * DSH 的设置页按插件的 Config schema 自动生成，所以这里断言的是"设置栏里会长出什么"：
 *   - Config 存在且能 toJSON（宿主用 volatileForm 投影）
 *   - 关键字段都在，且都是 volatile（可在线改）
 *   - 每个字段都有 description（设置页里的说明文字）
 *   - 贡献流程（contributeGuide）默认值里含关键动作，起到提醒作用
 *   - 缺 schemastery 时优雅降级（Config === undefined，插件仍可用）—— 由 lib/config.js 的解析兜底
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Config, CONTRIBUTE_GUIDE } from '../lib/config.js';

test('Config 存在且能 toJSON', () => {
    assert.ok(Config, 'schemastery 桩存在时应能构造 Config');
    const json = Config.toJSON();
    assert.equal(json.type, 'object');
    assert.ok(json.dict && typeof json.dict === 'object');
});

test('设置栏字段齐全且都可在线改', () => {
    const dict = Config.toJSON().dict;
    const expected = [
        'maxProfiles',
        'maxLogBytes',
        'httpTimeoutMs',
        'cacheTtlMs',
        'casesPrefer',
        'localCasesDir',
        'sharedCasesDir',
        'allowLocalCaseWrite',
        'contributeGuide',
    ];
    for (const key of expected) {
        assert.ok(dict[key], `缺少字段 ${key}`);
        assert.equal(dict[key].meta && dict[key].meta.volatile, true, `${key} 必须是 volatile（否则设置页不可改）`);
        assert.ok((dict[key].meta && dict[key].meta.description)?.length > 4, `${key} 必须有 description`);
    }
});

test('contributeGuide 默认值含关键动作（提醒作用）', () => {
    const def = Config.toJSON().dict.contributeGuide.default;
    for (const word of ['doctor_case_add', 'docs/cases', 'index-cases.mjs', 'PR', 'git pull']) {
        assert.ok(def.includes(word), `贡献指引应提到 ${word}`);
    }
    assert.equal(def, CONTRIBUTE_GUIDE);
});

test('Standard Schema：cordis 靠它校验配置，必须真的可用且填默认值', () => {
    const std = Config['~standard'];
    assert.ok(std, '必须暴露 ~standard（否则 cordis 会抛 reading validate）');
    assert.equal(typeof std.validate, 'function');
    const result = std.validate({});
    assert.equal(typeof result, 'object');
    assert.equal('then' in result, false, '不能是异步校验（cordis 明确拒绝）');
    assert.equal(result.issues, undefined, '默认值必须合法，不能有 issues');
    assert.equal(result.value.maxProfiles, 32);
    assert.equal(result.value.casesPrefer, 'local');
    assert.equal(result.value.allowLocalCaseWrite, true);
    // 已给的值必须保留
    assert.equal(std.validate({ maxProfiles: 7 }).value.maxProfiles, 7);
});

test('默认值与安全边界', () => {
    const dict = Config.toJSON().dict;
    assert.equal(dict.maxProfiles.default, 32);
    assert.equal(dict.cacheTtlMs.default, 15000);
    assert.equal(dict.allowLocalCaseWrite.default, true);
    assert.equal(dict.casesPrefer.default, 'local');
    assert.equal(dict.maxProfiles.max, 200);
    assert.equal(dict.maxLogBytes.max, 33554432);
});
