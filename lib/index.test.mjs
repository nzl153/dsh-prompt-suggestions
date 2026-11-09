import test from 'node:test'
import assert from 'node:assert/strict'
import * as host from './index.mjs'

function hostRuntime() {
  const calls = [], listeners = new Map()
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '请检查 /tmp/测试.js — café 🚀' }] },
    { id: 'answer-1', role: 'assistant', content: [{ type: 'text', text: '已检查。 Next step?' }] },
  ]
  let endpoint
  host.apply({
    effect: (fn) => fn(),
    on: (event, listener) => listeners.set(event, listener),
    connection: { fetch: { register: (route) => { endpoint = route; return () => {} } } },
    sessions: { get: () => ({ deriveMessages: () => messages }) },
    llm: {
      listProviders: () => [{ id: 'deepseek-test' }],
      listModels: async () => [{ id: 'test-flash' }],
      async *stream(options) {
        calls.push(options)
        yield { type: 'text-delta', text: '"Please fix /tmp/测试.js."\nIgnored second line.' }
      },
    },
  })
  async function request(locale) {
    const response = await endpoint.fetch(new Request('http://localhost/api/prompt-suggestions/suggest', {
      method: 'POST',
      body: JSON.stringify({ type: 'client-request', rpcId: 'test-rpc', method: 'suggest', payload: { sessionId: 'test-session', locale } }),
    }))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const body = await response.json()
    assert.equal(body.rpcId, 'test-rpc')
    assert.equal(body.result.ok, true)
    return body.result.value.text
  }
  return { calls, messages, listeners, request }
}

test('the system prompt follows the UI locale, not the conversation language', async () => {
  const runtime = hostRuntime()
  for (const locale of ['en', 'zh-CN', 'fr-CA']) {
    assert.equal(await runtime.request(locale), 'Please fix /tmp/测试.js.')
    const options = runtime.calls.at(-1)
    assert.ok(options.system.includes(`界面语言（${locale}）`))
    assert.match(options.system, /即使对话使用其他语言/)
    assert.match(options.system, /引用文本、文件路径和标识符保持原样/)
    assert.ok(options.messages[0].content[0].text.includes('/tmp/测试.js — café 🚀'))
    assert.equal(options.provider, 'deepseek-test')
    assert.equal(options.model, 'test-flash')
    assert.equal(options.reasoningEffort, 'off')
    assert.equal(options.maxTokens, 80)
    assert.equal(options.temperature, 0.3)
  }
})

test('old clients without a locale retain the conversation-language fallback', async () => {
  const runtime = hostRuntime()
  for (const locale of [undefined, '', null, 42]) await runtime.request(locale)
  assert.equal(runtime.calls.length, 1)
  assert.match(runtime.calls[0].system, /用用户自己的语言写/)
  assert.doesNotMatch(runtime.calls[0].system, /界面语言（/)
})

test('concurrent requests and cached results are isolated by UI locale', async () => {
  const runtime = hostRuntime()
  await Promise.all(['en', 'en', 'zh-CN', 'zh-CN'].map(runtime.request))
  assert.equal(runtime.calls.length, 2)
  await runtime.request('en')
  await runtime.request('zh-CN')
  assert.equal(runtime.calls.length, 2)
  runtime.messages.at(-1).id = 'answer-2'
  await runtime.request('en')
  await runtime.request('zh-CN')
  assert.equal(runtime.calls.length, 4)
})

test('turn-end prefetch retains the last requested UI locale', async (t) => {
  const timers = []
  t.mock.method(globalThis, 'setTimeout', (callback) => { timers.push(callback); return 1 })
  const runtime = hostRuntime()
  await runtime.request('en')
  await runtime.request('zh-CN')
  runtime.messages.at(-1).id = 'answer-2'
  runtime.listeners.get('session/event')({ id: 'test-session' }, { type: 'turn/end' })
  assert.equal(timers.length, 1)
  timers[0]()
  await runtime.request('zh-CN')
  assert.equal(runtime.calls.length, 3)
  assert.ok(runtime.calls.at(-1).system.includes('界面语言（zh-CN）'))
})
