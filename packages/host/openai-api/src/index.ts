/**
 * OpenAI-compatible gateway mounted on the existing WebServer.
 *
 * The gateway deliberately delegates Session creation, model selection,
 * prompt admission, and event following to SessionController. This keeps the
 * HTTP surface on the same Agent, tools, permissions, persistence, and model
 * route as the first-party Web UI.
 */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { ModelCatalog, SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { FileUploadReceiptId } from '@deepseek-ai/dsh-client-file-upload'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { ChatCompletionRequest, ChatCompletionResponse, FileUploadResponse, ToolTraceItem } from './types.ts'

/** Cordis function-plugin name. */
export const name = 'openai-api'
/** Services used by the gateway. */
export const inject = ['webServer', 'sessionController', 'fileUploads']

/** HTTP gateway deployment policy. */
export interface Config {
  /** URL prefix. @default `/v1` */
  readonly path: string
  /** Environment variable containing an optional Bearer token. */
  readonly apiKeyEnv?: string
  /** Maximum JSON request body size in bytes. */
  readonly maxBodyBytes: number
  /** Maximum uploaded file request size in bytes. */
  readonly maxFileBytes: number
}

export const Config: z<Config> = z.object({
  path: z.string().min(1).default('/v1'),
  apiKeyEnv: z.string(),
  maxBodyBytes: z.natural().min(1024).max(8 * 1024 * 1024).default(1024 * 1024),
  maxFileBytes: z.natural().min(1024).max(256 * 1024 * 1024).default(64 * 1024 * 1024),
})

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

function sendError(res: ServerResponse, status: number, message: string, code = 'invalid_request_error'): void {
  sendJson(res, status, { error: { message, type: code, code } })
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string | null> {
  const body = await readBodyBytes(req, maxBytes)
  return body === null ? null : body.toString('utf8')
}

async function readBodyBytes(req: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.byteLength
    if (size > maxBytes) {
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size)
}

function parseRequest(text: string): ChatCompletionRequest | null {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null) return null
    const request = value as { messages?: unknown; stream?: unknown; attachments?: unknown; agentPreset?: unknown }
    if (!Array.isArray(request.messages) || request.messages.length === 0) return null
    if (request.messages.some((message) => {
      if (typeof message !== 'object' || message === null) return true
      const item = message as { role?: unknown; content?: unknown }
      return (item.role !== 'user' && item.role !== 'system') || typeof item.content !== 'string'
    })) return null
    const hasUserText = request.messages.some(message => message.role === 'user' && message.content.trim().length > 0)
    if (request.stream !== undefined && typeof request.stream !== 'boolean') return null
    if (request.attachments !== undefined && (!Array.isArray(request.attachments)
      || request.attachments.length > 32
      || request.attachments.some((attachment) => {
        if (typeof attachment !== 'object' || attachment === null) return true
        const file = attachment as { file_id?: unknown }
        return typeof file.file_id !== 'string' || file.file_id.length === 0 || file.file_id.length > 256
      }))) return null
    if (!hasUserText && (!Array.isArray(request.attachments) || request.attachments.length === 0)) return null
    if (request.agentPreset !== undefined
      && (typeof request.agentPreset !== 'string' || !/^[a-z0-9][a-z0-9-]*$/u.test(request.agentPreset))) return null
    return value as ChatCompletionRequest
  } catch {
    return null
  }
}

interface ParsedUpload {
  readonly bytes: Buffer
  readonly name?: string
}

function headerValue(headers: string, name: string): string | undefined {
  const match = headers.match(new RegExp(`(?:^|\\r\\n)${name}:\\s*([^\\r\\n]*)`, 'iu'))
  return match?.[1]?.trim()
}

function dispositionParameter(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined
  const match = value.match(new RegExp(`${name}="([^"]*)"`, 'iu'))
  return match?.[1]
}

function parseMultipart(body: Buffer, boundary: string): ParsedUpload | null {
  const delimiter = Buffer.from(`--${boundary}`)
  let offset = body.indexOf(delimiter)
  while (offset >= 0) {
    const partStart = offset + delimiter.length
    if (body.subarray(partStart, partStart + 2).equals(Buffer.from('--'))) break
    const headerStart = body.indexOf(Buffer.from('\r\n'), partStart)
    if (headerStart < 0) return null
    const contentStart = body.indexOf(Buffer.from('\r\n\r\n'), headerStart)
    if (contentStart < 0) return null
    const headers = body.subarray(headerStart + 2, contentStart).toString('utf8')
    const nextDelimiter = body.indexOf(delimiter, contentStart + 4)
    if (nextDelimiter < 0) return null
    const contentEnd = nextDelimiter - 2
    const disposition = headerValue(headers, 'content-disposition')
    if (dispositionParameter(disposition, 'name') === 'file') {
      const contentType = headerValue(headers, 'content-type')
      if (contentType !== undefined && contentType.length > 256) return null
      const name = dispositionParameter(disposition, 'filename')
      return name === undefined
        ? { bytes: body.subarray(contentStart + 4, contentEnd) }
        : { bytes: body.subarray(contentStart + 4, contentEnd), name }
    }
    offset = nextDelimiter
  }
  return null
}

function parseUpload(contentType: string | undefined, body: Buffer): ParsedUpload | null {
  const value = contentType?.toLowerCase() ?? ''
  if (value.startsWith('application/octet-stream')) return { bytes: body }
  const match = value.match(/multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^;\s]+))/u)
  if (match === null) return null
  return parseMultipart(body, match[1] ?? match[2] ?? '')
}

function normalizePath(path: string): string {
  return path === '/' ? '' : path.replace(/\/$/u, '')
}

function authorized(req: IncomingMessage, envName: string | undefined): boolean {
  if (envName === undefined || envName.length === 0) return true
  const expected = process.env[envName]
  if (expected === undefined || expected.length === 0) return false
  const actual = req.headers.authorization
  return actual === `Bearer ${expected}`
}

function modelSelection(
  request: ChatCompletionRequest,
  catalog: ModelCatalog,
): { provider: string; model: string } {
  const model = request.model
  if (model === undefined || model.length === 0) return catalog.default
  if (request.provider !== undefined) return { provider: request.provider, model }
  const separator = model.indexOf('/')
  if (separator > 0) return { provider: model.slice(0, separator), model: model.slice(separator + 1) }
  for (const group of catalog.groups) {
    if (group.models.some(entry => entry.id === model)) return { provider: group.id, model }
  }
  return { provider: catalog.default.provider, model }
}

function textFromChunk(chunk: StreamChunk): string | undefined {
  return chunk.type === 'text-delta' ? chunk.text : undefined
}

function reasoningFromChunk(chunk: StreamChunk): string | undefined {
  return chunk.type === 'reasoning-delta' ? chunk.text : undefined
}

function toolTraceFromEvent(event: Extract<SessionEvent, { type: 'tool/call' | 'tool/result' }>): ToolTraceItem {
  if (event.type === 'tool/call') {
    return { kind: 'call', call_id: String(event.data.callId), name: event.data.name, arguments: event.data.arguments }
  }
  return {
    kind: 'result',
    call_id: String(event.data.message.source.callId),
    content: event.data.message.content,
    is_error: event.data.message.content[0]?.isError === true,
  }
}

function sse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function openAiChunk(id: string, model: string, delta: Record<string, unknown>, finishReason: string | null = null): unknown {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
}

async function runCompletion(
  ctx: Context,
  request: ChatCompletionRequest,
  res: ServerResponse,
  stream: boolean,
): Promise<void> {
  const controller = ctx.sessionController
  const catalog = await controller.modelCatalog()
  const selection = modelSelection(request, catalog)
  let sessionId = request.session_id
  if ((sessionId === undefined || sessionId.length === 0) || request.agentPreset !== undefined) {
    sessionId = (await controller.create({
      ...(sessionId === undefined || sessionId.length === 0 ? {} : { sessionId: brandString<SessionId>(sessionId) }),
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }),
    })).sessionId
  }
  const session = brandString<SessionId>(sessionId)
  if (request.model !== undefined || request.provider !== undefined) {
    await controller.selectModel({ sessionId: session, ...selection })
  }
  const abort = new AbortController()
  const onClose = (): void => { abort.abort(new Error('client disconnected')) }
  res.once('close', onClose)
  const completionId = `chatcmpl-${randomUUID()}`
  const includeReasoning = request.include_reasoning === true
  const includeTools = request.include_tool_trace !== false
  const output: string[] = []
  const reasoning: string[] = []
  const toolTrace: ToolTraceItem[] = []
  let finished = false
  let agentFailure: string | undefined
  const disposeAgentError = ctx.on('agent/error', ({ agent, error }) => {
    if (agent.id !== session) return
    agentFailure = error instanceof Error ? error.message : String(error)
    abort.abort(new Error(agentFailure))
  }, { global: true })
  const iterator = controller.follow({
    address: { kind: 'session', sessionId: session },
    assistantStream: true,
  }, abort.signal)[Symbol.asyncIterator]()
  try {
    const opening = await iterator.next()
    if (opening.done || opening.value.type !== 'snapshot') throw new Error('session follow did not provide a snapshot')
    const userText = request.messages.filter(message => message.role === 'user').at(-1)?.content ?? ''
    await controller.prompt({
      sessionId: session,
      requestId: brandString<SessionRequestId>(`http-${randomUUID()}`),
      mode: 'queue',
      content: [
        ...(userText.length === 0 ? [] : [{ type: 'text' as const, text: userText }]),
        ...(request.attachments ?? []).map(attachment => ({
          type: 'file' as const,
          receiptId: brandString<FileUploadReceiptId>(attachment.file_id),
        })),
      ],
    }, abort.signal)
    if (stream) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      sse(res, 'status', { status: 'started', session_id: sessionId, model: selection.model })
    }
    while (!finished) {
      const next = await iterator.next()
      if (next.done) throw new Error(agentFailure ?? 'session follow closed before turn/end')
      const frame = next.value
      if (frame.type === 'assistant-stream') {
        const assistant = frame.frame
        if (assistant.type !== 'chunk') continue
        const chunk = assistant.chunk as StreamChunk
        const text = textFromChunk(chunk)
        if (text !== undefined) {
          output.push(text)
          if (stream) sse(res, 'message', openAiChunk(completionId, selection.model, { content: text }))
        }
        const thought = reasoningFromChunk(chunk)
        if (thought !== undefined && includeReasoning) {
          reasoning.push(thought)
          if (stream) sse(res, 'reasoning', { id: completionId, delta: thought, session_id: sessionId })
        }
        if (chunk.type === 'tool-call-delta' && includeTools) {
          if (stream) sse(res, 'tool_call', { id: completionId, delta: chunk, session_id: sessionId })
        }
        continue
      }
      if (frame.type !== 'event') continue
      const event = frame.event
      if (event.type === 'tool/call' || event.type === 'tool/result') {
        const trace = toolTraceFromEvent(event as unknown as Extract<SessionEvent, { type: 'tool/call' | 'tool/result' }>)
        if (includeTools) {
          toolTrace.push(trace)
          if (stream) sse(res, event.type === 'tool/call' ? 'tool_call' : 'tool_result', { ...trace, session_id: sessionId })
        }
      }
      if (event.type === 'turn/end') {
        const reason = (event as unknown as { data: { reason?: { kind?: string; error?: { message?: string } } } }).data.reason
        if (reason?.kind === 'error') throw new Error(reason.error?.message ?? 'agent turn failed')
        if (reason?.kind === 'aborted' || reason?.kind === 'blocked') {
          throw new Error(`agent turn ended with ${reason.kind}`)
        }
        finished = true
        if (stream) {
          sse(res, 'status', { status: 'completed', session_id: sessionId })
          sse(res, 'done', { session_id: sessionId })
          sse(res, 'message', openAiChunk(completionId, selection.model, {}, 'stop'))
          res.write('data: [DONE]\n\n')
          res.end()
        }
      }
    }
  } finally {
    abort.abort()
    await iterator.return?.()
    disposeAgentError()
    res.off('close', onClose)
  }
  if (agentFailure !== undefined) throw new Error(agentFailure)
  if (!stream) {
    const response: ChatCompletionResponse = {
      id: completionId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: selection.model,
      choices: [{ index: 0, message: { role: 'assistant', content: output.join('') }, finish_reason: 'stop' }],
      session_id: sessionId,
      ...(request.agentPreset === undefined ? {} : { agent_preset: request.agentPreset }),
      ...(includeReasoning && reasoning.length > 0 ? { reasoning: reasoning.join('') } : {}),
      ...(includeTools ? { tool_trace: toolTrace } : {}),
    }
    sendJson(res, 200, response)
  }
}

/** Mount `/v1/models` and `/v1/chat/completions` on the existing WebServer. */
export function apply(ctx: Context, config: Config): void {
  const prefix = normalizePath(config.path)
  const modelsPath = `${prefix}/models` || '/models'
  const filesPath = `${prefix}/files` || '/files'
  const completionsPath = `${prefix}/chat/completions` || '/chat/completions'
  const reject = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (authorized(req, config.apiKeyEnv)) return false
    sendError(res, 401, 'missing or invalid Bearer token', 'authentication_error')
    return true
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: modelsPath,
    handler: async (req, res) => {
      if (reject(req, res)) return
      if (req.method !== 'GET') { res.setHeader('allow', 'GET'); res.statusCode = 405; res.end(); return }
      const catalog = await ctx.sessionController.modelCatalog()
      sendJson(res, 200, {
        object: 'list',
        data: catalog.groups.flatMap(group => group.models.map(model => ({
          id: `${group.id}/${model.id}`,
          object: 'model',
          created: 0,
          owned_by: group.id,
        }))),
      })
    },
  }), `openai-api: GET ${modelsPath}`)
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: filesPath,
    handler: async (req, res) => {
      if (reject(req, res)) return
      if (req.method !== 'POST') { res.setHeader('allow', 'POST'); res.statusCode = 405; res.end(); return }
      const body = await readBodyBytes(req, config.maxFileBytes)
      if (body === null) { sendError(res, 413, 'uploaded file is too large'); return }
      const upload = parseUpload(String(req.headers['content-type']), body)
      if (upload === null || upload.bytes.length === 0) {
        sendError(res, 415, 'content-type must be application/octet-stream or multipart/form-data with a file field')
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const requestedSession = url.searchParams.get('session_id') ?? undefined
      const agentPreset = url.searchParams.get('agent_preset') ?? undefined
      const cwd = url.searchParams.get('cwd') ?? undefined
      try {
        const created = requestedSession === undefined || agentPreset !== undefined
          ? await ctx.sessionController.create({
            ...(requestedSession === undefined ? {} : { sessionId: brandString<SessionId>(requestedSession) }),
            ...(agentPreset === undefined ? {} : { agentPreset }),
            ...(cwd === undefined ? {} : { cwd }),
          })
          : { sessionId: brandString<SessionId>(requestedSession) }
        const fileName = upload.name ?? url.searchParams.get('filename') ?? undefined
        const uploaded = await ctx.fileUploads.uploadStream({
          sessionId: created.sessionId,
          data: singleChunk(upload.bytes),
          ...(fileName === undefined ? {} : { name: fileName }),
        })
        const response: FileUploadResponse = {
          id: String(uploaded.receiptId),
          object: 'file',
          filename: uploaded.file.name,
          bytes: uploaded.file.bytes,
          session_id: String(created.sessionId),
          ...(created.agentPreset === undefined ? {} : { agent_preset: created.agentPreset }),
        }
        sendJson(res, 200, response)
      } catch (error) {
        sendError(res, 500, error instanceof Error ? error.message : String(error), 'server_error')
      }
    },
  }), `openai-api: POST ${filesPath}`)
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: completionsPath,
    handler: async (req, res) => {
      if (reject(req, res)) return
      if (req.method !== 'POST') { res.setHeader('allow', 'POST'); res.statusCode = 405; res.end(); return }
      if (!String(req.headers['content-type']).toLowerCase().startsWith('application/json')) {
        sendError(res, 415, 'content-type must be application/json')
        return
      }
      const body = await readBody(req, config.maxBodyBytes)
      if (body === null) { sendError(res, 413, 'request body is too large'); return }
      const request = parseRequest(body)
      if (request === null) { sendError(res, 400, 'request must contain a non-empty messages array'); return }
      try {
        await runCompletion(ctx, request, res, request.stream === true)
      } catch (error) {
        if (!res.headersSent) sendError(res, 500, error instanceof Error ? error.message : String(error), 'server_error')
        else if (String(res.getHeader('content-type')).startsWith('text/event-stream') && !res.writableEnded) {
          sse(res, 'error', { error: { message: error instanceof Error ? error.message : String(error), type: 'server_error' } })
          res.end()
        } else res.destroy()
      }
    },
  }), `openai-api: POST ${completionsPath}`)
}

async function* singleChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes
}
