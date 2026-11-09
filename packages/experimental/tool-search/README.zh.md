---
description: "用面向模型的 tool_search 加载器推迟工具 schema 的插件，供维护大型 MCP 工具面的用户与维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-search

[English](README.md) | 中文

## 摘要

每个已注册工具的 schema 都会进入 prompt 装配，所以挂载多个 MCP server 的部署在每次请求上都要为所有工具付一次费，哪怕大多数工具从未被调用。本插件把配置范围内的 schema 从单个 agent 的 step 中撤下，在系统提示里保留只含名称的目录，并暴露一个 `tool_search` 工具按需加载 schema。模型依然知道有哪些能力，但只在决定需要时才为一个 schema 付费。推迟是按 agent、按会话独立的：一个 agent 加载了工具，不会扩大另一个 agent 的请求。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
  - [开发者备注](#dev-note)

-----

<a id="use-this-package"></a>
<a id="use-this-package"></a>
## 使用本包

把插件挂载在它要隐藏的工具已经注册的位置。它需要 `ctx.tools` 与 `ctx.systemPrompt`。

```yaml
- name: '@deepseek-ai/dsh-tool-search'
  config:
    mcp: true
    defer: []
    eager: []
    limit: 5
```

默认只推迟 `mcp__<server>__<tool>` 形式的 schema，其余一概不动，因此没有 MCP server 的部署除多一个工具外看不到任何变化。

### 何时选用

当请求预算里有明显一块花在模型极少调用的工具声明上时选用它——通常是同时挂载了多个 MCP server，或用小上下文模型驱动很多能力。工具面本身很小时不要用：十几个常驻 schema 比多一次往返更便宜。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `defer` | `[]` | 工具名或 `prefix*` 模式，其 schema 保持隐藏直到被加载 |
| `eager` | `[]` | 始终保留 schema 的模式；`eager` 优先于 `defer` 与 `mcp` |
| `mcp` | `true` | 隐藏所有 `mcp__<server>__<tool>` schema |
| `limit` | `5` | 模型未指定 `limit` 时一次 `tool_search` 加载的结果数 |
| `maxResults` | `10` | 单次调用最多加载的结果数 |
| `catalog` | `true` | 在系统提示中保留只含名称的目录段落 |
| `catalogMax` | `60` | 超过该数量的目录条目被折叠为一行摘要 |
| `sectionOrder` | `640` | 目录段落的排序值；段落按升序拼接 |

无论模式如何配置，`tool_search` 自身永不推迟。

### 可观察的成功与失败

成功的加载体现为两处：回复列出被加载的名称，下一次请求携带它们的 schema。未被推迟的名称——本来就可见、不存在、或此前已加载——会被回报为"未加载"，不改变任何状态。查询无匹配时，回复返回剩余的推迟名称，让模型按名点选。

-----

<a id="understand-the-implementation"></a>
<a id="understand-the-implementation"></a>
## 了解实现

### 设计理念

推迟是一种作用域限制，而不是一次 schema 过滤。`ctx.tools.restrict()` 对单个 agent 屏蔽继承来的全局工具，于是注册表、执行器与 prompt 装配对该 agent 可调用的能力判断一致——模型看不见的 schema，也是它调不动的工具。

### 源码导览

- [`src/index.ts`](src/index.ts) — 插件入口：推迟策略、按 agent 的状态、`tool_search` 工具与目录段落。

### 运行流程

1. `agent/created` 快照全局注册表视图，保留命中的名称，并对该 agent 的作用域施加 `deny` 限制。
2. `tool_search` 按名称与描述的重叠度排序候选，记录已加载名称，并重新施加一个更小的限制。
3. `tools/change` 重新快照每个存活 agent，于是后来才连上的 MCP server 会在下一次装配时加入推迟集合。

-----

<a id="further-exploration"></a>
<a id="further-exploration"></a>
## 进一步探索

- [工具注册表](../../core/tools/README.zh.md) — 限制、step 准入与执行管线。
- [系统提示](../../core/system-prompt/README.zh.md) — 段落、上下文，以及 prompt 如何成为 surface node。
- [作用域](../../core/scope/README.zh.md) — 承载该限制的 scoped context。

-----

<a id="model-experience"></a>
<a id="model-experience"></a>
## 模型体验

### 系统提示

#### 模型看到什么

模型收到一个目录段落，列出所有尚未加载的被推迟工具。

##### 延迟工具目录

```markdown
## Deferred tools
These 3 tool schemas are installed but withheld from this request to keep it small.
Their names are listed so you know they exist; call `tool_search` with keywords or exact names to load schemas. A loaded tool becomes callable on the next step.

- mcp__github__create_issue
- mcp__github__list_pull_requests
- mcp__slack__post_message
```

#### Token 影响

每个被推迟工具一个名称，外加两句固定文案。没有任何推迟项、或全部已加载时不渲染任何内容。

#### KV Cache 影响

未发生加载时前缀稳定；一次加载会缩短清单并重写该段落一次。

### 工具 schema

#### 模型看到什么

模型看到生成的 [`tool_search` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-search)，看不到任何被推迟工具的 schema。被加载工具的 schema 在下一步加入请求。

#### Token 影响

被推迟的 schema 在加载前不产生开销；`tool_search` 只贡献一个固定的小 schema。

#### KV Cache 影响

工具块在加载落地的那一步变化。加载会集中在一批里完成，因此代价是每次加载一次断点，而不是每步一次。

### 工具结果

#### 模型看到什么

每次调用输出一个纯文本块：被加载的名称与截断描述、说明它们下一步才可调用，以及仍然被推迟的名称。

#### Token 影响

取决于数据。一次加载回复的上限由 `maxResults` 与剩余推迟名称数量共同决定。

#### KV Cache 影响

结果文本只追加在可复用前缀之后，不会让此前的缓存条目失效。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- **已加载状态不持久。** 恢复的会话重新隐藏所有被推迟的 schema，模型需要重新加载。把加载记录成 session event 是缺失的那一环。
- **作用域内注册的工具无法推迟。** `tools.restrict()` 屏蔽的是继承的全局工具；在 agent 作用域内注册的工具始终可见。因此通过按 agent 作用域挂载的 MCP server 不受影响。
- **加载需要一次往返。** 猜错的模型要多花一步才能调用目标工具。
- **检索是词法的。** 只比较名称与描述的重叠；语义接近但没有共同 token 的查询找不到结果，此时回复退回名称清单。

<a id="dev-note"></a>
### 开发者备注

<details>
<summary>维护者工作上下文——点击展开</summary>

限制必须通过以 agent 为作用域键的 context 施加，所以插件为每个 agent 铸造一个 `createScope(ctx, agent)`，并在 `agent/disposed` 时释放。无作用域的 context 调用限制会抛错，而挂在子作用域上会屏蔽错误的链路。

限制本身也会触发 `tools/change`，因此刷新循环用重入标志保护，而不是靠事件过滤。

</details>
