---
description: "在不改变会话下一次选定模型的前提下，将当前含图片的问题从文本模型路由到声明支持图片的视觉模型。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-image-route

[English](README.md) | 中文

## 概述

当提供方目录声明了视觉模型时，本包使文本模型选择也能回答含图片的提示。它仅为该请求使用提供方目录中第一个支持图片输入的模型，因此配置的下一次模型选择不变。该目录没有视觉模型时，部署可以配置显式 fallback，也可以指定不同提供方。没有声明视觉模型时，仍使用普通的文本模型图片投影。

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

`dsh-base` 会挂载此策略。仅当选定提供方没有合适的已声明视觉模型时，才添加 `fallback`。

### 何时选择

提供方目录正确声明输入类型时使用默认的同提供方路由。选定提供方没有支持图片的模型且图片输入必须使用特定模型或提供方时，设置显式 fallback。不要用它猜测未声明的模型能力；应先更新提供方目录。

### 最小配置

```yaml
- id: llm-image-route
  name: '@deepseek-ai/dsh-llm-image-route'
  config:
    fallback:
      provider: vision-provider
      model: vision-model
```

| Field | Default | Meaning |
|---|---|---|
| `fallback` | absent | 选定提供方没有声明支持图片输入的模型时可选用的路由。 |
| `fallback.provider` | selected provider | 显式 fallback 使用的提供方。 |
| `fallback.model` | required with `fallback` | 声明支持图片输入的模型。 |
| `fallback.reasoningEffort` | absent | 路由请求的显式推理强度。 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-llm-image-route)是全部可接受字段的权威来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

Agent loop 会在组装工具或系统提示之前解析请求路由。此策略只检查该步骤领取的消息。已声明支持图片输入的模型保持不变；否则它先解析选定提供方目录中第一个支持图片的模型，再解析显式 fallback。请求头记录实际的提供方与模型，而持久化的下一次选择仍是用户选定路由。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [LLM 流式子系统](../../../docs/subsystems/llm-streaming.zh.md)——消息、模型能力与请求组装。
- [LLM 包](../llm/README.zh.md)——提供方无关的适配器注册。
- [DeepSeek 适配器](../llm-deepseek/README.zh.md)——已声明的 DeepSeek 模型能力。
- [pi-ai 适配器](../llm-pi-ai/README.zh.md)——配置的第三方提供方目录。

-----

<a id="model-experience"></a>
## 模型体验

### 图片输入路由

#### 模型看到什么

路由后的请求会收到原始 `image` 块。只有在没有图片能力路由时才使用普通文本模型投影。

#### Token 影响

路由后的模型会按自己的提供方规则为图片和文本计费。路由策略不添加模型可见文本。

#### KV Cache 影响

请求提供方或模型变化会创建请求头变化，提供方据此判断缓存复用资格。

## 已知限制与延期工作

本包只在 Agent 步骤边界为新的提示图片路由。

- 直接调用 `ctx.llm.stream()` 不会使用此策略。
- 仅历史图片不会触发新的路由；后续选定模型不能接收图片时由文本模型投影处理。
- 提供方必须准确声明图片输入。未声明图片输入的显式 fallback 会以 `IMAGE_ROUTE_UNAVAILABLE` 结束步骤。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

None.

</details>
