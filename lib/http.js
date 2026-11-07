/**
 * dsh-doctor / lib/http.js —— 给设置页用的宿主 HTTP 路由（0.2.0）
 *
 * 为什么需要它：浏览器侧模块拿不到 `doctor_check` 的结果（它跑在宿主进程里）。
 * 实测同类插件的做法是注册自己的路由、页面用 `fetch` 同源取 —— 这里照做：
 *
 *   GET  /dsh-doctor/api/report           读最近一次体检（不触发新的取证）
 *   GET  /dsh-doctor/api/report?run=<file> 读指定一条历史
 *   POST /dsh-doctor/api/report           现场跑一轮体检（会写 runs/，除非 saveRuns=false）
 *
 * 安全口径：
 *   - 只允许同源访问（不设 CORS 头，浏览器默认拒绝跨源读取）；
 *   - 返回的都是**落盘前已脱敏**的内容（runs/ 里存的就是脱敏后的版本）；
 *   - POST 有最小间隔保护，避免页面狂点把磁盘刷满。
 *
 * 宿主没有 `webServer` 服务时（例如某些精简宿主），注册会失败并返回 null ——
 * 设置页会降级成"复制命令"视图，而不是白屏。
 */

import { runCheck } from './check.js';
import { listRuns, readRun, resolveRunsDir } from './runs.js';

export const REPORT_ROUTE = '/dsh-doctor/api/report';
const MIN_POST_INTERVAL_MS = 2000;

function writeJson(res, code, obj) {
    const body = JSON.stringify(obj);
    try {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(body);
    } catch {
        /* 连接已断就算了 */
    }
}

/**
 * 造一个路由处理器（可单测：传假 req/res 即可）。
 *
 * @param {object} options
 * @param {string} options.runsDir     历史目录
 * @param {object} [options.checkOptions] POST 时传给 runCheck 的其它参数
 */
export function createReportHandler(options = {}) {
    const runsDir = options.runsDir || resolveRunsDir(process.env);
    const checkOptions = options.checkOptions || {};
    const ui = options.ui || {};
    let lastPostAt = 0;
    let running = false;

    return async function handler(req, res) {
        try {
            const method = String((req && req.method) || 'GET').toUpperCase();
            const url = new URL((req && req.url) || '/', 'http://dsh-doctor.invalid');

            if (method === 'GET') {
                const name = url.searchParams.get('run');
                const runs = listRuns(runsDir, 30);
                if (name) {
                    const hit = readRun(runsDir, name);
                    if (!hit.ok) return writeJson(res, 404, { ok: false, error: hit.reason || 'not-found' });
                    return writeJson(res, 200, { ok: true, ui, run: hit.doc });
                }
                const latest = runs[0] ? readRun(runsDir, runs[0].name) : null;
                return writeJson(res, 200, { ok: true, ui, runs, latest: latest && latest.ok ? latest.doc : null });
            }

            if (method === 'POST') {
                // CSRF 防线：跨源"简单请求"带不了自定义头（浏览器会先发预检，而我们不回 CORS 头）。
                // 没有这一条，任何网页都能对着 127.0.0.1:3080 打 POST 触发体检、写盘。
                const token = req.headers && (req.headers['x-dsh-doctor'] || req.headers['X-DSH-Doctor']);
                if (String(token || '') !== '1') return writeJson(res, 403, { ok: false, error: 'missing-csrf-header' });
                const now = Date.now();
                if (running) return writeJson(res, 429, { ok: false, error: 'busy' });
                if (now - lastPostAt < MIN_POST_INTERVAL_MS) return writeJson(res, 429, { ok: false, error: 'too-frequent' });
                running = true;
                try {
                    const payload = await runCheck({ ...checkOptions, saveRuns: checkOptions.saveRuns !== false });
                    lastPostAt = Date.now();
                    return writeJson(res, 200, { ok: true, ui, run: payload });
                } finally {
                    running = false;
                }
            }

            return writeJson(res, 405, { ok: false, error: 'method-not-allowed' });
        } catch {
            return writeJson(res, 500, { ok: false, error: 'internal' });
        }
    };
}

/**
 * 在宿主上注册路由。返回 disposer 或 null（宿主不支持时）。
 *
 * 注意：插件没有在 `inject` 里声明 `webServer`（否则缺少该服务的宿主会让整条 entry 不激活）。
 * 这里用 try/catch 探测：cordis 对"未声明就访问"会直接抛错，被捕获即降级。
 */
export function registerReportRoute(ctx, options = {}) {
    let webServer = null;
    try {
        webServer = ctx.webServer;
    } catch (e) {
        // 不静默：真机上就是这里被吞掉，导致面板一直降级而没人知道为什么
        console.warn(`[dsh-doctor] 读不到宿主 webServer 服务，设置页「体检」将降级为复制命令：${(e && e.message) || e}`);
        return null;
    }
    if (!webServer || typeof webServer.register !== 'function') {
        console.warn('[dsh-doctor] 宿主没有 webServer.register，设置页「体检」将降级为复制命令');
        return null;
    }
    const handler = createReportHandler(options);
    try {
        return ctx.effect(() => webServer.register({ kind: 'prefix', path: REPORT_ROUTE, handler }), 'dsh-doctor:report-route');
    } catch (e) {
        console.warn(`[dsh-doctor] 路由 ${REPORT_ROUTE} 注册失败：${(e && e.message) || e}`);
        return null;
    }
}
