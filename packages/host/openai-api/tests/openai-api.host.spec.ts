/** HTTP-surface coverage for the OpenAI gateway over a real WebServer. */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import * as OpenAiApi from '../src/index.ts'

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
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
    create: async () => ({ sessionId }),
    selectModel: async () => ({}),
    prompt: async () => ({ accepted: true }),
    follow: () => followFrames(),
    modelCatalog: async () => catalog(),
  } as never)
  await context.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await context.plugin(OpenAiApi, { path: '/v1', maxBodyBytes: 1024 * 1024 })
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
})
