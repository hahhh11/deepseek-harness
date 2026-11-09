---
description: "把腾讯 TencentDB Agent Memory 接成 DSH 的长期记忆：回合前召回注入、回合后 L0 捕获、两个按需检索工具，以及本地网关 sidecar 的生命周期管理，供启用该插件的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-memory-tdai

[English](README.md) | 中文

## 概述

DSH 自身不含长期记忆：会话历史只按会话落盘，`AGENTS.md` 一类指令需要人工维护，跨会话的知识不会自动沉淀。本插件把 [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)（MIT）接成 DSH 的一个原生插件，用它的 L0→L3 分层把对话变成可检索的长期记忆。

插件不重新实现记忆引擎，只做三件事：在 `agent/pre-step` 召回 L1 原子与 L3 人设并注入一条带来源的 user 消息；在 `agent/turn-stopping` 把完成的一轮写回 L0；注册 `memory_search`、`conversation_search` 两个模型可见工具。网关是独立子进程，由插件按配置监督，不可用时整条链路降级为「本轮没有记忆」，不会让回合失败。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 先决条件

网关需要一个 OpenAI 兼容的 LLM 才能做 L1 抽取、L2 场景聚合与 L3 人设生成。没有 LLM 时只有 L0 原文可写入，检索退化为关键词匹配。

```sh
# 1. Install the gateway (the official npm package ships the gateway and a local sqlite + sqlite-vec backend)
npm install --global @tencentdb-agent-memory/memory-tencentdb

# 2. The gateway's own model credentials, used for L1/L2/L3 extraction
export TDAI_LLM_API_KEY=sk-...
export TDAI_LLM_BASE_URL=https://api.deepseek.com/v1
export TDAI_LLM_MODEL=deepseek-chat
```

### 挂载插件

在 profile patch（`$DSH_HOME/profiles/<name>/cordis.patch.yml`）里加一行，或用 preset 声明：

```yaml
- id: memory-tdai
  name: '@deepseek-ai/dsh-memory-tdai'
  config:
    baseUrl: http://127.0.0.1:8420
    sidecar:
      autoStart: true
      command: sh -c 'exec tencentdb-agent-memory gateway --port 8420'
      env:
        TDAI_LLM_API_KEY: ${TDAI_LLM_API_KEY}
```

`sidecar.autoStart` 为 false（默认）时，插件只探测配置的 URL，网关由你自己提前启动或交给 systemd / docker。

### 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 整条链路开关；行存在即生效 |
| `baseUrl` | `http://127.0.0.1:8420` | 网关源地址，尾部斜杠会被去掉 |
| `apiKeyEnv` | — | 从进程环境读取 Bearer token 的变量名；配上即校验网关鉴权 |
| `serviceId` | `default` | `x-tdai-service-id` 头，网关唯一的租户维度 |
| `recall.enabled` | `true` | 回合首步召回并注入 |
| `recall.timeoutMs` | `1500` | 召回预算；超时整轮跳过注入 |
| `recall.maxChars` | `2000` | 注入文本上限，`0` 表示不截断 |
| `recall.limit` | `5` | 每次召回的 L1 条数（1–20） |
| `capture.enabled` | `true` | 回合结束后写回 L0 |
| `capture.minIntervalMs` | `0` | 同一会话两次写入的最小间隔 |
| `tools.enabled` | `true` | 注册 `memory_search` / `conversation_search` |
| `sidecar.autoStart` | `false` | 是否由插件拉起网关 |
| `sidecar.command` | — | `autoStart` 为真时必填的 shell 命令 |
| `sidecar.logDir` | `~/.dsh/logs/memory-tdai` | 子进程 stdout/stderr 落盘目录 |
| `sidecar.startupTimeoutMs` | `20000` | 拉起后等待 `/health` 的上限 |
| `sidecar.env` | `{}` | 追加给子进程的环境变量，通常放网关的 LLM 凭据 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

### 三个接入点

| 接缝 | 作用 | 降级 |
|---|---|---|
| `agent/pre-step`（`step === 1`） | 取当前请求里最后一条真实用户文本 → `POST /v2/core/read` 拿 L3 人设 + `POST /v2/atomic/search` 拿 L1 → 组合后追加一条 `source.kind === 'memory-tdai'` 的 user 消息 | 端口不可达、超时、空结果一律返回原决策 |
| `agent/turn-stopping` | 从会话表面收集本轮 user/assistant 文本 → `POST /v2/conversation/add` | 失败只记日志，不影响回合收尾 |
| `ctx.tools.register` | `memory_search` → `/v2/atomic/search`；`conversation_search` → `/v2/conversation/search` | 抛错由工具结果呈现，不污染循环 |

注入走 user 消息而不是系统提示词，是为了让召回内容进入会话历史：可回放、可压缩、可被 compaction 摘要，且不会在每步重复膨胀请求。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | Cordis 插件入口：接缝注册、消息提取、降级 |
| [`src/config.ts`](src/config.ts) | 配置骨架与默认值归一 |
| [`src/client.ts`](src/client.ts) | 网关 HTTP 契约：健康、L0 写入、L1/L0 检索、L3 读取 |
| [`src/sidecar.ts`](src/sidecar.ts) | 网关子进程生命周期：探测、拉起、日志、退出 |

-----

<a id="further-exploration"></a>
## 进一步探索

- 上游项目文档：[TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)
- DSH 侧记忆现状与替代方案：[连接第三方记忆 MCP 服务](../../../docs/user/guide/mcp-memory.zh.md)
- 上下文压缩与召回预算的关系：[压缩](../../../docs/subsystems/compaction.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

### 应答前召回

#### 模型看到什么

回合首步会多出一条 user 消息，受 `recall.maxChars` 限制。两段都可缺省：缺人设或缺召回条目时，剩余部分照样注入；两者都空则完全不注入。

##### 首步

```markdown
Background memory for this conversation:

User persona:
<persona-markdown-or-omitted>

Recalled memories:
- <l1-memory-content> (<type>)
```

#### Token 影响

每回合一条，且不在每步重复。除召回条目的内容外措辞固定，因此网关跨回合返回相同记忆时文本完全一致。

#### KV Cache 影响

只追加、按回合生效：注入落在既有请求前缀之后，后续可能被压缩像普通 user 消息一样替换。

### 按需检索

#### 模型看到什么

`memory_search` 与 `conversation_search` 以带序号的条目作答，每条命中一行；没有任何命中时返回字面量 `No matching memory.` / `No matching conversation.`。

##### 检索结果

```markdown
1. <memory-content> (<type>)
```

#### Token 影响

只产生工具结果，规模由 `limit` 参数决定（1–20，默认 5）。

#### KV Cache 影响

普通工具结果；除任何工具调用本身带来的变化外不使前缀失效。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **网关是外部依赖**：插件不自带记忆引擎，也不代替网关初始化数据库、选择 embedding 提供方或迁移数据。
- **抽取依赖 LLM**：没有可用 LLM 时只有 L0 原文，`memory_search` 的语义质量明显下降。
- **隔离按网关实例划分**：`serviceId` 选择网关的租户槽；共享同一网关与同一 id 的两个 DSH profile 会看到同一份记忆。
- **召回只在首步**：一个回合内不会二次召回，长回合中途出现的新话题不会触发注入。
- **未实现**：L2 场景块主动注入、记忆冲突消解、遗忘与保留策略、写入去抖的跨进程协调。

<a id="dev-note"></a>

<details>
<summary>维护者的工作上下文——点击展开</summary>

网关契约按发布版网关的 v2 REST（`/v2/conversation/add`、`/v2/atomic/search`、`/v2/core/read`）实现，必须同时带 bearer 头与非空 `x-tdai-service-id`；v1 的 `/capture`、`/recall`、`/search/*` 在上游已标 deprecated，不再接入。若上游收紧 envelope 或改写路由，先改 `src/client.ts`，其余三个文件不需变更。

</details>
