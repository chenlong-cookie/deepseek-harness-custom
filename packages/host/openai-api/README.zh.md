---
description: "挂载到 Harness Session Controller 的 OpenAI 兼容 HTTP 与 SSE 网关，为本地服务提供模型列表和对话完成接口。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-openai-api

[English](README.md) | 中文

## 摘要

当其他本地服务需要调用与浏览器 UI 相同的 Harness Agent、模型、工具、权限和持久化 Session 时，挂载此网关。它提供 `/v1/models` 与 `/v1/chat/completions`，并支持通过 SSE 输出助手文本、供应商推理内容、工具调用/结果、状态和完成事件。

这是挂载到 Web Profile 的 OpenAI 兼容 HTTP 网关，供其他本地服务调用 DeepSeek Harness。它复用现有 `webServer` 和 `sessionController`，因此会沿用 Web UI 的 Session、模型、工具、权限、持久化与事件链路。

## 接口

- `GET /v1/models`：列出当前组合中可用的模型路由。
- `POST /v1/chat/completions`：接收 OpenAI 风格请求；`stream: false` 返回 JSON，`stream: true` 返回 SSE。

SSE 除标准 `message` 增量外，还会输出 `reasoning`、`tool_call`、`tool_result`、`status` 和 `done` 事件。`reasoning` 是模型供应商返回的推理内容，不是隐藏思维链；`include_reasoning: true` 开启它，`include_tool_trace: false` 可关闭工具轨迹。

请求返回的 `session_id` 可用于下一次请求的 `session_id` 字段，从而继续同一会话。`model` 可以写成 `provider/model`，也可以单独配合扩展字段 `provider`；省略时使用当前 `agent-default-model`。

## 示例

```powershell
curl http://127.0.0.1:3080/v1/chat/completions `
  -H 'content-type: application/json' `
  -d '{"model":"qwen3.5-plus","messages":[{"role":"user","content":"你好"}],"stream":true,"include_reasoning":true}'
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

- 当前版本只接受文本消息，尚未提供图片和文件上传接口。
- OpenAI JSON 响应暂未统一返回供应商 Token usage 字段。
- 是否监听所有网卡属于部署决策；对外暴露时必须配合明确的鉴权策略。
