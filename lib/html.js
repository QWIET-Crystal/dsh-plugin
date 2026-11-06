/**
 * dsh-doctor / lib/html.js —— 自包含 HTML 报告（插件与急救包**共用这一份实现**）
 *
 * 为什么单独做一份：终端里滚动的中文对新手不友好，而急救包运行时宿主已经死了，
 * 更没人给它解释"这行红字是什么意思"。HTML 双击就能用浏览器打开，能上色、能复制。
 *
 * 设计约束：
 *   1) **单文件零依赖**：内联 CSS/JS，不引用任何外部资源（离线也能看）；
 *   2) **三段式**：顶部"你现在该做什么"（一句话 + 一个动作）→ 中间问题卡片 → 底部折叠的技术细节；
 *   3) **外来文本按数据处理**：所有动态内容先 escapeHtml，再进 DOM；
 *   4) 插件路径与急救包路径都调这里，禁止第二份渲染实现（踩过"两份实现必然漂移"）。
 */

const LEVEL_TEXT = { fault: '故障', warn: '注意', unknown: '无法取证', info: '信息', ok: '正常' };
const LEVEL_COLOR = { fault: '#d03050', warn: '#d98b00', unknown: '#7a5af8', info: '#5b7bb2', ok: '#2e9e5b' };
const VERDICT_TEXT = { fault: '有故障', warn: '有注意项', unknown: '无法完整取证', ok: '一切正常' };

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** 一句话 + 一个动作：新手只需要读这一块。 */
export function headline(payload) {
    const findings = payload.findings || [];
    // 带 meta.headline 的结论优先（例如"装了却没在运行"）——它比别的问题更该被先看到
    const forced = findings
        .filter((f) => f.meta && f.meta.headline)
        .sort((a, b) => (a.level === 'warn' ? -1 : b.level === 'warn' ? 1 : 0))[0];
    if (forced) {
        const allDown = forced.id === 'PORT.ALL_HOSTS.DOWN';
        return {
            tone: forced.level === 'ok' ? 'ok' : forced.level,
            title: allDown ? 'DSH 没在运行' : '有服务没在运行',
            body: forced.text,
            action: (forced.fix && forced.fix[0]) || null,
            hint: forced.fix && forced.fix.length > 1 ? '还有别的命令，见下面的清单' : null,
        };
    }
    const pick = (lv) => findings.find((f) => f.level === lv);
    const fault = pick('fault');
    const unknown = pick('unknown');
    const warn = pick('warn');
    if (fault) {
        return {
            tone: 'fault',
            title: '有需要马上处理的问题',
            body: fault.text,
            action: (fault.fix && fault.fix[0]) || null,
            hint: fault.caseId ? `详细处置见案例 ${fault.caseId}` : null,
        };
    }
    if (unknown) {
        return {
            tone: 'unknown',
            title: '这次没能查全',
            body: `有 ${payload.summary?.unknown ?? 1} 项没拿到明确结果 —— 所以下面的"正常"不能当真。`,
            action: '用管理员权限重跑，或调大超时后重试',
            hint: unknown.text,
        };
    }
    if (warn) {
        return {
            tone: 'warn',
            title: '能照常用，但有一件事值得看一眼',
            body: warn.text,
            action: (warn.fix && warn.fix[0]) || null,
            hint: warn.caseId ? `详细处置见案例 ${warn.caseId}` : null,
        };
    }
    return {
        tone: 'ok',
        title: '一切正常',
        body: '本机所有 DSH 实例都活着，装配没有明显问题。',
        action: null,
        hint: null,
    };
}

function renderFinding(f) {
    const color = LEVEL_COLOR[f.level] || LEVEL_COLOR.info;
    const fixes = (f.fix || []).length
        ? `<pre class="cmd">${f.fix.map((c) => escapeHtml(c)).join('\n')}</pre>`
        : '';
    const caseHint = f.caseId ? `<span class="case">案例 ${escapeHtml(f.caseId)}</span>` : '';
    return `<li class="finding" style="border-left-color:${color}">
  <div class="row"><span class="tag" style="background:${color}">${escapeHtml(LEVEL_TEXT[f.level] || f.level)}</span>
  <span class="area">${escapeHtml(f.area)}</span>${caseHint}</div>
  <div class="text">${escapeHtml(f.text)}</div>${fixes}
</li>`;
}

/**
 * 渲染整份报告。
 *
 * @param {object} payload buildCheckPayload 的结果（建议先过 redactPayload）
 * @param {object} [opts]  { kit?: {version, generatedAt, chain, pluginRoot}, title? }
 * @returns {string} 完整 HTML
 */
export function renderHtml(payload, opts = {}) {
    const head = headline(payload);
    const summary = payload.summary || {};
    const findings = payload.findings || [];
    const kit = opts.kit || null;
    const generatedAt = payload.generatedAt || new Date().toISOString();
    const env = payload.environment || {};
    const title = opts.title || 'DSH 体检报告';

    const counts = [
        ['故障', summary.fault, LEVEL_COLOR.fault],
        ['注意', summary.warn, LEVEL_COLOR.warn],
        ['无法取证', summary.unknown, LEVEL_COLOR.unknown],
        ['信息', summary.info, LEVEL_COLOR.info],
        ['正常', summary.ok, LEVEL_COLOR.ok],
    ]
        .map(([k, v, c]) => `<span class="count"><b style="color:${c}">${Number(v) || 0}</b> ${escapeHtml(k)}</span>`)
        .join('');

    const actionBlock = head.action
        ? `<div class="action"><div class="action-label">下一步</div>
     <pre class="cmd" id="main-cmd">${escapeHtml(head.action)}</pre>
     <button class="copy" data-target="main-cmd">复制这条命令</button></div>`
        : '';

    const list = findings.length
        ? `<ul class="findings">${findings.map(renderFinding).join('')}</ul>`
        : '<p class="muted">没有结论 —— 这一轮什么都没发现。</p>';

    const json = escapeHtml(JSON.stringify(payload, null, 2).slice(0, 200000));

    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px; font:15px/1.65 "Segoe UI","Microsoft YaHei",system-ui,sans-serif; background:#f6f7f9; color:#1c1f24; }
  @media (prefers-color-scheme: dark) { body { background:#16181d; color:#e7e9ee; } .card { background:#1e2128 !important; } .muted{ color:#9aa0aa !important; } pre.cmd{ background:#11141a !important; } }
  .wrap { max-width: 880px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .meta { color:#6b7280; font-size:13px; margin-bottom: 18px; }
  .card { background:#fff; border-radius:12px; padding:18px 20px; margin-bottom:14px; box-shadow:0 1px 2px rgba(16,24,40,.06); }
  .hero { border-top: 4px solid ${LEVEL_COLOR[head.tone] || LEVEL_COLOR.info}; }
  .hero h2 { font-size:17px; margin:0 0 6px; color:${LEVEL_COLOR[head.tone] || LEVEL_COLOR.info}; }
  .hero p { margin:0 0 10px; }
  .action-label { font-size:12px; letter-spacing:.08em; color:#6b7280; text-transform:uppercase; margin-bottom:4px; }
  pre.cmd { background:#f3f4f6; border-radius:8px; padding:10px 12px; margin:6px 0; font:13px/1.5 ui-monospace,Consolas,monospace; white-space:pre-wrap; word-break:break-all; }
  button.copy { border:1px solid currentColor; background:transparent; color:inherit; border-radius:8px; padding:5px 12px; cursor:pointer; font-size:13px; }
  button.copy:active { transform: translateY(1px); }
  .counts { display:flex; gap:16px; flex-wrap:wrap; margin-bottom:14px; font-size:14px; }
  .count b { font-size:16px; }
  ul.findings { list-style:none; margin:0; padding:0; }
  li.finding { border-left:3px solid #ccc; padding:8px 0 8px 12px; margin-bottom:10px; }
  .row { display:flex; align-items:center; gap:8px; margin-bottom:2px; }
  .tag { color:#fff; border-radius:4px; padding:1px 7px; font-size:12px; }
  .area { font-weight:600; font-size:13px; }
  .case { color:#6b7280; font-size:12px; }
  .text { font-size:14px; }
  .muted { color:#6b7280; font-size:13px; }
  details { margin-top:6px; }
  summary { cursor:pointer; color:#6b7280; font-size:13px; }
  footer { color:#6b7280; font-size:12px; text-align:center; margin:22px 0 8px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>${escapeHtml(title)}</h1>
  <div class="meta">生成时间 ${escapeHtml(generatedAt)}${kit ? ` · 急救包 ${escapeHtml(kit.version || '?')}` : ''}${env.platform ? ` · ${escapeHtml(env.platform)}` : ''}</div>

  <div class="card hero">
    <h2>${escapeHtml(head.title)}</h2>
    <p>${escapeHtml(head.body)}</p>
    ${head.hint ? `<p class="muted">${escapeHtml(head.hint)}</p>` : ''}
    ${actionBlock}
  </div>

  <div class="counts">${counts}</div>

  ${
      payload.repair && payload.repair.detected
          ? `<div class="card" style="border-left:4px solid ${LEVEL_COLOR.ok}">
    <h2 style="font-size:16px;margin:0 0 6px;color:${LEVEL_COLOR.ok}">这次的坑修好了</h2>
    <p style="margin:0 0 8px">上一轮还有 ${Number(payload.repair.fixedCount) || 0} 项问题，这一轮全绿了。如果这次是你亲手修的，花两分钟写成案例，下一个人就不用再查一遍。</p>
    <p class="muted">写法：让 Agent 调 <code>doctor_case_add</code>（会自动脱敏），或把文件放进仓库 <code>docs/cases/</code> 提 PR。模板见 <code>docs/cases/_TEMPLATE.md</code>。</p>
  </div>`
          : ''
  }

  <div class="card">
    ${list}
  </div>

  <div class="card">
    <details>
      <summary>技术细节（完整结论 JSON，可复制给维护者）</summary>
      <pre class="cmd" id="raw-json">${json}</pre>
      <button class="copy" data-target="raw-json">复制 JSON</button>
    </details>
    ${kit && kit.chain ? `<p class="muted">运行环境探测链：${escapeHtml(kit.chain)}</p>` : ''}
  </div>

  <footer>dsh-doctor${kit && kit.pluginVersion ? ' ' + escapeHtml(kit.pluginVersion) : ''} · 只读取证，不修改任何东西</footer>
</div>
<script>
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('button.copy');
    if (!btn) return;
    var el = document.getElementById(btn.dataset.target);
    if (!el) return;
    var text = el.textContent || '';
    var done = function () { var old = btn.textContent; btn.textContent = '已复制'; setTimeout(function () { btn.textContent = old; }, 1200); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, done);
    else { var r = document.createRange(); r.selectNodeContents(el); var s = getSelection(); s.removeAllRanges(); s.addRange(r); done(); }
  });
</script>
</body>
</html>`;
}

export { escapeHtml, LEVEL_TEXT, LEVEL_COLOR, VERDICT_TEXT };
