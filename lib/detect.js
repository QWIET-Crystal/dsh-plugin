/**
 * dsh-doctor / lib/detect.js —— 自动发现本机所有 DeepSeek Harness 引擎与实例
 *
 * "引擎"在本插件里有四种来源，全部只读发现、互不依赖：
 *   home      一个 DSH_HOME（里面可有多个 profile；每个 profile 就是一套插件装配）
 *   npm       npm 全局安装的 @deepseek-ai/dsh（大姐/三妹这种 node 宿主就是它）
 *   desktop   桌面端安装（Resources/app 里带着一份内核 + 独立 profile 语义）
 *   running   正在监听的宿主端口（活着的实例；只管连通性，不做 HTTP 语义）
 *
 * 安全约束（见 SECURITY.md）：只读文件系统、不 spawn、不读白名单外的路径、每个文件有字节上限。
 */

import { readdirSync, existsSync, statSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_LIMITS, safeReadText } from './safety.js';

/** 默认会尝试探测的宿主端口（可用 config.ports 覆盖）。 */
export const DEFAULT_PORTS = [3080, 43120, 19372, 3081, 8080];

function readJsonSafe(file, maxBytes = 256 * 1024) {
    const r = safeReadText(file, { roots: [path.dirname(file)], maxBytes });
    if (!r.ok) return null;
    try {
        return JSON.parse(r.text);
    } catch {
        return null;
    }
}

/** 列目录（失败返回空数组，永不抛）。 */
function listDirs(dir) {
    try {
        return readdirSync(dir, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => path.join(dir, d.name));
    } catch {
        return [];
    }
}

function listFiles(dir, filter) {
    try {
        return readdirSync(dir, { withFileTypes: true })
            .filter((d) => d.isFile() && (!filter || filter(d.name)))
            .map((d) => path.join(dir, d.name));
    } catch {
        return [];
    }
}

/** 候选 DSH_HOME：环境变量优先，其次常见位置（含桌宠引擎的 dsh-home）。 */
export function candidateHomes(env = process.env) {
    const out = [];
    const push = (p) => {
        if (p && !out.includes(p)) out.push(p);
    };
    push(env.DSH_HOME);
    push(path.join(env.USERPROFILE || os.homedir(), '.dsh'));
    const local = env.LOCALAPPDATA || path.join(env.USERPROFILE || os.homedir(), 'AppData', 'Local');
    push(path.join(local, 'AAAAGENT', 'dsh-home'));
    // 其它桌宠/工具可能把 home 放在 Local 下的某个子目录里（有界扫描，最多 40 个）
    for (const dir of listDirs(local).slice(0, 40)) {
        const cand = path.join(dir, 'dsh-home');
        if (existsSync(cand)) push(cand);
    }
    return out;
}

/** 候选 npm 全局前缀（不执行 npm，纯路径推断）。 */
export function candidateNpmPrefixes(env = process.env) {
    const out = [];
    const push = (p) => {
        if (p && !out.includes(p)) out.push(p);
    };
    push(env.APPDATA ? path.join(env.APPDATA, 'npm') : null);
    push(env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'pnpm') : null);
    push(env.ProgramFiles ? path.join(env.ProgramFiles, 'nodejs') : null);
    push(env['ProgramFiles(x86)'] ? path.join(env['ProgramFiles(x86)'], 'nodejs') : null);
    return out;
}

/** 候选桌面端安装目录（只查 Resources/app 带内核包的那种）。 */
export function candidateDesktopDirs(env = process.env) {
    const out = [];
    const seen = new Set();
    const push = (p) => {
        if (!p || seen.has(p)) return;
        seen.add(p);
        out.push(p);
    };
    push(env.DSH_DESKTOP_DIR);
    const roots = [
        env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs') : null,
        env.ProgramFiles,
        env['ProgramFiles(x86)'],
        env.SystemDrive ? path.join(env.SystemDrive + path.sep, 'DSH DESKTOP') : null,
        'D:\\DSH DESKTOP',
    ].filter(Boolean);
    for (const root of roots) {
        for (const dir of listDirs(root).slice(0, 60)) {
            if (existsSync(path.join(dir, 'resources', 'app', 'package.json'))) push(dir);
        }
        // 根目录自身也可能就是安装目录
        if (existsSync(path.join(root, 'resources', 'app', 'package.json'))) push(root);
    }
    return out;
}

function engineFromNpmPrefix(prefix) {
    const pkgPath = path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
    if (!existsSync(pkgPath)) return null;
    const j = readJsonSafe(pkgPath);
    if (!j) return null;
    return {
        kind: 'npm',
        id: 'npm:' + prefix,
        label: 'npm 全局内核 ' + String(j.version || '?'),
        version: String(j.version || 'unknown'),
        path: pkgPath,
        dir: prefix,
    };
}

function engineFromDesktop(dir) {
    const pkgPath = path.join(dir, 'resources', 'app', 'package.json');
    const j = readJsonSafe(pkgPath);
    if (!j) return null;
    const kernelPkg = path.join(dir, 'resources', 'app', 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
    const kernel = existsSync(kernelPkg) ? readJsonSafe(kernelPkg) : null;
    return {
        kind: 'desktop',
        id: 'desktop:' + dir,
        label: '桌面端 ' + String(j.version || j.name || '?'),
        version: String(j.version || 'unknown'),
        kernelVersion: kernel ? String(kernel.version || 'unknown') : null,
        path: pkgPath,
        dir,
    };
}

function profilesOfHome(home, maxProfiles, maxLogBytes) {
    const profilesDir = path.join(home, 'profiles');
    const out = [];
    // 只认真正的 profile 目录：node_modules / 隐藏目录 / scope 目录都不算
    const candidates = listDirs(profilesDir).filter((d) => !/^(node_modules|@|\.)/.test(path.basename(d)));
    for (const dir of candidates.slice(0, maxProfiles)) {
        const pj = readJsonSafe(path.join(dir, 'package.json'));
        const bundles = pj && pj.dsh && pj.dsh.profile && Array.isArray(pj.dsh.profile.bundles) ? pj.dsh.profile.bundles : [];
        const deps = pj && pj.dependencies ? Object.keys(pj.dependencies) : [];
        const patchFile = path.join(dir, 'cordis.patch.yml');
        const patch = existsSync(patchFile) ? safeReadText(patchFile, { roots: [dir], maxBytes: maxLogBytes }) : null;
        const ports = new Set();
        if (patch && patch.ok) {
            for (const m of patch.text.matchAll(/\bport:\s*(\d{2,5})\b/g)) ports.add(Number(m[1]));
        }
        out.push({
            name: path.basename(dir),
            dir,
            bundles,
            deps,
            hasPatch: Boolean(patch && patch.ok),
            declaredPorts: [...ports],
            lastWrite: safeMtime(patchFile),
        });
    }
    return out;
}

function safeMtime(file) {
    try {
        return existsSync(file) ? Number(statSync(file).mtimeMs) : null;
    } catch {
        return null;
    }
}

/** 端口连通性探测（纯 TCP，无 HTTP 语义，超时可配）。 */
export function probePort(port, timeoutMs = DEFAULT_LIMITS.httpTimeoutMs) {
    return new Promise((resolve) => {
        const started = process.hrtime.bigint();
        const sock = net.connect({ host: '127.0.0.1', port, timeout: timeoutMs });
        let settled = false;
        const done = (open) => {
            if (settled) return;
            settled = true;
            const ms = Number(process.hrtime.bigint() - started) / 1e6;
            try {
                sock.destroy();
            } catch {
                /* ignore */
            }
            resolve({ port, open, ms: Math.round(ms) });
        };
        sock.once('connect', () => done(true));
        sock.once('timeout', () => done(false));
        sock.once('error', () => done(false));
    });
}

/**
 * 主入口：发现本机所有引擎/实例。
 * 返回结构是**纯数据**，可直接交给 report.js 渲染，也便于单测。
 */
export async function discover(options = {}) {
    const env = options.env || process.env;
    const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
    const ports = Array.isArray(options.ports) && options.ports.length ? options.ports : DEFAULT_PORTS;
    const warnings = [];

    const homes = [];
    for (const dir of candidateHomes(env)) {
        const exists = existsSync(dir);
        if (!exists) continue;
        const profiles = profilesOfHome(dir, limits.maxProfiles, limits.maxLogBytes);
        if (profiles.length === 0 && path.basename(dir) !== '.dsh') {
            // 不是 DSH_HOME（没有 profiles 目录）就别硬算
            continue;
        }
        homes.push({ dir, profiles, profileCount: profiles.length });
    }
    if (homes.length === 0) warnings.push('没找到任何 DSH_HOME（可用 DSH_HOME 环境变量显式指定）');

    const engines = [];
    for (const prefix of candidateNpmPrefixes(env)) {
        const e = engineFromNpmPrefix(prefix);
        if (e) engines.push(e);
    }
    for (const dir of candidateDesktopDirs(env)) {
        const e = engineFromDesktop(dir);
        if (e) engines.push(e);
    }
    if (engines.length === 0) warnings.push('没发现 npm 全局内核或桌面端安装（共享版插件可只依赖 profile 发现）');

    const portResults = await Promise.all(ports.map((p) => probePort(p, limits.httpTimeoutMs)));
    const running = portResults.filter((r) => r.open);

    return {
        generatedAt: new Date().toISOString(),
        platform: process.platform,
        node: process.version,
        host: os.hostname(),
        homes,
        engines,
        declaredPorts: [...new Set(homes.flatMap((h) => h.profiles.flatMap((p) => p.declaredPorts)))],
        probedPorts: portResults,
        running,
        warnings,
    };
}
