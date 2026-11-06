/**
 * dsh-doctor / test/kit.test.mjs —— 急救包导出
 *
 * 这几条断言都是"真机上直接决定急救包能不能用"的硬约束：
 *   - 门铃 .cmd 必须纯 ASCII（cmd.exe 按 GBK 解码，中文会变乱码命令）；
 *   - rescue.ps1 必须带 BOM（PowerShell 5.1 没有它会按 ANSI 解码中文）；
 *   - kit.json 必须带插件路径（薄启动器靠它找最新代码）；
 *   - 内置副本必须真的可运行（bin + lib + docs 都在）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { KIT_VERSION, exportKit, withBom } from '../lib/kit.js';

const ROOT = path.join(import.meta.dirname, '..');

function tmp() {
    return mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-kit-'));
}

test('withBom：补一次，重复调用不叠加', () => {
    assert.equal(withBom('abc').charCodeAt(0), 0xfeff);
    assert.equal(withBom('\ufeffabc').length, 4);
});

test('导出：目录清单齐全，且内置副本真的可运行', () => {
    const dir = tmp();
    try {
        const r = exportKit(dir, { packageRoot: ROOT });
        assert.equal(r.ok, true, r.reason);
        assert.equal(path.basename(r.entry), '急救.cmd');
        assert.ok(existsSync(path.join(dir, '急救.cmd')));
        assert.ok(existsSync(path.join(dir, 'rescue.ps1')));
        assert.ok(existsSync(path.join(dir, 'kit.json')));
        assert.ok(existsSync(path.join(dir, 'payload', 'bin', 'dsh-doctor.mjs')), '内置副本必须有 CLI 入口');
        assert.ok(existsSync(path.join(dir, 'payload', 'lib', 'index.js')), '内置副本必须有 lib');
        assert.ok(existsSync(path.join(dir, 'payload', 'docs', 'cases')), '内置副本要带案例库');
        assert.ok(r.bytes > 0);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('门铃 .cmd：纯 ASCII、不带 BOM，且只做"拉起 ps1"这一件事', () => {
    const dir = tmp();
    try {
        const r = exportKit(dir, { packageRoot: ROOT });
        const buf = readFileSync(path.join(dir, '急救.cmd'));
        assert.equal(buf[0], 0x40, '不能有 BOM（cmd.exe 会把 BOM 当命令）');
        const text = buf.toString('utf8');
        assert.equal([...text].filter((c) => c.charCodeAt(0) > 127).length, 0, '不允许非 ASCII');
        assert.ok(/powershell/i.test(text), '必须调 PowerShell');
        assert.ok(text.includes('rescue.ps1'), '必须指向 rescue.ps1');
        assert.ok(text.includes('exit /b 0'), '必须干净退出');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('rescue.ps1：带 UTF-8 BOM（否则 PowerShell 5.1 按 GBK 读中文）', () => {
    const dir = tmp();
    try {
        exportKit(dir, { packageRoot: ROOT });
        const text = readFileSync(path.join(dir, 'rescue.ps1'), 'utf8');
        assert.equal(text.charCodeAt(0), 0xfeff);
        assert.ok(text.includes('急救包'), '中文菜单必须在 ps1 里');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('kit.json：版本、插件路径、导出时间齐全（薄启动器靠 pluginRoot）', () => {
    const dir = tmp();
    try {
        exportKit(dir, { packageRoot: ROOT, now: '2026-11-06T00:00:00.000Z' });
        const kit = JSON.parse(readFileSync(path.join(dir, 'kit.json'), 'utf8'));
        assert.equal(kit.kitVersion, KIT_VERSION);
        assert.equal(kit.pluginRoot, path.resolve(ROOT));
        assert.equal(kit.generatedAt, '2026-11-06T00:00:00.000Z');
        assert.ok(kit.pluginVersion && kit.pluginVersion !== 'unknown');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('重复导出到同一目录是幂等的', () => {
    const dir = tmp();
    try {
        const a = exportKit(dir, { packageRoot: ROOT });
        const b = exportKit(dir, { packageRoot: ROOT });
        assert.equal(a.ok, true);
        assert.equal(b.ok, true);
        assert.equal(b.files.length, a.files.length);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('急救包带修复执行器（动作白名单 + 备份 + 回滚），且没有"跑任意命令"的口子', () => {
    const dir = tmp();
    try {
        exportKit(dir, { packageRoot: ROOT });
        const ps = readFileSync(path.join(dir, 'rescue.ps1'), 'utf8');
        for (const fn of ['function Invoke-Repair', 'function Invoke-Rollback', 'function Invoke-DisablePluginEntry']) {
            assert.ok(ps.includes(fn), `缺少 ${fn}`);
        }
        // 动作类型是枚举：执行器只认这几个
        assert.ok(ps.includes("'start-service'"));
        assert.ok(ps.includes("'disable-plugin-entry'"));
        assert.ok(ps.includes("不认识的动作类型，拒绝执行"), '未知动作必须拒绝，而不是想办法执行');
        // 备份与回滚
        assert.ok(ps.includes('repairBackupRoot'));
        assert.ok(ps.includes("'.path'") || ps.includes(".path"), '回滚要靠 .path 边车记录原始路径');
        // 没有任何"把 JSON 里的字符串当命令跑"的写法
        assert.equal(/Invoke-Expression/.test(ps), false, '不允许 Invoke-Expression');
        assert.equal(/cmd\s*\/c\s*\$/.test(ps), false, '不允许把变量拼进 cmd /c');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
