/**
 * dsh-doctor / lib/client.js —— 浏览器侧模块（DSH 的自定义模块格式）
 *
 * 由 `dsh.client` + `exports["./client"]` 声明，宿主加载后调用 factory。
 * 0.2.0 起往设置面板左栏注册**两页**：
 *
 *   「体检」     settings.section / dsh-doctor-check      —— 读宿主路由，看最近一次结论并可现场重扫
 *   「贡献病例」 settings.section / dsh-doctor-contribute  —— 四步贡献流程（原样保留）
 *
 * 约束（来自 cordis-plugin-development/references/ui-plugin.md）：
 *   - factory 本身无副作用；注册通过 ctx.slots.inject/register 完成，返回清理函数；
 *   - 不替换应用根、不追加第二个应用；
 *   - 样式继承宿主主题变量。
 *
 * 降级：「体检」页的数据来自 `/dsh-doctor/api/report`。宿主不支持 webServer 时请求会失败，
 * 页面改成"复制命令"视图 —— **绝不白屏**。
 */

window.__ModuleLoader__.load({
    // 加载器按**包名**登记客户端模块（实测同类 scoped 插件如此），所以这里必须与 package.json 的 name 一致
    id: '@qweit-crystal/dsh-doctor',
    factory(require) {
        const React = require('react');
        const h = React.createElement;
        const { useEffect, useState } = React;

        const card = {
            border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))',
            borderRadius: 10,
            padding: '14px 16px',
            marginBottom: 14,
            color: 'var(--dsw-alias-label-primary, inherit)',
        };
        const muted = { color: 'var(--dsw-alias-label-secondary, inherit)', fontSize: 13, lineHeight: '20px' };
        const titleStyle = { fontSize: 15, fontWeight: 600, margin: '0 0 8px' };
        const pre = {
            margin: '8px 0 0',
            padding: '10px 12px',
            borderRadius: 8,
            background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.12))',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            fontSize: 12.5,
            lineHeight: '19px',
            whiteSpace: 'pre',
            overflowX: 'auto',
        };
        const TONE = {
            fault: { color: '#d03050', label: '故障' },
            warn: { color: '#d98b00', label: '注意' },
            unknown: { color: '#7a5af8', label: '无法取证' },
            info: { color: '#5b7bb2', label: '信息' },
            ok: { color: '#2e9e5b', label: '正常' },
        };

        // ---------------------------------------------------------------- 体检页
        const API = '/dsh-doctor/api/report';

        function Counts({ summary }) {
            if (!summary) return null;
            const parts = [
                ['故障', summary.fault],
                ['注意', summary.warn],
                ['无法取证', summary.unknown],
                ['信息', summary.info],
                ['正常', summary.ok],
            ];
            return h(
                'div',
                { style: { ...muted, marginTop: 4 } },
                parts.map(([k, v]) => `${k} ${v}`).join(' · '),
            );
        }

        function FindingRow({ f, i }) {
            const tone = TONE[f.level] || TONE.info;
            const [copied, setCopied] = useState(false);
            const draft = 'dsh-doctor case-from ' + f.id;
            const copy = () => {
                const done = () => setCopied(true);
                if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(draft).then(done, done);
                else done();
            };
            return h(
                'li',
                { key: i, style: { marginBottom: 6, lineHeight: '21px' } },
                h('span', { style: { color: tone.color, fontWeight: 600 } }, '[' + tone.label + ']'),
                ' ',
                h('span', null, f.area + '：' + f.text),
                f.caseId ? h('span', { style: { ...muted } }, ' → 案例 ' + f.caseId) : null,
                (f.fix || []).length ? h('div', { style: { ...pre, marginTop: 4 } }, f.fix.join('\n')) : null,
                // 傻瓜式入口：这条结论本身就能起草病例（症状/判定签名/处置命令自动填）
                h(
                    'div',
                    { style: { marginTop: 4, fontSize: 12 } },
                    h(
                        'button',
                        {
                            type: 'button',
                            onClick: copy,
                            style: { border: '1px solid currentColor', background: 'transparent', color: 'inherit', opacity: 0.75, borderRadius: 6, padding: '1px 8px', cursor: 'pointer', fontSize: 12 },
                        },
                        copied ? '已复制命令' : '写成案例',
                    ),
                    h('span', { style: { ...muted, marginLeft: 6 } }, copied ? draft : '复制一条命令即可，不用从空白模板开始'),
                ),
            );
        }

        function CheckSection() {
            const [state, setState] = useState({ loading: true, error: null, payload: null, ranAt: null });

            const load = (method) => {
                setState((s) => ({ ...s, loading: true, error: null }));
                fetch(API, { method, headers: { 'content-type': 'application/json', 'x-dsh-doctor': '1' } })
                    .then((r) => (r.ok ? r.json() : r.json().then((body) => Promise.reject(new Error((body && body.error) || r.status)))))
                    .then((data) => {
                        const run = method === 'POST' ? data.run : data.latest;
                        setState({ loading: false, error: run ? null : 'no-run', payload: run || null, ranAt: new Date().toLocaleTimeString() });
                    })
                    .catch((e) => setState({ loading: false, error: String((e && e.message) || e), payload: null, ranAt: null }));
            };

            useEffect(() => {
                load('GET');
            }, []);

            if (state.loading) {
                return h('div', { style: { padding: '4px 2px 20px' } }, h('p', { style: muted }, '正在读取最近一次体检…'));
            }

            if (state.error) {
                const unavailable = state.error !== 'no-run';
                return h('div', { style: { padding: '4px 2px 20px', maxWidth: 760 } }, [
                    h('h2', { key: 'h', style: { fontSize: 17, fontWeight: 600, margin: '0 0 6px' } }, '体检'),
                    h(
                        'p',
                        { key: 'lead', style: { ...muted, margin: '0 0 14px' } },
                        unavailable
                            ? '这个宿主没有给插件提供 HTTP 路由，页面拿不到实时结论 —— 用下面两条里任意一条。'
                            : '还没有体检记录。点「重新扫描」，或让 Agent 调 doctor_check。',
                    ),
                    h('div', { key: 'k', style: card }, [
                        h('div', { key: 't', style: titleStyle }, '在对话里'),
                        h('div', { key: 'b', style: { fontSize: 13.5, lineHeight: '22px' } }, '让 Agent 调用 doctor_check（结果会渲染成报告，也会落进历史）。'),
                    ]),
                    h('div', { key: 'k2', style: card }, [
                        h('div', { key: 't2', style: titleStyle }, '在终端里'),
                        h('pre', { key: 'p2', style: pre }, 'dsh-doctor check\n# 只看最近一次历史：\ndsh-doctor runs'),
                    ]),
                    h(
                        'button',
                        {
                            key: 'retry',
                            type: 'button',
                            onClick: () => load(unavailable ? 'GET' : 'POST'),
                            style: { padding: '6px 14px', borderRadius: 8, border: '1px solid currentColor', background: 'transparent', color: 'inherit', cursor: 'pointer' },
                        },
                        unavailable ? '重试' : '开始体检',
                    ),
                ]);
            }

            const p = state.payload;
            const findings = p.findings || [];
            return h('div', { style: { padding: '4px 2px 20px', maxWidth: 760 } }, [
                h(
                    'div',
                    { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' } },
                    h('h2', { style: { fontSize: 17, fontWeight: 600, margin: 0 } }, '体检'),
                    h(
                        'span',
                        { style: { color: (TONE[p.verdict] || TONE.info).color, fontWeight: 700 } },
                        (TONE[p.verdict] || TONE.info).label,
                    ),
                    h('span', { style: muted }, p.generatedAt ? new Date(p.generatedAt).toLocaleString() : ''),
                    h(
                        'button',
                        {
                            type: 'button',
                            onClick: () => load('POST'),
                            style: { marginLeft: 'auto', padding: '5px 12px', borderRadius: 8, border: '1px solid currentColor', background: 'transparent', color: 'inherit', cursor: 'pointer' },
                        },
                        '重新扫描',
                    ),
                ),
                h(Counts, { key: 'c', summary: p.summary }),
                h(
                    'div',
                    { key: 'list', style: { ...card, marginTop: 12 } },
                    findings.length
                        ? h('ul', { style: { margin: 0, paddingLeft: 20, fontSize: 13.5 } }, findings.map((f, i) => h(FindingRow, { key: i, f, i })))
                        : h('div', { style: muted }, '没有结论 —— 这一轮什么都没发现。'),
                ),
                p.verdict === 'unknown'
                    ? h(
                          'div',
                          { key: 'unk', style: { ...muted, marginTop: -4 } },
                          '判定是「无法取证」：这一轮有探测没完成，所以"全绿"不能当真。修完权限后点「重新扫描」。',
                      )
                    : null,
            ]);
        }

        // ---------------------------------------------------------------- 贡献病例页
        const STEPS = [
            '让 Agent 调用 doctor_contribute，把这次故障写进本地库 —— 落盘前已强制脱敏。',
            '在插件仓库目录执行下面这条命令（一条就够）。',
            '它会自动完成：脱敏入册 → 重建索引 → 机械检查 → 建分支 → 推送 → 开 PR。',
            '你只等 CI 绿 + 维护者 review 合并；之后其他人 git pull 就能拿到。',
        ];

        const COMMANDS = ['# 本地库里的草稿会显示在 doctor_contribute 的回执里', 'node tools/contribute.mjs --from "<本地库>/<病例>.md" --pr'].join('\n');

        function ContributeSection() {
            return h('div', { style: { padding: '4px 2px 20px', maxWidth: 760 } }, [
                h('h2', { key: 'h', style: { fontSize: 17, fontWeight: 600, margin: '0 0 6px' } }, '贡献病例'),
                h(
                    'p',
                    { key: 'lead', style: { ...muted, margin: '0 0 14px' } },
                    '共享案例库靠「审阅」增长：插件不联网、不上报，也不会自动把你的病例发出去。' +
                        '本地库随便写，想共享的才提 PR。',
                ),

                h('div', { key: 'k1', style: card }, [
                    h('div', { key: 't', style: titleStyle }, '四步'),
                    h(
                        'ol',
                        { key: 'l', style: { margin: 0, paddingLeft: 20, fontSize: 13.5, lineHeight: '22px' } },
                        STEPS.map((text, i) => h('li', { key: i, style: { marginBottom: 6 } }, text)),
                    ),
                ]),

                h('div', { key: 'k2', style: card }, [
                    h('div', { key: 't', style: titleStyle }, '提 PR 前跑这两条'),
                    h('pre', { key: 'p', style: pre }, COMMANDS),
                    h(
                        'div',
                        { key: 'n', style: { ...muted, marginTop: 8 } },
                        'CI（.github/workflows/case-check.yml）会再跑一遍：文件名、必备章节、指纹泄漏、索引一致性。',
                    ),
                ]),

                h('div', { key: 'k3', style: card }, [
                    h('div', { key: 't', style: titleStyle }, '两个库在哪'),
                    h(
                        'div',
                        { key: 'b', style: { fontSize: 13.5, lineHeight: '22px' } },
                        '共享库：插件包内 docs/cases（随包分发，只读）',
                    ),
                    h(
                        'div',
                        { key: 'l', style: { fontSize: 13.5, lineHeight: '22px' } },
                        '本地库：$DSH_HOME/dsh-doctor/cases（本机沉淀，doctor_case_add 写入）',
                    ),
                    h(
                        'div',
                        { key: 'n', style: { ...muted, marginTop: 8 } },
                        '想在对话里看两库清单，让 Agent 调用 doctor_cases 即可。',
                    ),
                ]),
            ]);
        }

        // ---------------------------------------------------------------- 头部小徽章
        // 槽位契约（实测自同类插件）：register({name,id,order,registrant,inject(sessionId)})，
        // 组件拿到的是 inject() 的返回值。
        const BADGE_TONE = {
            fault: '#d03050',
            warn: '#d98b00',
            unknown: '#7a5af8',
            ok: '#2e9e5b',
            idle: 'rgba(128,128,128,.55)',
        };

        function HeaderBadge(props) {
            const [state, setState] = useState({ ready: false, hidden: false, verdict: 'idle', payload: null, unavailable: false, repair: null, showRepair: false });
            const [open, setOpen] = useState(false);

            const refresh = (method) => {
                fetch(API, { method, headers: { 'content-type': 'application/json', 'x-dsh-doctor': '1' } })
                    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
                    .then((data) => {
                        const run = method === 'POST' ? data.run : data.latest;
                        const hidden = Boolean(data.ui && data.ui.headerBadge === false);
                        const repair = run && run.repair && run.repair.detected ? run.repair : null;
                        let showRepair = false;
                        if (repair && run.generatedAt) {
                            try {
                                showRepair = localStorage.getItem('dsh-doctor:repair:' + run.generatedAt) !== '1';
                            } catch {
                                showRepair = true;
                            }
                        }
                        setState({ ready: true, hidden, verdict: (run && run.verdict) || 'idle', payload: run || null, unavailable: false, repair, showRepair });
                    })
                    .catch(() => setState({ ready: true, hidden: false, verdict: 'idle', payload: null, unavailable: true, repair: null, showRepair: false }));
            };

            const dismissRepair = () => {
                const at = state.payload && state.payload.generatedAt;
                if (at) {
                    try {
                        localStorage.setItem('dsh-doctor:repair:' + at, '1');
                    } catch {
                        /* 存不了就算了，下次还会提醒 */
                    }
                }
                setState((s) => ({ ...s, showRepair: false }));
            };

            useEffect(() => {
                refresh('GET');
            }, []);

            if (state.hidden) return null;

            const dot = h('span', {
                style: {
                    display: 'inline-block',
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: BADGE_TONE[state.verdict] || BADGE_TONE.idle,
                    marginRight: 6,
                },
            });

            const button = h(
                'button',
                {
                    type: 'button',
                    title: 'DSH 体检（dsh-doctor）',
                    onClick: () => {
                        setOpen(!open);
                        if (!open) refresh('GET');
                    },
                    style: {
                        display: 'inline-flex',
                        alignItems: 'center',
                        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3))',
                        background: 'transparent',
                        color: 'inherit',
                        borderRadius: 8,
                        padding: '3px 9px',
                        fontSize: 12.5,
                        cursor: 'pointer',
                        lineHeight: '18px',
                    },
                },
                [dot, h('span', { key: 't' }, '体检')],
            );

            const modal =
                state.showRepair && state.repair
                    ? h(RepairPrompt, { repair: state.repair, onDismiss: dismissRepair })
                    : null;
            if (!open) return h('div', { style: { position: 'relative', display: 'inline-block' } }, [button, modal]);

            const p = state.payload;
            const findings = (p && p.findings) || [];
            const top = findings.filter((f) => f.level === 'fault' || f.level === 'warn' || f.level === 'unknown').slice(0, 3);
            const pop = h(
                'div',
                {
                    style: {
                        position: 'absolute',
                        top: 'calc(100% + 6px)',
                        right: 0,
                        width: 340,
                        maxWidth: '78vw',
                        zIndex: 60,
                        background: 'var(--dsw-alias-bg-layer-1, rgba(24,26,31,.98))',
                        color: 'var(--dsw-alias-label-primary, inherit)',
                        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3))',
                        borderRadius: 10,
                        padding: '12px 14px',
                        boxShadow: '0 8px 24px rgba(0,0,0,.28)',
                        textAlign: 'left',
                    },
                },
                [
                    h('div', { key: 'h', style: { fontWeight: 600, marginBottom: 6 } }, state.unavailable ? '体检不可用' : p ? (TONE[p.verdict] || TONE.info).label : '还没有体检记录'),
                    state.unavailable
                        ? h('div', { key: 'u', style: { ...muted, color: 'inherit' } }, '这个宿主没有把体检路由暴露给页面。可以在对话里让 Agent 调 doctor_check。')
                        : p
                          ? h('ul', { key: 'l', style: { margin: '0 0 8px', paddingLeft: 18, fontSize: 12.5, lineHeight: '20px', color: 'inherit' } }, top.map((f, i) => h('li', { key: i }, f.text)))
                          : h('div', { key: 'n', style: { ...muted, color: 'inherit' } }, '点下面的按钮跑一次。'),
                    h(
                        'div',
                        { key: 'b', style: { display: 'flex', gap: 8, marginTop: 4 } },
                        [
                            h(
                                'button',
                                {
                                    key: 'run',
                                    type: 'button',
                                    onClick: () => refresh('POST'),
                                    style: { border: '1px solid currentColor', background: 'transparent', color: 'inherit', borderRadius: 7, padding: '3px 10px', fontSize: 12.5, cursor: 'pointer' },
                                },
                                '重新扫描',
                            ),
                            h('span', { key: 'hint', style: { ...muted, color: 'inherit', fontSize: 12 } }, '详细内容见 设置 → 体检'),
                        ],
                    ),
                ],
            );

            return h('div', { style: { position: 'relative', display: 'inline-block' } }, [button, pop, modal]);
        }

        // ---------------------------------------------------------------- 修好之后的贡献提醒
        // 只在"上一轮不是全绿 → 这一轮全绿"时出现（服务端算好放在 payload.repair）；
        // 用户点「忽略」后按这次的时间戳记住，不再打扰。
        function RepairPrompt({ repair, onDismiss }) {
            const [copied, setCopied] = useState(false);
            const tpl = repair && repair.template ? repair.template : '';
            const copy = () => {
                const done = () => setCopied(true);
                if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(tpl).then(done, done);
                else done();
            };
            return h(
                'div',
                {
                    style: {
                        position: 'fixed',
                        inset: 0,
                        zIndex: 90,
                        background: 'rgba(0,0,0,.45)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: 20,
                    },
                },
                h(
                    'div',
                    {
                        style: {
                            width: 460,
                            maxWidth: '92vw',
                            background: 'var(--dsw-alias-bg-layer-1, #1e2128)',
                            color: 'var(--dsw-alias-label-primary, inherit)',
                            border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3))',
                            borderRadius: 12,
                            padding: '18px 20px',
                            boxShadow: '0 12px 36px rgba(0,0,0,.35)',
                        },
                    },
                    [
                        h('div', { key: 't', style: { fontSize: 16, fontWeight: 600, marginBottom: 8 } }, '这次的坑修好了 🎉'),
                        h(
                            'div',
                            { key: 'b', style: { fontSize: 13.5, lineHeight: '22px', marginBottom: 12 } },
                            `上一轮还有 ${repair.fixedCount || 0} 项问题，这一轮全绿了。花两分钟把它写成案例，下一个人就不用再查一遍。`,
                        ),
                        h(
                            'div',
                            { key: 's', style: { ...muted, color: 'inherit', marginBottom: 12 } },
                            '模板已经按这次的情况填好骨架（症状来自上一轮结论）；根因和处置补一下就能提 PR。',
                        ),
                        h('div', { key: 'btns', style: { display: 'flex', gap: 8, flexWrap: 'wrap' } }, [
                            h(
                                'button',
                                {
                                    key: 'copy',
                                    type: 'button',
                                    onClick: copy,
                                    style: { border: '1px solid currentColor', background: 'transparent', color: 'inherit', borderRadius: 8, padding: '5px 12px', cursor: 'pointer' },
                                },
                                copied ? '已复制' : '复制病例模板',
                            ),
                            h(
                                'button',
                                {
                                    key: 'open',
                                    type: 'button',
                                    onClick: () => window.open('/dsh-doctor/api/report', '_self'),
                                    style: { border: '1px solid currentColor', background: 'transparent', color: 'inherit', borderRadius: 8, padding: '5px 12px', cursor: 'pointer' },
                                },
                                '看报告',
                            ),
                            h(
                                'button',
                                {
                                    key: 'dismiss',
                                    type: 'button',
                                    onClick: onDismiss,
                                    style: { marginLeft: 'auto', border: 'none', background: 'transparent', color: 'inherit', opacity: 0.7, borderRadius: 8, padding: '5px 12px', cursor: 'pointer' },
                                },
                                '忽略这次',
                            ),
                        ]),
                        h(
                            'div',
                            { key: 'how', style: { ...muted, color: 'inherit', marginTop: 10, fontSize: 12 } },
                            '写完用 doctor_case_add 存进本地库，或直接放到仓库 docs/cases/ 提 PR（设置 → 贡献病例有完整步骤）。',
                        ),
                    ],
                ),
            );
        }

        return {
            inject: ['slots'],
            apply(ctx) {
                ctx.slots.inject('settings.section', () =>
                    ctx.slots.register(
                        { name: 'settings.section', id: 'dsh-doctor-check', order: 930, label: () => '体检' },
                        CheckSection,
                    ),
                );
                ctx.slots.inject('settings.section', () =>
                    ctx.slots.register(
                        { name: 'settings.section', id: 'dsh-doctor-contribute', order: 940, label: () => '贡献病例' },
                        ContributeSection,
                    ),
                );
                ctx.slots.inject('conversation.session.header.utilities', () =>
                    ctx.slots.register(
                        {
                            name: 'conversation.session.header.utilities',
                            id: 'dsh-doctor-badge',
                            order: 30,
                            registrant: 'dsh-doctor',
                            inject: (sessionId) => ({ sessionId }),
                        },
                        HeaderBadge,
                    ),
                );
            },
        };
    },
});
