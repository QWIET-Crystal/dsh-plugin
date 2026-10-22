/**
 * dsh-doctor / lib/client.js —— 浏览器侧模块（DSH 的自定义模块格式）
 *
 * 由 `dsh.client` + `exports["./client"]` 声明，宿主加载后调用 factory。
 * 在设置面板左栏注册一页「贡献病例」（槽位 settings.section），内容是共享案例库的四步贡献流程。
 *
 * 约束（来自 cordis-plugin-development/references/ui-plugin.md）：
 *   - factory 本身无副作用；注册通过 ctx.slots.inject/register 完成，返回清理函数；
 *   - 不替换应用根、不追加第二个应用；
 *   - 样式继承宿主主题变量。
 */

window.__ModuleLoader__.load({
    id: 'dsh-doctor',
    factory(require) {
        const React = require('react');
        const h = React.createElement;

        const STEPS = [
            '在对话里让我调用 doctor_case_add，把这次的故障写进本地库（自动脱敏；共享库只读，不会误写）。',
            '把生成的 .md 复制进插件仓库的 docs/cases/ 目录。',
            '重建索引并做机械检查：node tools/index-cases.mjs 与 node tools/lint-cases.mjs。',
            '提 PR；维护者 review 合并后，其他人 git pull（或把 sharedCasesDir 指向自己 clone 的仓库）即可拿到。',
        ];

        const COMMANDS = ['node tools/index-cases.mjs', 'node tools/lint-cases.mjs'].join('\n');

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

        function ContributeSection() {
            return h('div', { style: { padding: '4px 2px 20px', maxWidth: 760 } }, [
                h('h2', { key: 'h', style: { fontSize: 17, fontWeight: 600, margin: '0 0 6px' } }, '贡献病例'),
                h('p', { key: 'lead', style: { ...muted, margin: '0 0 14px' } },
                    '共享案例库靠「审阅」增长：插件不联网、不上报，也不会自动把你的病例发出去。'
                    + '本地库随便写，想共享的才提 PR。'),

                h('div', { key: 'k1', style: card }, [
                    h('div', { key: 't', style: titleStyle }, '四步'),
                    h('ol', { key: 'l', style: { margin: 0, paddingLeft: 20, fontSize: 13.5, lineHeight: '22px' } },
                        STEPS.map((text, i) => h('li', { key: i, style: { marginBottom: 6 } }, text))),
                ]),

                h('div', { key: 'k2', style: card }, [
                    h('div', { key: 't', style: titleStyle }, '提 PR 前跑这两条'),
                    h('pre', { key: 'p', style: pre }, COMMANDS),
                    h('div', { key: 'n', style: { ...muted, marginTop: 8 } },
                        'CI（.github/workflows/case-check.yml）会再跑一遍：文件名、必备章节、指纹泄漏、索引一致性。'),
                ]),

                h('div', { key: 'k3', style: card }, [
                    h('div', { key: 't', style: titleStyle }, '两个库在哪'),
                    h('div', { key: 'b', style: { fontSize: 13.5, lineHeight: '22px' } },
                        '共享库：插件包内 docs/cases（随包分发，只读）'),
                    h('div', { key: 'l', style: { fontSize: 13.5, lineHeight: '22px' } },
                        '本地库：$DSH_HOME/dsh-doctor/cases（本机沉淀，doctor_case_add 写入）'),
                    h('div', { key: 'n', style: { ...muted, marginTop: 8 } },
                        '想在对话里看两库清单，让 Agent 调用 doctor_cases 即可。'),
                ]),
            ]);
        }

        return {
            inject: ['slots'],
            apply(ctx) {
                ctx.slots.inject('settings.section', () =>
                    ctx.slots.register(
                        {
                            name: 'settings.section',
                            id: 'dsh-doctor-contribute',
                            order: 940,
                            label: () => '贡献病例',
                        },
                        ContributeSection,
                    ),
                );
            },
        };
    },
});
