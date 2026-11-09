---
description: "memory 组概览：把外部长期记忆引擎接成 DSH 原生插件的包，为浏览本组的用户与维护者阅读。"
kind: "package-group"
---

# memory/ — 长期记忆插件

[English](README.md) | 中文

## 概述

memory 组承载「让会话之外的知识进入请求」的插件。DSH 核心不含长期记忆：会话历史按会话落盘，工作区指令需要人工维护，跨会话不会自动沉淀。本组的包不重新实现记忆引擎，只把外部引擎的分层与检索接进 DSH 的三个既有接缝——`agent/pre-step` 的召回注入、回合结束的写回、以及模型可见的检索工具。

与 [context](../context/README.zh.md) 组的区别是边界而非位置：context 组只提供上下文、不定义工具；本组的插件既有注入也有工具，并且依赖一个外部引擎或 sidecar，因此不默认挂载。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx key |
|---|---|---|
| [`memory-tdai/`](memory-tdai/README.zh.md) | 接入腾讯 TencentDB Agent Memory 的 L0→L3 分层：回合前召回注入、回合后 L0 捕获、`memory_search` / `conversation_search` 两个工具，以及本地网关 sidecar 的生命周期 | — |

-----

<a id="related-documentation"></a>
## 相关文档

- [连接第三方记忆 MCP 服务](../../docs/user/guide/mcp-memory.zh.md)——不写代码、只接 MCP 服务器的替代路径。
- [压缩](../../docs/subsystems/compaction.zh.md)——召回内容进入会话历史后如何被摘要折叠。
- [系统提示词](../../docs/subsystems/system-prompt.zh.md)——注入为什么走 user 消息而不是提示词段。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本组的插件都要回答同一个问题：注入的文本在压缩后还能被找回吗。选择「一条带来源的 user 消息」而不是系统提示词段，是因为只有前者进入会话历史、可回放、可被 compaction 摘要，且不会每步重复膨胀请求。

</details>
