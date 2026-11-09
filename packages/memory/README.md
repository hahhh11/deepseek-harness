---
description: "The memory package group: plugins that mount an external long-term memory engine as native DSH plugins, for users and maintainers browsing this group."
kind: "package-group"
---

# memory/ — long-term memory plugins

English | [中文](README.zh.md)

## Summary

The memory group carries plugins that bring knowledge from outside the current conversation into the request. The DSH core holds no long-term memory: session history is persisted per session, workspace instructions need human upkeep, and nothing accumulates across conversations. Packages here do not reimplement a memory engine; they wire an external engine into three existing seams — recall at `agent/pre-step`, write-back when a turn ends, and model-facing search tools. The boundary with the [context](../context/README.md) group is scope, not location: packages here both inject and define tools and depend on an external engine, so nothing mounts by default.

## Table of contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Responsibility | ctx key |
|---|---|---|
| [`memory-tdai/`](memory-tdai/README.md) | Bridges TencentDB Agent Memory's L0→L3 layering: pre-turn recall injection, post-turn L0 capture, the `memory_search` / `conversation_search` tools, and lifecycle for a local gateway sidecar | — |

-----

<a id="related-documentation"></a>
## Related documentation

- [Connect a third-party memory MCP server](../../docs/user/guide/mcp-memory.md) — the no-code alternative that only mounts an MCP server.
- [Compaction](../../docs/subsystems/compaction.md) — how recalled content is folded once it enters session history.
- [System prompt](../../docs/subsystems/system-prompt.md) — why injection rides a user message rather than a prompt section.

-----

<a id="dev-note"></a>
## Dev note

<details>
<summary>Maintainer working context — click to expand</summary>

Every package here has to answer one question: can the injected text still be found after compaction. The choice of "one source-attributed user message" over a system-prompt section is what makes that possible — only the former enters session history, replays, gets summarized by compaction, and avoids inflating every step's request.

</details>
