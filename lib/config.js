/**
 * dsh-doctor / lib/config.js —— 插件 Config（**纯数据实现**，不依赖 schemastery）
 *
 * 为什么不用 schemastery：
 *   cordis 的 resolveConfig 只要 `Config["~standard"].validate`；宿主 dsh-settings 的
 *   volatileForm/plainSchema 也是先 `schema.toJSON()` 再 `new z(json)` **重建**。
 *   也就是说：宿主只要求这个对象满足「Standard Schema + schemastery 的 JSON 形状」，
 *   并不要求它由真 schemastery 构造出来。
 *
 *   而依赖 schemastery 会引入一条脆弱的解析链（npm 安装与 link: 安装的解析根不同，
 *   包内 node_modules 里的任何同名包都会顶掉宿主那份）。真机教训：
 *   一个没有 ~standard 的"像 schema 的对象"会让 cordis 抛
 *   `Cannot read properties of undefined (reading 'validate')`，整条插件不激活。
 *
 * 所以这里自己实现：type / dict / meta / toJSON() / '~standard'.validate()。
 * 不 import 任何外部包，行为在任何 DSH 版本上都一致。
 */

/** 字段：保留设置页需要的展示与校验元数据。 */
function field(type, extra = {}) {
    const node = { type, ...extra, meta: { ...(extra.meta || {}) } };
    return node;
}

const CONTRIBUTE_GUIDE = [
    '共享案例库由「审阅」增长，不由遥测：',
    '1) 用 doctor_case_add 把这次的故障写进本地库（自动脱敏；共享库插件只读，不会误写）',
    '2) 把生成的 .md 复制进 仓库 docs/cases/',
    '3) 重建索引：node tools/index-cases.mjs',
    '4) 开 PR；维护者 review 合并后，其他人 git pull（或把 sharedCasesDir 指向自己 clone 的仓库）就拿到',
    '',
    '本地库默认在 $DSH_HOME/dsh-doctor/cases；共享库默认在本包的 docs/cases。',
].join('\n');

const DICT = {
    maxProfiles: field('number', { default: 32, min: 1, max: 200, meta: { volatile: true, description: '扫描 DSH_HOME 下最多多少个 profile（默认 32）' } }),
    maxLogBytes: field('number', { default: 2 * 1024 * 1024, min: 4096, max: 33554432, meta: { volatile: true, description: '单个日志文件读取上限（字节，默认 2 MiB；超限会标注 truncated）' } }),
    httpTimeoutMs: field('number', { default: 1200, min: 100, max: 30000, meta: { volatile: true, description: '端口连通性探测超时（毫秒，默认 1200）' } }),
    cacheTtlMs: field('number', { default: 15000, min: 0, max: 600000, meta: { volatile: true, description: '引擎发现结果缓存（毫秒，0=每次重扫；默认 15000）' } }),
    casesPrefer: field('union', { default: 'local', list: ['local', 'shared'], meta: { volatile: true, description: '同名案例 id 时优先读哪个库（默认 local，本地覆盖共享）' } }),
    localCasesDir: field('string', { meta: { volatile: true, description: '本地案例库目录（默认 $DSH_HOME/dsh-doctor/cases；留空用默认）' } }),
    sharedCasesDir: field('string', { meta: { volatile: true, description: '共享案例库目录（默认本包 docs/cases；可指向你 clone 的仓库，git pull 即更新）' } }),
    allowLocalCaseWrite: field('boolean', { default: true, meta: { volatile: true, description: '允许 doctor_case_add 写本地案例库；设 false 则插件回到完全只读' } }),
    contributeGuide: field('string', { default: CONTRIBUTE_GUIDE, meta: { volatile: true, description: '贡献共享案例库的流程提醒（保留原文即可；完整说明见 docs/CONTRIBUTING.md）' } }),
};

const META = {
    description:
        '贡献病例：dsh-doctor 跨引擎只读体检。案例库分「共享库（随包分发，只读，由 PR 审阅增长）」与「本地库（本机沉淀，可写）」；' +
        '同名 id 默认本地覆盖共享。贡献流程见 contributeGuide 字段或 docs/CONTRIBUTING.md。',
};

/** Standard Schema 校验：只保证对象形态并填默认值，够设置页往返即可。 */
function validate(value) {
    const input = value && typeof value === 'object' ? value : {};
    const out = {};
    for (const [key, spec] of Object.entries(DICT)) {
        if (Object.prototype.hasOwnProperty.call(input, key)) out[key] = input[key];
        else if (Object.prototype.hasOwnProperty.call(spec, 'default')) out[key] = spec.default;
    }
    return { value: out };
}

/** 与 schemastery 的 toJSON() 形状一致（宿主会用 new z(json) 重建）。 */
function toJSON() {
    return {
        type: 'object',
        dict: Object.fromEntries(Object.entries(DICT).map(([k, v]) => [k, { ...v, meta: { ...v.meta } }])),
        meta: { ...META },
    };
}

export const Config = {
    type: 'object',
    dict: DICT,
    meta: META,
    toJSON,
    validate,
    '~standard': { version: 1, vendor: 'dsh-doctor', validate },
};

export { CONTRIBUTE_GUIDE };
