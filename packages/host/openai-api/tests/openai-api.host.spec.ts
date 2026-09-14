/** HTTP-surface coverage for the OpenAI gateway over a real WebServer. */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { FileUploadReceiptId } from '@deepseek-ai/dsh-client-file-upload'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import * as OpenAiApi from '../src/index.ts'

let context: Context | undefined
let createdRequests: unknown[] = []
let promptRequests: unknown[] = []

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  createdRequests = []
  promptRequests = []
})

function catalog(): ModelCatalog {
  return {
    default: { provider: 'fixture', model: 'fixture-model' },
    routableProviders: ['fixture'],
    groups: [{ id: 'fixture', name: 'Fixture', models: [{ id: 'fixture-model', name: 'Fixture Model' }] }],
    failures: [],
  }
}

function followFrames(): AsyncIterable<unknown> {
  return (async function* () {
    yield { type: 'snapshot', header: {}, cursor: -1, records: [], hasMore: false, projections: { asOfSeq: -1, values: {} } }
    yield {
      type: 'assistant-stream',
      frame: { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: '测试通过' } },
    }
    yield { type: 'event', event: { type: 'turn/end', seq: 0, time: 2, data: { turn: 1, reason: { kind: 'completed' } } } }
  })()
}

async function boot(): Promise<string> {
  context = new Context()
  const sessionId = brandString<SessionId>('session-fixture')
  context.provide('sessionController', {
    create: async (request: unknown) => {
      createdRequests.push(request)
      const agentPreset = typeof request === 'object' && request !== null && 'agentPreset' in request
        ? (request as { agentPreset?: string }).agentPreset
        : undefined
      return { sessionId, ...(agentPreset === undefined ? {} : { agentPreset }) }
    },
    selectModel: async () => ({}),
    prompt: async (request: unknown) => {
      promptRequests.push(request)
      return { accepted: true }
    },
    follow: () => followFrames(),
    modelCatalog: async () => catalog(),
  } as never)
  context.provide('fileUploads', {
    uploadStream: async (request: { name?: string }) => ({
      receiptId: brandString<FileUploadReceiptId>('receipt-fixture'),
      file: {
        attachmentId: 'attachment-fixture' as never,
        name: request.name ?? 'upload.bin',
        bytes: 4,
      },
    }),
  } as never)
  await context.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await context.plugin(OpenAiApi, { path: '/v1', maxBodyBytes: 1024 * 1024, maxFileBytes: 64 * 1024 * 1024 })
  return `http://127.0.0.1:${String(context.webServer.port)}`
}

describe('OpenAI API host routes', () => {
  it('lists models and returns a non-streaming completion', async () => {
    const base = await boot()
    const models = await fetch(`${base}/v1/models`)
    expect(models.status).toBe(200)
    expect(await models.json()).toMatchObject({ data: [{ id: 'fixture/fixture-model' }] })

    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fixture/fixture-model', messages: [{ role: 'user', content: '你好' }] }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      object: 'chat.completion',
      choices: [{ message: { content: '测试通过' }, finish_reason: 'stop' }],
      session_id: 'session-fixture',
    })
  })

  it('emits SSE status, message, and terminal frames', async () => {
    const base = await boot()
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }], stream: true }),
    })
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('event: status')
    expect(body).toContain('event: message')
    expect(body).toContain('data: [DONE]')
  })

  it('uploads a raw file, creates a session, and attaches the receipt to a completion', async () => {
    const base = await boot()
    const upload = await fetch(`${base}/v1/files?agent_preset=finance-ar-close&filename=ar.csv`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: 'a,b\n1,2\n',
    })
    expect(upload.status).toBe(200)
    await expect(upload.json()).resolves.toMatchObject({
      object: 'file',
      filename: 'ar.csv',
      session_id: 'session-fixture',
      agent_preset: 'finance-ar-close',
    })
    expect(createdRequests).toContainEqual({ agentPreset: 'finance-ar-close' })

    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: 'session-fixture',
        messages: [{ role: 'user', content: '分析这个文件' }],
        attachments: [{ file_id: 'receipt-fixture' }],
      }),
    })
    expect(response.status).toBe(200)
    expect(promptRequests.at(-1)).toMatchObject({
      content: [
        { type: 'text', text: '分析这个文件' },
        { type: 'file', receiptId: 'receipt-fixture' },
      ],
    })
  })

  it('accepts a multipart file field', async () => {
    const base = await boot()
    const form = new FormData()
    form.append('file', new Blob(['a,b\n1,2\n'], { type: 'text/csv' }), 'ar.csv')
    const response = await fetch(`${base}/v1/files`, { method: 'POST', body: form })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ object: 'file', filename: 'ar.csv' })
  })
})
