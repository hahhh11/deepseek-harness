---
description: "Route current image questions from a text-only model to a declared vision model without changing the Session's selected next model."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-image-route

English | [中文](README.zh.md)

## Summary

This package lets a text-only model selection answer a prompt that contains an image when its provider advertises a vision model. It uses the provider's first advertised image-capable model for that request only, so the configured next model remains unchanged. A deployment can configure an explicit fallback, including a different provider, when that catalog has no vision model. When no declared vision model exists, normal text-only image projection remains the fallback.

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

`dsh-base` mounts this policy. Add `fallback` only when the selected provider has no suitable advertised vision model.

### When to choose it

Use the default same-provider route when a provider catalog correctly declares its input types. Set an explicit fallback when the selected provider has no image-capable model and image input must use a specific model or provider. Do not use it to guess an undeclared model capability; update the provider catalog first.

### Minimal configuration

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
| `fallback` | absent | Optional route when the selected provider has no advertised model with image input. |
| `fallback.provider` | selected provider | Provider for an explicit fallback. |
| `fallback.model` | required with `fallback` | Model that declares image input. |
| `fallback.reasoningEffort` | absent | Explicit effort for the routed request. |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-llm-image-route) is the exhaustive source for accepted fields.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Agent loop resolves the request route before it assembles tools or the system prompt. This policy examines only the messages claimed for that step. It keeps a model that declares image input, otherwise it resolves the first image-capable model in the selected provider's catalog and then an explicit fallback. The request header records the resulting provider and model, while the durable next selection remains the user-selected route.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [LLM streaming subsystem](../../../docs/subsystems/llm-streaming.md) — messages, model capabilities, and request assembly.
- [LLM package](../llm/README.md) — provider-neutral adapter registration.
- [DeepSeek adapter](../llm-deepseek/README.md) — declared DeepSeek model capabilities.
- [pi-ai adapter](../llm-pi-ai/README.md) — configured third-party provider catalogs.

-----

<a id="model-experience"></a>
## Model Experience

### Image-input route

#### What the model sees

The routed request receives the original `image` blocks. The normal text-only projection is used only when no image-capable route is available.

#### Token effect

The routed model prices the image and text according to its own provider rules. The route policy adds no model-visible text.

#### KV Cache effect

Changing the request provider or model creates the request header change that the provider can use to determine cache eligibility.

## Known Limitations and Deferred Work

This package routes only new prompt images at an Agent step boundary.

- Direct `ctx.llm.stream()` calls do not use the policy.
- Historical images alone do not trigger a new route; text-only projection handles them when a later selected model cannot receive images.
- A provider must advertise image input accurately. An explicit fallback that does not declare image input ends the step with `IMAGE_ROUTE_UNAVAILABLE`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
