---
description: "Bridges TencentDB Agent Memory into DSH as long-term memory: pre-turn recall injection, post-turn L0 capture, two on-demand search tools, and lifecycle for a local gateway sidecar, for users and maintainers of this plugin."
kind: "package-reference"
---

# @deepseek-ai/dsh-memory-tdai

English | [中文](README.zh.md)

## Summary

DSH keeps no long-term memory: history is persisted per session, instructions need upkeep, and nothing crosses conversations. This package mounts [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) (MIT) as a native plugin over its L0→L3 layering. `agent/pre-step` recalls L1 atoms and the L3 persona into one source-attributed user message; `agent/turn-stopping` writes the finished turn back as L0; two tools search those layers on demand. The gateway runs as a supervised child, and an unreachable gateway means no memory this turn rather than a failed turn.

## Table of contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further exploration](#further-exploration)
- [Model experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Prerequisites

The gateway needs an OpenAI-compatible LLM for L1 extraction, L2 scene aggregation, and L3 persona synthesis. Without one only raw L0 text is written and retrieval falls back to keyword matching.

```sh
# 1. Install the gateway (the official npm package ships the gateway and a local sqlite + sqlite-vec backend)
npm install --global @tencentdb-agent-memory/memory-tencentdb

# 2. The gateway's own model credentials, used for L1/L2/L3 extraction
export TDAI_LLM_API_KEY=sk-...
export TDAI_LLM_BASE_URL=https://api.deepseek.com/v1
export TDAI_LLM_MODEL=deepseek-chat
```

### Mount the plugin

Add one row to the profile patch (`$DSH_HOME/profiles/<name>/cordis.patch.yml`), or declare it in a preset:

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

With `sidecar.autoStart` false (the default) the plugin only probes the configured URL, and you start the gateway yourself or under systemd / docker.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Whole-chain switch; the row itself is the opt-in |
| `baseUrl` | `http://127.0.0.1:8420` | Gateway origin; a trailing slash is stripped |
| `apiKeyEnv` | — | Process-environment variable holding the bearer token; setting it enforces gateway auth |
| `serviceId` | `default` | `x-tdai-service-id` header — the gateway's only tenant dimension |
| `recall.enabled` | `true` | Recall and inject at the turn's first step |
| `recall.timeoutMs` | `1500` | Recall budget; a timeout skips injection for the turn |
| `recall.maxChars` | `2000` | Cap on injected text; `0` disables truncation |
| `recall.limit` | `5` | L1 rows per recall (1–20) |
| `capture.enabled` | `true` | Write the finished turn back to L0 |
| `capture.minIntervalMs` | `0` | Minimum gap between two writes from one session |
| `tools.enabled` | `true` | Register `memory_search` / `conversation_search` |
| `sidecar.autoStart` | `false` | Whether the plugin spawns the gateway |
| `sidecar.command` | — | Shell command, required when `autoStart` is true |
| `sidecar.logDir` | `~/.dsh/logs/memory-tdai` | Where the child's stdout/stderr are written |
| `sidecar.startupTimeoutMs` | `20000` | How long to wait for `/health` after spawning |
| `sidecar.env` | `{}` | Extra child environment, typically the gateway's LLM credentials |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

### Three seams

| Seam | What it does | Degradation |
|---|---|---|
| `agent/pre-step` (`step === 1`) | Takes the last real user text of the request, reads the L3 persona via `POST /v2/core/read` and L1 rows via `POST /v2/atomic/search`, then appends one user message whose `source.kind === 'memory-tdai'` | Unreachable, timed out, or empty results return the original decision unchanged |
| `agent/turn-stopping` | Collects the turn's user and assistant text from the session surface, then `POST /v2/conversation/add` | A failure is logged; the turn still closes |
| `ctx.tools.register` | `memory_search` → `/v2/atomic/search`; `conversation_search` → `/v2/conversation/search` | Errors surface as tool results and never disturb the loop |

Injection rides a user message rather than the system prompt so recalled content enters session history: replayable, compactable, and folded by compaction instead of inflating every step's request.

### Source map

| File | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Cordis entry: seam registration, message extraction, degradation |
| [`src/config.ts`](src/config.ts) | Configuration surface and default normalization |
| [`src/client.ts`](src/client.ts) | Gateway HTTP contract: health, L0 append, L1/L0 search, L3 read |
| [`src/sidecar.ts`](src/sidecar.ts) | Gateway child lifecycle: probe, spawn, logs, exit |

-----

<a id="further-exploration"></a>
## Further exploration

- Upstream project: [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)
- DSH memory status and the MCP alternative: [Connect a third-party memory MCP server](../../../docs/user/guide/mcp-memory.md)
- Compaction and the recall budget: [Compaction](../../../docs/subsystems/compaction.md)

-----

<a id="model-experience"></a>
## Model Experience

### Pre-answer recall

#### What the model sees

The first step of a turn carries one extra user message, bounded by `recall.maxChars`; a missing persona or an empty result still injects whatever remains, and nothing is injected when both are empty.

##### First step

```markdown
Background memory for this conversation:

User persona:
<persona-markdown-or-omitted>

Recalled memories:
- <l1-memory-content> (<type>)
```

#### Token effect

One message per turn, never per step; its wording is fixed except for the recalled rows, so a gateway returning the same memories reproduces the same text.

#### KV Cache effect

Append-only and turn-scoped: the injection lands after the existing request prefix, and compaction may later replace it like any other user message.

### On-demand search

#### What the model sees

`memory_search` and `conversation_search` answer as numbered rows, one per hit, or with the literal `No matching memory.` / `No matching conversation.` when nothing matched.

##### Search result

```markdown
1. <memory-content> (<type>)
```

#### Token effect

Tool results only, sized by the `limit` argument (1–20, default 5).

#### KV Cache effect

Ordinary tool results; no prefix invalidation beyond what any tool call causes.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **The gateway is an external dependency.** The plugin does not ship the memory engine and does not initialize its database, choose an embedding provider, or migrate data.
- **Extraction needs an LLM.** Without a usable model only raw L0 text exists, and `memory_search` quality drops sharply.
- **Isolation is per gateway instance.** `serviceId` selects the gateway's tenant slot; two DSH profiles sharing one gateway and one id share memory.
- **Recall happens once per turn.** A new topic appearing mid-turn does not trigger a second injection.
- **Not implemented:** proactive L2 scene injection, memory conflict resolution, forgetting and retention policy, and cross-process coordination of capture debouncing.

<a id="dev-note"></a>

<details>
<summary>Maintainer working context — click to expand</summary>

The gateway contract is the published gateway's v2 REST surface (`/v2/conversation/add`, `/v2/atomic/search`, `/v2/core/read`), which requires both a bearer header and a non-empty `x-tdai-service-id`; the v1 `/capture`, `/recall`, and `/search/*` routes are deprecated upstream and are not wired. If upstream changes the envelope or routes, edit `src/client.ts` first — the other three files need no change.

</details>
