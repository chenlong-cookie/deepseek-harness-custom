
/** OpenAI-compatible request accepted by the HTTP gateway. */
export interface ChatCompletionRequest {
  readonly model?: string
  readonly agentPreset?: string
  readonly messages: readonly { readonly role: 'user' | 'system'; readonly content: string }[]
  readonly attachments?: readonly { readonly file_id: string }[]
  readonly stream?: boolean
  readonly session_id?: string
  readonly provider?: string
  readonly include_reasoning?: boolean
  readonly include_tool_trace?: boolean
  readonly cwd?: string
}

/** Minimal response shape used by the non-streaming endpoint. */
export interface ChatCompletionResponse {
  readonly id: string
  readonly object: 'chat.completion'
  readonly created: number
  readonly model: string
  readonly choices: readonly [{
    readonly index: 0
    readonly message: { readonly role: 'assistant'; readonly content: string }
    readonly finish_reason: 'stop' | 'error'
  }]
  readonly session_id: string
  readonly agent_preset?: string
  readonly reasoning?: string
  readonly tool_trace?: readonly ToolTraceItem[]
}

/** A file receipt returned by the upload route and accepted by chat completions. */
export interface FileUploadResponse {
  readonly id: string
  readonly object: 'file'
  readonly filename: string
  readonly bytes: number
  readonly session_id: string
  readonly agent_preset?: string
}

/** One tool call or completed tool result exposed by the optional trace. */
export interface ToolTraceItem {
  readonly kind: 'call' | 'result'
  readonly call_id?: string
  readonly name?: string
  readonly arguments?: string
  readonly content?: unknown
  readonly is_error?: boolean
}
