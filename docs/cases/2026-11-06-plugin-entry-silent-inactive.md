# 插件整条"静默不激活"的两种形态 · 2026-11-06

## 类型

authoring

## 症状

宿主启动日志里只有一行警告，界面不报错、不弹窗，只是**某块功能悄悄不见了**：

```
dsh-plugin-desktop: warning: 1 entry did not activate
```

或者更隐蔽的形态：工具/设置页还在，但打开后永远显示"降级"内容——没有异常、没有崩溃，只是数据一直是空的。

这两种看着像两件事，实际是同一个症状：**插件在 `apply()` 阶段抛错，被宿主记成"这一条没激活"，然后继续跑。**
区别只在抛的是什么。

## 判定签名

按报错原文对号入座（两条都是真机原话）：

**形态 A —— 输出 schema 被宿主的 value schema DSL 拒绝：**

```
JsonSchemaError: unsupported JSON schema: schema.required is not supported by the value schema DSL
    at register (<repo>/lib/index.js:206)
```

**形态 B —— 访问了没声明的服务：**

```
cannot get property "webServer" without inject
```

**共同签名**：`did not activate` 的出现次数等于你新增的那条 entry 数；把这条 entry 删掉，警告随之消失。

## 根因

**A**：宿主对 `output.schema` 用的是**值 schema DSL**（给工具参数用的那套），不是完整 JSON Schema。它：

- **不支持 `required`**（写了直接抛）；
- **每个 object 节点都必须显式写 `additionalProperties: true|false`**（缺了也抛，报 `schema.additionalProperties must be explicitly true or false`）；
- 空对象 `{}` 不合法（必须给 `type` 或 `oneOf`）。

**B**：cordis 对**未在 `inject` 里声明的服务**不是返回 `undefined`，而是**直接抛错**。
如果代码里恰好用 `try { ctx.webServer } catch { return null }` 兜住，就会变成"静默降级"——
功能没了，但日志里一条错都没有，只有读取时才发现数据是空的。

## 处置与结果

- 形态 A：去掉 `required`，给每个 object 节点（含嵌套与外层）补 `additionalProperties`。
  改完**用宿主真实的 `defineTool` 逐条复验**，别只跑自己的单测——单测里的桩不校验 schema。
- 形态 B：把用到的服务加进 `inject`（如 `inject = ['tools', 'webServer']`）；
  并且**注册失败时打 warn**，不要再静默吞掉（否则下次还是查不出来）。

## 验证

- 重启宿主后，本次运行的日志里 `did not activate` 为 0；
- 形态 B 额外验证：设置页/面板里那块内容真的出现（而不是降级页）。

## 回填清单

- [x] 单测加一条"纯结构断言"：`output.schema` 里不允许出现 `required`，每个 object 节点必须有 `additionalProperties`（不依赖宿主包，CI 也能跑）
- [x] 单测断言 `inject` 必须包含用到的服务名
