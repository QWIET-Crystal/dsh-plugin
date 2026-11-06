/**
 * dsh-doctor / lib/kit.js —— 急救包导出（宿主全崩时，人靠它把自己救回来）
 *
 * 产出一个可以直接双击的目录：
 *
 *   急救.cmd          纯 ASCII 门铃（cmd.exe 按 GBK 解码 .cmd，中文会变乱码命令）
 *   rescue.ps1        中文菜单 + 探测链 + 动作（UTF-8 **带 BOM**，否则 PS 5.1 也按 GBK 读）
 *   kit.json          版本 / 导出时间 / 插件安装路径（薄启动器靠它找最新代码）
 *   payload/          内置副本（插件被卸载后还能用，但会过期）
 *
 * 为什么是"薄启动器 + 内置副本"：插件升级后，桌面上那个包不该永远停在旧代码；
 * 但插件被卸掉时，人也得还有东西可以点。所以两份都写，运行时优先用插件目录那份，
 * 报告里注明这次用的是哪一份。
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const KIT_VERSION = '1.0.0';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.join(HERE, '..');

/** 内置副本里要带的最小可运行集合。 */
const PAYLOAD_ITEMS = ['bin', 'lib', 'docs', 'package.json'];

function stripBom(text) {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** UTF-8 BOM：PowerShell 5.1 没有它会按系统 ANSI 解码中文脚本。 */
export function withBom(text) {
    return '\ufeff' + stripBom(text);
}

function listFiles(dir, base = dir, out = []) {
    for (const name of readdirNames(dir)) {
        const full = path.join(dir, name);
        let st;
        try {
            st = statSync(full);
        } catch {
            continue;
        }
        if (st.isDirectory()) listFiles(full, base, out);
        else out.push({ path: full, rel: path.relative(base, full), bytes: st.size });
    }
    return out;
}

function readdirNames(dir) {
    try {
        return readdirSync(dir);
    } catch {
        return [];
    }
}

/**
 * 导出急救包。
 *
 * @param {string} targetDir  导出目录（不存在会自动创建）
 * @param {object} [opts]     { packageRoot?, now? }
 * @returns {{ok:boolean, dir:string, entry:string|null, kitJson:string|null, files:string[], bytes:number, reason?:string}}
 */
export function exportKit(targetDir, opts = {}) {
    const root = path.resolve(opts.packageRoot || DEFAULT_ROOT);
    const dir = path.resolve(targetDir);
    const now = opts.now ? new Date(opts.now) : new Date();

    const pkgPath = path.join(root, 'package.json');
    let version = 'unknown';
    try {
        version = JSON.parse(readFileSync(pkgPath, 'utf8')).version || 'unknown';
    } catch {
        return { ok: false, dir, entry: null, kitJson: null, files: [], bytes: 0, reason: 'package-json-missing' };
    }

    const srcCmd = path.join(root, 'rescue', '急救.cmd');
    const srcPs1 = path.join(root, 'rescue', 'rescue.ps1');
    if (!existsSync(srcCmd) || !existsSync(srcPs1)) {
        return { ok: false, dir, entry: null, kitJson: null, files: [], bytes: 0, reason: 'templates-missing' };
    }

    // 门铃必须是纯 ASCII：cmd.exe 按 GBK 解码非 ASCII 字节会得到乱码命令
    const cmdText = readFileSync(srcCmd, 'utf8');
    const nonAscii = [...cmdText].filter((ch) => ch.charCodeAt(0) > 127).length;
    if (nonAscii > 0) {
        return { ok: false, dir, entry: null, kitJson: null, files: [], bytes: 0, reason: 'cmd-not-ascii' };
    }

    try {
        mkdirSync(dir, { recursive: true });
    } catch {
        return { ok: false, dir, entry: null, kitJson: null, files: [], bytes: 0, reason: 'mkdir-failed' };
    }

    // 1) 两个入口文件（.ps1 强制补 BOM）
    writeFileSync(path.join(dir, '急救.cmd'), stripBom(cmdText), 'utf8');
    writeFileSync(path.join(dir, 'rescue.ps1'), withBom(readFileSync(srcPs1, 'utf8')), 'utf8');

    // 2) 内置副本
    const payloadDir = path.join(dir, 'payload');
    for (const item of PAYLOAD_ITEMS) {
        const src = path.join(root, item);
        if (!existsSync(src)) continue;
        try {
            cpSync(src, path.join(payloadDir, item), { recursive: true });
        } catch {
            /* 单个条目失败不致命，kit.json 会记录版本 */
        }
    }

    // 3) 清单：薄启动器靠 pluginRoot 找最新代码
    const kit = {
        kitVersion: KIT_VERSION,
        pluginVersion: version,
        pluginRoot: root,
        generatedAt: now.toISOString(),
        entry: '急救.cmd',
        // 探测链由 rescue.ps1 运行时填充，这里只记导出时的事实
        note: '双击「急救.cmd」；本文件由 dsh-doctor 导出，删除它不会影响插件。',
    };
    const kitJsonPath = path.join(dir, 'kit.json');
    writeFileSync(kitJsonPath, JSON.stringify(kit, null, 2), 'utf8');

    const files = listFiles(dir);
    const bytes = files.reduce((n, f) => n + f.bytes, 0);
    return {
        ok: true,
        dir,
        entry: path.join(dir, '急救.cmd'),
        kitJson: kitJsonPath,
        files: files.map((f) => f.rel),
        bytes,
        kit,
    };
}
