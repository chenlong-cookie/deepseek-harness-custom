---
description: "挂载到 Harness Session Controller 的 OpenAI 兼容 HTTP 与 SSE 网关，为本地服务提供模型列表和对话完成接口。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-openai-api

[English](README.md) | 中文

## 摘要

当其他本地服务需要调用与浏览器 UI 相同的 Harness Agent、模型、工具、权限和持久化 Session 时，挂载此网关。它提供 `/v1/models`、`/v1/files` 与 `/v1/chat/completions`，并支持通过 SSE 输出助手文本、供应商推理内容、工具调用/结果、状态和完成事件。

这是挂载到 Web Profile 的 OpenAI 兼容 HTTP 网关，供其他本地服务调用 DeepSeek Harness。它复用现有 `webServer` 和 `sessionController`，因此会沿用 Web UI 的 Session、模型、工具、权限、持久化与事件链路。

## 接口

- `GET /v1/models`：列出当前组合中可用的模型路由。
- `POST /v1/files`：上传一个文件并返回绑定当前 Session 的文件回执；支持 `application/octet-stream` 和带 `file` 字段的 `multipart/form-data`。
- `POST /v1/chat/completions`：接收 OpenAI 风格请求；`stream: false` 返回 JSON，`stream: true` 返回 SSE。

SSE 除标准 `message` 增量外，还会输出 `reasoning`、`tool_call`、`tool_result`、`status` 和 `done` 事件。`reasoning` 是模型供应商返回的推理内容，不是隐藏思维链；`include_reasoning: true` 开启它，`include_tool_trace: false` 可关闭工具轨迹。

## 示例

```powershell
curl http://127.0.0.1:3080/v1/chat/completions `
  -H 'content-type: application/json' `
  -d '{"model":"qwen3.5-plus","messages":[{"role":"user","content":"你好"}],"stream":true,"include_reasoning":true}'
```

请求返回的 `session_id` 可用于下一次请求的 `session_id` 字段，从而继续同一会话。`model` 可以写成 `provider/model`，也可以单独配合扩展字段 `provider`；省略时使用当前 `agent-default-model`。

新会话可以通过 `agentPreset` 选择 Agent preset。上传接口返回的 `id` 是当前 Session 专属的文件回执，后续在完成请求中通过顶层 `attachments` 引用：

```powershell
curl 'http://127.0.0.1:3080/v1/files?agent_preset=finance-ar-close&filename=ar.csv' `
  -H 'content-type: application/octet-stream' `
  --data-binary '@ar.csv'

curl http://127.0.0.1:3080/v1/chat/completions `
  -H 'content-type: application/json' `
  -d '{"session_id":"session-id-from-upload","agentPreset":"finance-ar-close","messages":[{"role":"user","content":"分析这个文件"}],"attachments":[{"file_id":"file-id-from-upload"}],"stream":true,"include_tool_trace":true}'
```

如果需要 Bearer 鉴权，可以在 profile overlay 中设置 `apiKeyEnv`，并在启动前设置对应环境变量。默认 Web Profile 仍建议保持回环地址监听；若要对外暴露，应同时设计明确的网络信任与鉴权策略。

## 模型体验

### HTTP 网关请求

#### 模型看到的内容

网关不额外添加提示词段或工具 schema，而是把调用方文本转交给现有 `sessionController`；Agent preset 继续负责提示词组合和工具呈现。

#### Token 影响

网关不转换 Token，使用与 Web UI 相同的供应商路由；推理内容和 usage 统计仍由适配器负责。

#### KV Cache 影响

Session Controller 与浏览器请求使用相同的持久化历史和供应商缓存行为；这个传输层不会额外添加或移除可缓存上下文。

## 已知限制与延后工作

- 当前网关的上传接口接收通用文件，但不会自动解析 Excel/CSV；业务 Agent 需要提供对应的文件解析工具。
- OpenAI JSON 响应暂未统一返回供应商 Token usage 字段。
- 是否监听所有网卡属于部署决策；对外暴露时必须配合明确的鉴权策略。
