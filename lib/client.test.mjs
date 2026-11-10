import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

// Exercise the plain-JS Client factory without adding React or DOM dependencies.
function clientRuntime(language = 'en', withLocale = true) {
  const effects = [], timers = [], updates = [], requests = []
  let registration, subscription, active = language
  const locale = {
    getLocale: () => ({ active }),
    subscribe: (callback) => { subscription = callback; return () => { subscription = undefined } },
  }
  const React = {
    useSyncExternalStore(subscribe, getSnapshot) {
      this.subscribe = subscribe
      return getSnapshot()
    },
    createElement: (type, props) => ({ type, props }),
    useRef: (current) => ({ current }),
    useState: (initial) => [initial, (value) => updates.push(value)],
    useMemo: (create) => create(),
    useEffect: (effect) => effects.push(effect),
  }
  let client
  const send = async (url, options) => {
    requests.push({ url, options })
    const { rpcId } = JSON.parse(options.body)
    return { ok: true, json: async () => ({ rpcId, result: { ok: true, value: { text: 'Continue.' } } }) }
  }
  const globals = {
    window: { __ModuleLoader__: { load: ({ factory }) => { client = factory(() => React) } } },
    document: { createElement: () => ({ style: {}, dataset: {}, setAttribute() {}, append() {}, remove() {} }) },
    crypto: { randomUUID: () => 'client-rpc' },
    AbortController,
    fetch: send,
    __DSH_TRANSPORT__: { fetch: send },
    setTimeout: (callback) => { timers.push(callback); return timers.length },
    clearTimeout() {},
  }
  runInNewContext(readFileSync(new URL('./client.js', import.meta.url), 'utf8'), globals)
  const context = {
    get: (name) => { assert.equal(name, 'locale'); return context.locale },
    locale: withLocale ? locale : undefined,
    slots: {
      inject: (name, register) => { assert.equal(name, 'conversation.input.overlay'); register() },
      register: (options, component) => { registration = { options, component } },
    },
  }
  // Cordis admits apply only after every declared service dependency is present.
  function activate() {
    if (!registration && client.inject.every((name) => context[name] !== undefined)) client.apply(context)
  }
  activate()
  const props = {
    sessionId: 'test-session',
    inputActions: {},
    useInput: (select) => select({ draft: '', phase: 'plain' }),
    useConversation: () => ({}),
  }
  function render() { return registration.component(props) }
  function mount(element) {
    effects.length = 0
    element.type(element.props)
    const cleanups = effects.map((effect) => effect()).filter((cleanup) => typeof cleanup === 'function')
    return () => cleanups.forEach((cleanup) => cleanup())
  }
  return {
    React, globals, requests, timers, updates, render, mount,
    hasRegistration: () => registration !== undefined,
    provideLocale() { context.locale = locale; activate() },
    switchLocale(next) { active = next; subscription?.() },
    hasSubscription: () => subscription !== undefined,
  }
}

test('Client subscribes to the UI locale and keys suggestion state by language', () => {
  const runtime = clientRuntime()
  const english = runtime.render()
  assert.equal(english.props.locale, 'en')
  const unsubscribe = runtime.React.subscribe(() => {})
  assert.equal(runtime.hasSubscription(), true)
  runtime.switchLocale('zh-CN')
  const chinese = runtime.render()
  assert.equal(chinese.props.locale, 'zh-CN')
  assert.notEqual(english.props.key, chinese.props.key)
  assert.equal(english.type, chinese.type)
  unsubscribe()
  assert.equal(runtime.hasSubscription(), false)
})

test('Client sends the UI locale over Desktop transport and Web fetch', async () => {
  for (const desktop of [true, false]) {
    const runtime = clientRuntime('zh-CN')
    if (!desktop) delete runtime.globals.__DSH_TRANSPORT__
    const unmount = runtime.mount(runtime.render())
    await runtime.timers[0]()
    const request = runtime.requests[0]
    assert.equal(request.url, 'api/prompt-suggestions/suggest')
    assert.deepEqual(JSON.parse(request.options.body).payload, { sessionId: 'test-session', locale: 'zh-CN' })
    assert.ok(runtime.updates.includes('Continue.'))
    unmount()
    assert.equal(request.options.signal.aborted, true)
  }
})

test('Client waits for the asynchronously provided UI locale before registering suggestions', async () => {
  const runtime = clientRuntime('en', false)
  assert.equal(runtime.hasRegistration(), false, 'must not capture a missing locale during Desktop startup')
  runtime.provideLocale()
  assert.equal(runtime.hasRegistration(), true)
  const unmount = runtime.mount(runtime.render())
  await runtime.timers[0]()
  assert.equal(JSON.parse(runtime.requests[0].options.body).payload.locale, 'en')
  unmount()
})

test('unmounting the previous locale aborts its request and ignores a late response', async () => {
  const runtime = clientRuntime()
  let reply
  runtime.globals.__DSH_TRANSPORT__.fetch = (url, options) => {
    runtime.requests.push({ url, options })
    return new Promise((resolve) => { reply = resolve })
  }
  const english = runtime.render()
  const unmount = runtime.mount(english)
  const pending = runtime.timers[0]()
  runtime.switchLocale('zh-CN')
  assert.notEqual(runtime.render().props.key, english.props.key)
  unmount()
  assert.equal(runtime.requests[0].options.signal.aborted, true)
  reply({ ok: true, json: async () => ({ rpcId: 'client-rpc', result: { ok: true, value: { text: 'Old English suggestion.' } } }) })
  await pending
  assert.ok(!runtime.updates.includes('Old English suggestion.'))
})
