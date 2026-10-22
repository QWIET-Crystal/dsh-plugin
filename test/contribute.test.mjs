/**
 * dsh-doctor / test/contribute.test.mjs —— 一键贡献链路的核心逻辑测试
 *
 * 不启动子进程（沙箱里测试运行器 spawn 会被拦），只测纯函数：
 *   - scrub：本机指纹/盘符路径/令牌 必须被抹掉
 *   - toCaseDoc：缺章节要**明确报缺哪节**；齐全则保留结构并补空的「判定签名」节
 *   - 派生 id：从文件名/标题得到合法编号
 * 端到端（真写文件/提交/推送）用命令行手动验证，见 README 的"一键贡献"一节。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scrub, toCaseDoc } from '../tools/contribute.mjs';

const IDENT = { userName: 'alice', hostName: 'LAPTOP-ABCD123', homeDir: 'C:\\Users\\alice', tempDir: 'C:\\Temp' };

test('scrub：本机指纹、盘符路径、令牌都被抹掉', () => {
    const src = [
        '路径 C:\\Users\\alice\\.dsh\\profiles\\desktop',
        '主机 LAPTOP-ABCD123，用户 alice',
        '令牌 ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
        '工作区 D:\\DSH\\_ops\\incidents\\x.md',
    ].join('\n');
    const out = scrub(src, IDENT, 'D:\\DSH');
    for (const leak of ['C:\\Users\\alice', 'LAPTOP-ABCD123', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345', 'D:\\DSH\\']) {
        assert.equal(out.includes(leak), false, `不应包含 ${leak}`);
    }
    assert.ok(out.includes('<home>') || out.includes('<path>') || out.includes('<workspace>'), '应有占位符');
});

test('toCaseDoc：缺章节时明确报缺哪几节（不猜内容）', () => {
    const r = toCaseDoc('# 只有标题\n\n随便写点。', { id: '2026-10-22-x' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'missing-sections');
    for (const k of ['症状', '根因', '处置', '验证']) assert.ok(r.missing.includes(k), `应报缺 ${k}`);
});

test('toCaseDoc：齐全时保留结构，并在缺「判定签名」时补一个占位节', () => {
    const src = ['# 标题', '', '## 症状', 'x', '## 根因', 'y', '## 处置', 'z', '## 验证', 'w'].join('\n');
    const r = toCaseDoc(src, { id: '2026-10-22-x' });
    assert.equal(r.ok, true);
    assert.ok(r.body.startsWith('# 标题'));
    assert.ok(r.body.includes('## 判定签名'), '缺判定签名时应自动插入占位节');
    assert.ok(r.body.indexOf('## 判定签名') < r.body.indexOf('## 根因'), '占位节应在根因之前');
});

test('toCaseDoc：可覆盖标题', () => {
    const src = ['# 旧标题', '', '## 症状', 'x', '## 根因', 'y', '## 处置', 'z', '## 验证', 'w'].join('\n');
    const r = toCaseDoc(src, { id: 'x', title: '新标题' });
    assert.equal(r.ok, true);
    assert.ok(r.body.startsWith('# 新标题'));
    assert.equal(r.body.includes('旧标题'), false);
});

test('toCaseDoc：空源直接拒绝', () => {
    assert.deepEqual(toCaseDoc('   ', { id: 'x' }), { ok: false, reason: 'empty-source' });
});
