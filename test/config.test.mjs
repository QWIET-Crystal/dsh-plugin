/**
 * dsh-doctor / test/config.test.mjs —— Config 契约测试
 *
 * Config 现在是「能解析到宿主真 schemastery 才导出」：
 *   - 有 → 必须满足 cordis/dsh-settings 的三条要求（~standard.validate、toJSON、字段 volatile）
 *   - 没有 → Config 必须是 undefined（cordis 有 `if (!runtime.Config) return config` 兜底，
 *     这是**安全**降级；危险的是"存在但缺 ~standard"，会 TypeError 让整条 entry 不激活）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG_AVAILABLE, Config, CONTRIBUTE_GUIDE } from '../lib/config.js';

test('CONFIG_AVAILABLE 是布尔；不可用时 Config 必须是 undefined（安全降级）', () => {
    assert.equal(typeof CONFIG_AVAILABLE, 'boolean');
    if (!CONFIG_AVAILABLE) {
        assert.equal(Config, undefined, '解析不到 schemastery 时必须不导出 Config，而不是导出半成品');
    } else {
        assert.ok(Config, '可用时必须给出真 schema');
    }
});

test('可用时：Standard Schema 与 toJSON 必须齐全', { skip: !CONFIG_AVAILABLE }, () => {
    const std = Config['~standard'];
    assert.ok(std, '必须暴露 ~standard（否则 cordis 抛 reading validate）');
    assert.equal(typeof std.validate, 'function');
    const result = std.validate({});
    assert.equal('then' in result, false, '不能是异步校验');
    assert.equal(typeof Config.toJSON(), 'object');
});

test('可用时：设置页需要的 9 个字段都在，且都可在线改、都有说明', { skip: !CONFIG_AVAILABLE }, () => {
    const json = Config.toJSON();
    // schemastery 的 toJSON 是 refs/uid 图：根节点 id 在 uid，字段表在 refs[uid].dict（name → ref id）
    const root = json.refs ? json.refs[String(json.uid)] : null;
    assert.ok(root, 'toJSON 必须是 schemastery 的 refs 图');
    const names = Object.keys(root.dict || {});
    const expected = ['maxProfiles', 'maxLogBytes', 'httpTimeoutMs', 'cacheTtlMs', 'casesPrefer', 'localCasesDir', 'sharedCasesDir', 'allowLocalCaseWrite', 'contributeGuide'];
    for (const key of expected) assert.ok(names.includes(key), `缺少字段 ${key}`);
    for (const key of expected) {
        const ref = json.refs[String(root.dict[key])];
        assert.ok(ref && ref.meta, `${key} 的引用节点缺失`);
        assert.equal(ref.meta.volatile, true, `${key} 必须 volatile（否则设置页不可改）`);
        assert.ok(String(ref.meta.description || '').length > 4, `${key} 必须有 description`);
    }
});

test('贡献指引默认值含关键动作（提醒作用）', () => {
    assert.ok(CONTRIBUTE_GUIDE.includes('doctor_case_add'));
    assert.ok(CONTRIBUTE_GUIDE.includes('index-cases.mjs'));
    assert.ok(CONTRIBUTE_GUIDE.includes('git pull'));
});
