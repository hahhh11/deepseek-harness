---
description: "Deferred tool schemas behind a model-facing tool_search loader for users and maintainers shrinking a large MCP tool surface."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-search

English | [中文](README.zh.md)

## Summary

Every registered tool's schema enters prompt assembly, so a deployment with many MCP servers pays for every tool on every request even when most are never called. This plugin withholds the configured schemas from a single agent's step, keeps a names-only catalog in the system prompt, and exposes a `tool_search` tool that loads the schemas the model asks for. The model still knows what exists; it pays for a schema only after it decides it needs one. Deferral is per agent and per session, so one agent loading a tool does not widen another agent's request.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
  - [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin where the tools it should hide are already registered. It needs `ctx.tools` and `ctx.systemPrompt`.

```yaml
- name: '@deepseek-ai/dsh-tool-search'
  config:
    mcp: true
    defer: []
    eager: []
    limit: 5
```

By default it defers every `mcp__<server>__<tool>` schema and nothing else, so a deployment without MCP servers sees no change beyond one extra tool.

### When to choose it

Choose it when the request spends a visible share of its budget on tool declarations the model rarely calls — typically several MCP servers mounted at once, or a small context model driving many capabilities. Skip it when the tool surface is small: a dozen eager schemas cost less than one extra round trip.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `defer` | `[]` | Tool names or `prefix*` patterns whose schemas stay hidden until loaded |
| `eager` | `[]` | Patterns that always keep a schema visible; `eager` wins over `defer` and `mcp` |
| `mcp` | `true` | Hide every `mcp__<server>__<tool>` schema |
| `limit` | `5` | Results one `tool_search` call loads when the model omits `limit` |
| `maxResults` | `10` | Most results a single call may load |
| `catalog` | `true` | Keep the names-only catalog section in the system prompt |
| `catalogMax` | `60` | Catalog entries rendered before the tail is summarized |
| `sectionOrder` | `640` | Section order of the catalog; sections concatenate in ascending order |

`tool_search` is never deferred, whatever the patterns say.

### Observable success and failures

A successful load appears twice: the reply lists the loaded names, and the next request carries their schemas. A name that is not deferred — already visible, unknown, or loaded earlier — is reported back as not loaded and changes nothing. When nothing matches a query, the reply returns the remaining deferred names so the model can pick exactly.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

### Design philosophy

Deferral is a scoped restriction, not a filter over schemas. `ctx.tools.restrict()` masks inherited global tools for one agent, so the registry, the executor, and prompt assembly all agree on what that agent may call — a schema the model cannot see is also a call it cannot make.

### Source map

- [`src/index.ts`](src/index.ts) — plugin entry: deferral policy, per-agent state, the `tool_search` tool, and the catalog section.

### Operation flow

1. `agent/created` snapshots the global registry view, keeps the matching names, and applies a `deny` restriction to that agent's scope.
2. `tool_search` ranks candidates by name and description overlap, records the loaded names, and re-applies a smaller restriction.
3. `tools/change` re-snapshots every live agent, so an MCP server that connects later joins the deferred set on the next assembly.

-----

<a id="further-exploration"></a>
## Further Exploration

- [Tool registry](../../core/tools/README.md) — restrictions, step admission, and the execution pipeline.
- [System prompt](../../core/system-prompt/README.md) — sections, contexts, and how the prompt becomes a surface node.
- [Scope](../../core/scope/README.md) — the scoped context that owns the restriction.

-----

<a id="model-experience"></a>
## Model Experience

### System prompt

#### What the model sees

The model receives one catalog section naming every deferred tool that has not been loaded yet.

##### Deferred-tools catalog

```markdown
## Deferred tools
These 3 tool schemas are installed but withheld from this request to keep it small.
Their names are listed so you know they exist; call `tool_search` with keywords or exact names to load schemas. A loaded tool becomes callable on the next step.

- mcp__github__create_issue
- mcp__github__list_pull_requests
- mcp__slack__post_message
```

#### Token effect

One name per deferred tool plus two fixed sentences. Nothing is emitted when nothing is deferred or every deferred tool has been loaded.

#### KV Cache effect

Prefix-stable while no load happens; a load shortens the list and rewrites the section once.

### Tool schemas

#### What the model sees

The model sees the generated [`tool_search` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-search) and no schema for a deferred tool. A loaded tool's schema joins the request on the following step.

#### Token effect

Deferred schemas cost nothing until they are loaded; `tool_search` contributes one fixed small schema.

#### KV Cache effect

The tool block changes on the step a load lands. Loads cluster into one batch, so that is one break per load rather than one per step.

### Tool results

#### What the model sees

Each call emits one plain-text block: the loaded names with clipped descriptions, a reminder that they are callable on the next step, and the names still deferred.

#### Token effect

Data-dependent. A load reply is bounded by `maxResults` and by the remaining deferred names.

#### KV Cache effect

Append-only result text follows the reusable prefix and does not invalidate earlier cache entries.

## Known Limitations and Deferred Work

- **Loaded tools are not durable.** A resumed session starts with every deferred schema hidden again; the model must reload what it needs. Recording loads as session events is the missing piece.
- **Scoped registrations cannot be deferred.** `tools.restrict()` masks inherited global tools; a tool registered inside an agent scope stays visible. MCP servers mounted through a per-agent scope are therefore unaffected.
- **Loading costs a round trip.** A model that guesses wrong pays a step before it can call the tool.
- **Search is lexical.** Name and description overlap only; a semantically close query with no shared tokens finds nothing, and the reply falls back to the name list.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The restriction must be applied through a context tagged with the agent as its scope key, which is why the plugin mints one `createScope(ctx, agent)` per agent and disposes it on `agent/disposed`. A restriction applied from an unscoped context throws, and one applied in a child scope would mask the wrong chain.

`tools/change` is emitted by restrictions too, so the refresh loop is guarded by a re-entrancy flag rather than by event filtering.

</details>
