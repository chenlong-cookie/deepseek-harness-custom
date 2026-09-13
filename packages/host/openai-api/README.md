---
description: "OpenAI-compatible HTTP and SSE gateway over the Harness Session Controller, exposing model listing and chat completion routes to local services."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-openai-api

English | [中文](README.zh.md)

## Summary

Mount this gateway in the Web Profile when another local service needs to call the same Harness Agent, model route, tools, permissions, and durable Session used by the browser UI. It provides `/v1/models` and `/v1/chat/completions`, including SSE events for assistant text, provider reasoning, tool calls/results, status, and completion.

The Web Profile HTTP gateway for calling DeepSeek Harness from another local service. It mounts on the existing `webServer` and delegates Session creation, model selection, prompt admission, tools, persistence, and event following to `sessionController`.

## Routes

- `GET /v1/models` lists the model routes currently visible to the Harness composition.
- `POST /v1/chat/completions` accepts an OpenAI-style JSON request. `stream: false` returns one JSON response; `stream: true` returns SSE.

The SSE stream emits standard `message` chunks plus `reasoning`, `tool_call`, `tool_result`, `status`, and `done` events. Reasoning is provider-supplied reasoning content, not hidden chain-of-thought. Tool events are opt-out with `include_tool_trace: false`; reasoning is opt-in with `include_reasoning: true`.

## Example

```powershell
curl http://127.0.0.1:3080/v1/chat/completions `
  -H 'content-type: application/json' `
  -d '{"model":"qwen3.5-plus","messages":[{"role":"user","content":"你好"}],"stream":true,"include_reasoning":true}'
```

Set `session_id` from a previous response to continue the same Harness Session. The default model comes from the active `agent-default-model`; a model can be written as `provider/model` or paired with the extension field `provider`.

For a bearer-protected deployment, configure `apiKeyEnv` in a profile overlay and set that environment variable before launching. Keep the Web Profile loopback-bound unless the deployment also supplies an intentional network trust and authentication policy.

## Model Experience

### HTTP gateway request

#### What the model sees

The gateway adds no prompt section or tool schema of its own. It forwards the caller's text through the existing `sessionController`, so the active Agent preset remains the owner of prompt composition and tool presentation.

#### Token effect

The gateway adds no token transformation. It uses the selected provider exactly as the Web UI does, so provider reasoning and usage accounting remain owned by the adapter.

#### KV Cache effect

The Session Controller preserves the same durable history and provider cache behavior as a browser prompt; this transport does not add or remove cacheable context.

## Known Limitations and Deferred Work

- The first version accepts text messages only; image and file attachment upload endpoints are not exposed here.
- The OpenAI response reports the assistant text and optional diagnostic events; provider-specific usage fields are not yet normalized into the response.
- Binding to all interfaces remains a deployment decision outside this package; expose it only with an explicit authentication policy.
