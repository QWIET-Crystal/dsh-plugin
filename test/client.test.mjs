/**
 * dsh-doctor / test/client.test.mjs —— 浏览器侧模块的离线契约测试
 *
 * 不能真的开浏览器，但可以把宿主那套约定在 Node 里模拟出来：
 *   1) 脚本先访问 window.__ModuleLoader__.load({id, factory})，且 id 必须等于包名
 *   2) factory(require) 只依赖 require('react')（基线模块表）
 *   3) 返回对象带 inject（含 slots）与 apply
 *   4) apply 通过 ctx.slots.inject('settings.section', …) 注册，label 函数返回「贡献病例」
 *   5) 组件能渲染出 React 元素树（不抛错）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const CLIENT = path.join(ROOT, 'lib', 'client.js');
const PKG = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/** 极简 React 替身：createElement 返回可检查的普通对象。 */
const ReactStub = {
    createElement(type, props, children) {
        return { type, props: props || {}, children: Array.isArray(children) ? children.flat(Infinity).filter((c) => c != null) : children };
    },
};

function loadClient() {
    let captured = null;
    globalThis.window = {
        __ModuleLoader__: {
            load(spec) {
                captured = spec;
            },
        },
    };
    // client.js 是脚本（无 import/export），但包是 type:module —— 用 read+Function 模拟浏览器执行
    const source = readFileSync(CLIENT, 'utf8');
    // eslint-disable-next-line no-new-func
    new Function('window', source)(globalThis.window);
    return captured;
}

test('模块格式：id 等于包名，factory 只 require react', () => {
    const spec = loadClient();
    assert.ok(spec, '必须调用 window.__ModuleLoader__.load');
    assert.equal(spec.id, PKG.name, 'id 必须等于包名（加载器按它登记）');
    assert.equal(typeof spec.factory, 'function');
    const requested = [];
    const fakeRequire = (name) => {
        requested.push(name);
        if (name === 'react') return ReactStub;
        throw new Error('不允许 require 非基线模块: ' + name);
    };
    const mod = spec.factory(fakeRequire);
    assert.deepEqual(requested, ['react']);
    assert.deepEqual(mod.inject, ['slots']);
    assert.equal(typeof mod.apply, 'function');
});

test('注册：往 settings.section 挂一页「贡献病例」', () => {
    const spec = loadClient();
    const mod = spec.factory(() => ReactStub);
    const injected = [];
    const registered = [];
    const ctx = {
        slots: {
            inject(name, cb) {
                injected.push(name);
                const dispose = cb();
                return typeof dispose === 'function' ? dispose : () => {};
            },
            register(options, component) {
                registered.push({ options, component });
                return () => {};
            },
        },
    };
    mod.apply(ctx);
    assert.deepEqual(injected, ['settings.section']);
    assert.equal(registered.length, 1);
    const { options, component } = registered[0];
    assert.equal(options.name, 'settings.section');
    assert.equal(options.id, 'dsh-doctor-contribute');
    assert.equal(typeof options.order, 'number');
    assert.equal(options.label(), '贡献病例');
    // 组件能渲染
    const tree = component({});
    assert.equal(tree.type, 'div');
    const text = JSON.stringify(tree);
    for (const word of ['贡献病例', 'doctor_case_add', 'index-cases.mjs', 'docs/cases']) {
        assert.ok(text.includes(word), `页面内容应提到 ${word}`);
    }
});

test('package.json：client 声明与 exports 齐全', () => {
    assert.equal(PKG.exports['./client'], './lib/client.js');
    assert.equal(PKG.dsh.client.platform, 'web');
    assert.ok(Array.isArray(PKG.dsh.client.inject));
    assert.ok(PKG.dsh.bundle.patch);
    assert.ok(PKG.files.includes('lib'), 'lib 必须进发布包（含 client.js）');
});
