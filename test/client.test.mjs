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

test('注册：两页设置 + 一个会话头部徽章', () => {
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
    assert.deepEqual(injected, ['settings.section', 'settings.section', 'conversation.session.header.utilities']);
    assert.equal(registered.length, 3);
    const byId = Object.fromEntries(registered.map((r) => [r.options.id, r]));
    assert.deepEqual(Object.keys(byId).sort(), ['dsh-doctor-badge', 'dsh-doctor-check', 'dsh-doctor-contribute']);
    for (const r of registered) {
        assert.equal(typeof r.options.order, 'number');
    }
    assert.equal(byId['dsh-doctor-check'].options.label(), '体检');
    assert.equal(byId['dsh-doctor-contribute'].options.label(), '贡献病例');

    // 头部徽章：槽位契约（name/id/registrant/inject(sessionId)）
    const badge = byId['dsh-doctor-badge'].options;
    assert.equal(badge.name, 'conversation.session.header.utilities');
    assert.equal(badge.registrant, 'dsh-doctor');
    assert.equal(typeof badge.inject, 'function');
    assert.deepEqual(badge.inject('s1'), { sessionId: 's1' });

    // 贡献页能离线渲染（体检页/徽章依赖 useState/useEffect，需要真渲染器）
    const tree = byId['dsh-doctor-contribute'].component({});
    assert.equal(tree.type, 'div');
    const text = JSON.stringify(tree);
    for (const word of ['贡献病例', 'doctor_contribute', 'contribute.mjs', '--pr']) {
        assert.ok(text.includes(word), `页面内容应提到 ${word}`);
    }
    assert.equal(typeof byId['dsh-doctor-check'].component, 'function');
    assert.equal(typeof byId['dsh-doctor-badge'].component, 'function');
});

test('头部徽章：默认显示、可由服务端 ui.headerBadge=false 隐藏（源码级断言）', () => {
    const source = readFileSync(CLIENT, 'utf8');
    assert.ok(source.includes('headerBadge'), '必须读服务端的开关');
    assert.ok(source.includes("refresh('POST')") || source.includes("'POST'"), '徽章里要能现场重扫');
    for (const tone of ['fault', 'warn', 'unknown', 'ok']) {
        assert.ok(source.includes(tone), `徽章要按 ${tone} 变色`);
    }
});

test('体检页：不依赖宿主路由也能给出降级指引（源码级断言）', () => {
    const source = readFileSync(CLIENT, 'utf8');
    assert.ok(source.includes('/dsh-doctor/api/report'), '必须从宿主路由取数');
    assert.ok(source.includes('dsh-doctor check'), '取不到数时必须给出可复制的 CLI 命令');
    assert.ok(source.includes('重新扫描'), '页面必须有重新扫描入口');
    assert.ok(source.includes('无法取证'), '页面要能展示 unknown 这一级');
});

test('package.json：client 声明与 exports 齐全', () => {
    assert.equal(PKG.exports['./client'], './lib/client.js');
    assert.equal(PKG.dsh.client.platform, 'web');
    assert.ok(Array.isArray(PKG.dsh.client.inject));
    assert.ok(PKG.dsh.bundle.patch);
    assert.ok(PKG.files.includes('lib'), 'lib 必须进发布包（含 client.js）');
});
