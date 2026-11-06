/**
 * dsh-doctor / lib/semver-lite.js —— 够用的版本范围判定（零依赖）
 *
 * 为什么自己写：本插件的卖点是"零运行时依赖 + 零执行面"，不能为了比个版本号去装 semver、
 * 更不能 shell 出去问 npm。这里只实现 ABI 检查真正需要的那一小撮语法：
 *
 *   支持：  `*` / `x` / 空 / `1.2.3` / `=1.2.3` / `>=1.2.3` / `>1.2.3` / `<=` / `<`
 *          `^1.2.3` / `~1.2.3` / 空格分隔的合取 `>=0.2.0-rc.2 <0.3.0-0` / `||` 析取
 *   不支持：`1.x`、`~>1.2`、`workspace:*`、`file:`、`npm:` 别名、预发布标签通配等
 *
 * 对不支持的语法**返回 null 而不是猜**——上层把它变成 `unknown`（不判满足也不判不满足）。
 * 这条规则同样来自本机的教训：宁可说"不知道"，不要说出一个自信的错答案。
 */

/** 解析 "1.2.3-rc.2+build" → {major, minor, patch, pre:[...]}；失败返回 null。 */
export function parseVersion(input) {
    const s = String(input || '').trim();
    // 允许前面带 v（npm 生态常见）
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(s);
    if (!m) return null;
    const pre = m[4] ? m[4].split('.') : [];
    return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre };
}

function cmpIdent(a, b) {
    const an = /^\d+$/.test(a);
    const bn = /^\d+$/.test(b);
    if (an && bn) return Number(a) - Number(b);
    if (an) return -1; // 数字标识符 < 字母标识符
    if (bn) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
}

/** 比较两个已解析版本：a<b → -1，相等 → 0，a>b → 1。 */
export function compareVersion(a, b) {
    for (const k of ['major', 'minor', 'patch']) {
        if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
    }
    const ap = a.pre || [];
    const bp = b.pre || [];
    if (ap.length === 0 && bp.length === 0) return 0;
    if (ap.length === 0) return 1; // 正式版 > 预发布
    if (bp.length === 0) return -1;
    for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
        if (ap[i] === undefined) return -1;
        if (bp[i] === undefined) return 1;
        const c = cmpIdent(ap[i], bp[i]);
        if (c !== 0) return c < 0 ? -1 : 1;
    }
    return 0;
}

function bump(parsed, part) {
    return part === 'major'
        ? { major: parsed.major + 1, minor: 0, patch: 0, pre: [] }
        : { major: parsed.major, minor: parsed.minor + 1, patch: 0, pre: [] };
}

/**
 * 判定单个比较器。
 * @returns {boolean|null} null 表示"这个比较器我看不懂"
 */
function testComparator(version, token) {
    const t = token.trim();
    if (!t) return null;
    if (t === '*' || t === 'x' || t === 'X') return true;

    // ^ / ~ / >= / <= / > / < / =
    const m = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(t);
    if (!m) return null;
    const op = m[1] || '=';
    const target = parseVersion(m[2]);
    if (!target) return null;
    const c = compareVersion(version, target);

    if (op === '=') return c === 0;
    if (op === '>') return c > 0;
    if (op === '>=') return c >= 0;
    if (op === '<') return c < 0;
    if (op === '<=') return c <= 0;
    if (op === '^' || op === '~') {
        if (c < 0) return false;
        // ~1.2.3 → <1.3.0；^1.2.3 → <2.0.0（major=0 时 ^ 收紧到次版本）
        const upper = op === '~' ? bump(target, 'minor') : target.major === 0 ? bump(target, 'minor') : bump(target, 'major');
        return compareVersion(version, upper) < 0;
    }
    return null;
}

/**
 * 判定 version 是否满足 range。
 * @returns {boolean|null} null = 语法不支持（上层应当作 unknown）
 */
export function satisfies(version, range) {
    const v = parseVersion(version);
    if (!v) return null;
    const raw = String(range == null ? '' : range).trim();
    if (!raw) return null;
    // 明显不是版本范围的写法：不猜
    if (/^(workspace|file|link|npm|git|https?):/.test(raw) || raw.includes('://')) return null;

    let sawUnknown = false;
    // 析取：任一组满足即满足
    for (const group of raw.split('||')) {
        const tokens = group.trim().split(/\s+/).filter(Boolean);
        if (tokens.length === 0) continue;
        let all = true;
        for (const token of tokens) {
            const r = testComparator(v, token);
            if (r === null) {
                sawUnknown = true;
                all = false;
                break;
            }
            if (!r) {
                all = false;
                break;
            }
        }
        if (all) return true;
    }
    // 没有任何一组被完整判定为真；但如果出现过看不懂的 token，就不能断言"不满足"
    return sawUnknown ? null : false;
}
