/**
 * 本地测试桩（**不在包内 node_modules**，必须显式导入，不会被运行时解析到）
 *
 * 真机踩过的坑：把桩放在 <包>/node_modules 下，`link:` 安装时 Node 按真实路径解析，
 * 宿主那份变成"够不着"，桩反而被命中 → 插件拿着假 schema 崩溃、整条不激活。
 * 所以桩放在 test/stubs/ 下，由测试显式 import，运行期永远看不到它。
 */

/** 极简 schemastery 替身：只用于测试 plugins 工具契约。 */
export function defineToolStub(spec) {
    if (!spec || typeof spec.name !== 'string' || !spec.name) throw new Error('defineTool: name required');
    if (typeof spec.description !== 'string' || !spec.description) throw new Error('defineTool: description required');
    if (typeof spec.execute !== 'function') throw new Error('defineTool: execute required');
    return spec;
}

export default { defineTool: defineToolStub };
