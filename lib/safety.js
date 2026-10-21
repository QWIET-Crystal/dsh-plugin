/**
 * dsh-doctor / lib/safety.js —— 安全核心（纯函数为主，便于单测）
 *
 * 设计原则（对应 SECURITY.md 的威胁模型）：
 *   1. 本插件**不执行任何子进程**：不 import child_process / vm / eval / Function。
 *      → 结构性消除了"把日志/配置里的字符串当命令跑"这一类攻击（命令注入面为零）。
 *   2. 读文件必须落在**白名单根**内：realpath 之后比对，符号链接指向外面一律拒绝（防路径穿越）。
 *   3. 读取有上限：只读常规文件、按字节截断、超限显式标注 truncated（防 OOM / 卡死）。
 *   4. 输出前脱敏：用户名/主机名/绝对路径/疑似令牌 → 占位符；控制字符与 ANSI 转义剥除。
 *   5. 报告用代码围栏承载"外来文本"时，先中和 ``` 与反引号，防止数据逃出围栏变成 Markdown 指令。
 *
 * 这里刻意只放**纯判断/纯字符串**的逻辑，方便 `node --test` 在无宿主环境下覆盖。
 */

import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 全局默认上限；宿主 config 可覆盖（见 cordis.patch.yml）。 */
export const DEFAULT_LIMITS = Object.freeze({
    maxLogBytes: 2 * 1024 * 1024,
    maxProfiles: 32,
    httpTimeoutMs: 1200,
    maxStringLen: 20000,
    maxLogLines: 400,
});

const WINDOWS = process.platform === 'win32';

/** 统一路径比较口径：Windows 下大小写不敏感，分隔符归一。 */
function normPath(p) {
    const resolved = path.resolve(String(p));
    return WINDOWS ? resolved.toLowerCase() : resolved;
}

/**
 * 判断 target 是否落在 root 之内（root 自身算在内）。
 * 优先用 realpath（能识破符号链接逃逸）；文件不存在时退化为字面解析，
 * 并**明确返回 false**（不存在的东西不可能被"确认在白名单内"）。
 */
export function isInside(root, target) {
    if (!root || !target) return false;
    let realRoot;
    try {
        realRoot = realpathSync(root);
    } catch {
        // 白名单根本身可能还不存在（例如本地案例库目录尚未创建）：
        // 用它的"最近已存在祖先"作为基准，这样 root 之下的目标仍然判为在白名单内。
        const ancRoot = nearestExisting(root);
        realRoot = ancRoot ? realpathSync(ancRoot) : path.resolve(String(root));
    }
    let realTarget;
    try {
        realTarget = realpathSync(target);
    } catch {
        // 目标不存在：用"最近的已存在祖先"判断它**将要**落在哪里。
        // 对只读场景这是安全的（读失败会得到 ENOENT），且能给出准确的错误语义；
        // 仍然拒绝任何穿过 .. 或经由真实路径逃出白名单的情况。
        const anc = nearestExisting(target);
        if (!anc) return false;
        let realAnc;
        try {
            realAnc = realpathSync(anc);
        } catch {
            realAnc = path.resolve(anc);
        }
        const r0 = normPath(realRoot);
        const a0 = normPath(realAnc);
        const insideAnc = a0 === r0 || a0.startsWith(r0.endsWith(path.sep) ? r0 : r0 + path.sep);
        if (!insideAnc) return false;
        const rest = path.relative(anc, path.resolve(String(target)));
        return !rest.split(path.sep).includes('..');
    }
    const r = normPath(realRoot);
    const t = normPath(realTarget);
    if (r === t) return true;
    const withSep = r.endsWith(path.sep) ? r : r + path.sep;
    return t.startsWith(withSep);
}

/** 逐级向上找到一个真实存在的祖先（用于 realpath 不可用时的兜底判断）。 */
export function nearestExisting(p) {
    let cur = path.resolve(String(p));
    for (;;) {
        try {
            statSync(cur);
            return cur;
        } catch {
            const parent = path.dirname(cur);
            if (parent === cur) return null;
            cur = parent;
        }
    }
}

/**
 * 有上限的只读文件访问：只接受常规文件、必须在白名单根内、按字节截断。
 * 永不抛异常；失败以 { ok:false, reason } 返回，调用方据此给用户可读解释。
 */
export function safeReadText(file, { roots = [], maxBytes = DEFAULT_LIMITS.maxLogBytes, encoding = 'utf8' } = {}) {
    const target = String(file || '');
    if (!target) return { ok: false, reason: 'empty-path' };
    if (!Array.isArray(roots) || roots.length === 0) return { ok: false, reason: 'no-allowlist' };
    const allowed = roots.some((root) => isInside(root, target));
    if (!allowed) return { ok: false, reason: 'outside-allowlist' };
    let st;
    try {
        st = statSync(target);
    } catch (e) {
        return { ok: false, reason: e && e.code === 'ENOENT' ? 'missing' : 'stat-failed' };
    }
    if (!st.isFile()) return { ok: false, reason: 'not-a-regular-file' };
    const cap = Math.max(1, Math.min(Number(maxBytes) || DEFAULT_LIMITS.maxLogBytes, DEFAULT_LIMITS.maxLogBytes));
    const len = Math.min(st.size, cap);
    const buf = Buffer.alloc(len);
    let fd;
    try {
        fd = openSync(target, 'r');
        const read = readSync(fd, buf, 0, len, 0);
        return {
            ok: true,
            text: buf.subarray(0, read).toString(encoding),
            truncated: st.size > read,
            bytes: read,
            totalBytes: st.size,
        };
    } catch {
        return { ok: false, reason: 'read-failed' };
    } finally {
        if (fd !== undefined) {
            try {
                closeSync(fd);
            } catch {
                /* 关闭失败不影响已读到的内容 */
            }
        }
    }
}

/** 当前机器的身份指纹（用于脱敏；只在本机内存里用，不落盘）。 */
export function localIdentity(env = process.env) {
    return {
        userName: env.USERNAME || env.USER || '',
        hostName: os.hostname() || '',
        homeDir: env.USERPROFILE || os.homedir() || '',
        tempDir: os.tmpdir() || '',
    };
}

const SECRET_RULES = [
    // GitHub / 通用平台令牌
    [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '<redacted-token>'],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '<redacted-token>'],
    // OpenAI / 兼容网关风格
    [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '<redacted-token>'],
    [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '<redacted-token>'],
    // Authorization 头
    [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 <redacted>'],
    // 键值形态的密钥
    [/\b(api[_-]?key|apikey|secret|token|password|passwd)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/gi, '$1=<redacted>'],
    // URL 里的 userinfo（https://user:pass@host）
    [/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1<redacted>@'],
];

/** 剥除控制字符与 ANSI 转义（外来日志可能带终端控制序列）。 */
export function stripControl(input) {
    let s = String(input ?? '');
    // eslint-disable-next-line no-control-regex
    s = s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
    // 保留 \n \t，其余 C0/C1 控制符一律去掉
    // eslint-disable-next-line no-control-regex
    s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '');
    return s;
}

/**
 * 脱敏：把本机指纹与疑似令牌替换成占位符，并剥控制字符。
 * 这是**输出前**的最后一道工序；纯字符串操作，无 I/O。
 */
export function redact(input, identity = localIdentity(), { keepHomePath = false } = {}) {
    let s = stripControl(input);
    if (!keepHomePath && identity.homeDir) {
        // 先替换更长的 home 路径，再处理主机名/用户名
        const homePattern = /\\/g.test(identity.homeDir)
            ? new RegExp(escapeRegExp(identity.homeDir), 'gi')
            : new RegExp(escapeRegExp(identity.homeDir), 'g');
        s = s.replace(homePattern, '<home>');
    }
    if (identity.tempDir) {
        s = s.replace(new RegExp(escapeRegExp(identity.tempDir), 'gi'), '<temp>');
    }
    if (identity.hostName && identity.hostName.length >= 3) {
        s = s.replace(new RegExp(escapeRegExp(identity.hostName), 'gi'), '<host>');
    }
    if (identity.userName && identity.userName.length >= 2) {
        s = s.replace(new RegExp('\\b' + escapeRegExp(identity.userName) + '\\b', 'gi'), '<user>');
    }
    for (const [re, rep] of SECRET_RULES) s = s.replace(re, rep);
    return s;
}

/** 截断到上限，并保留"被截断"这个事实（不要静默丢信息）。 */
export function clampText(input, max = DEFAULT_LIMITS.maxStringLen) {
    const s = String(input ?? '');
    if (s.length <= max) return s;
    return s.slice(0, max) + `\n…（已截断，原长 ${s.length} 字符）`;
}

/**
 * 把**外来文本**安全地放进 Markdown 代码围栏。
 * 关键：中和反引号与围栏序列，避免日志内容把围栏提前闭合、伪装成文档指令。
 */
export function fenceText(input, { lang = 'text', max = DEFAULT_LIMITS.maxStringLen } = {}) {
    const s = clampText(stripControl(input), max).replace(/`/g, '\u02cb'); // 反引号 → 修饰符字母重音符
    return '```' + lang + '\n' + s + '\n```';
}

/** 单行摘要：把多行压成一行，便于放进表格/清单。 */
export function oneLine(input, max = 200) {
    const s = stripControl(input).replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max) + '…' : s;
}

export function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 人类可读的字节数。 */
export function humanBytes(n) {
    const v = Number(n) || 0;
    if (v < 1024) return v + ' B';
    if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
    if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
    return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
