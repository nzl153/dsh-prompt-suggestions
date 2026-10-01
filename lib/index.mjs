// Node 端：开一个带网页登录校验的 RPC 通道，根据当前会话最近几轮对话，预测用户下一句要发什么
export const name = 'dsh-prompt-suggestions'
// 路由挂在 webServer 上，鉴权用 connection 的 admit
export const inject = ['connection', 'webServer', 'llm', 'sessions', 'sessionQuery']

const CHANNEL = '/prompt-suggestions'
// 载体中立的 exact Fetch 路由必须挂在 /api 下（assertFetchRoute 用 endpointFromPath('/api', path) 校验）
const API_PATH = '/api/prompt-suggestions'

const DEFAULTS = {
  // 不填就自动找 DeepSeek 的 flash 模型
  provider: undefined,
  model: undefined,
  maxContextChars: 6000,
  maxOutputTokens: 80,
  timeoutMs: 10000,
}

const SYSTEM = [
  '你在帮用户预测他在 AI 助手对话里的下一条消息，结果会作为输入框里的灰色建议，用户按 Tab 就直接发出。',
  '根据之前的对话，写出用户最可能紧接着发的那一条消息：通常是追问、确认、让助手继续下一步，或针对刚才的结果提要求。',
  '用用户自己的口吻和语言写，就像他本人打的字；不要写成助手的话，不要称呼「用户」。',
  '要短：一句话，最多 30 个字。只输出这条消息本身，不要引号、不要解释。',
  '如果猜不出有把握的下一句，只输出空。',
].join('\n')

function textOf(message) {
  if (!Array.isArray(message?.content)) return typeof message?.content === 'string' ? message.content : ''
  return message.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

function dialogueOf(messages, maxChars) {
  const picked = []
  let used = 0
  for (let i = messages.length - 1; i >= 0 && used < maxChars; i--) {
    const message = messages[i]
    if (message.role !== 'user' && message.role !== 'assistant') continue
    let text = textOf(message).trim()
    if (text === '') continue
    const budget = Math.min(2000, maxChars - used)
    // 用户消息留开头，助手回复留结尾（结论和最后的提问通常在后面）
    if (text.length > budget) text = message.role === 'user' ? text.slice(0, budget) + '…' : '…' + text.slice(-budget)
    picked.unshift({ role: message.role === 'user' ? '用户' : '助手', text })
    used += text.length
  }
  return picked
}

// 重启后打开的旧会话在有新一轮之前不在内存里，从存档读
async function messagesOf(ctx, sessionId) {
  const live = ctx.sessions.get(sessionId)
  if (live !== undefined) return live.deriveMessages()
  const surface = await ctx.sessionQuery.readSurface(sessionId)
  return surface.events.flatMap((event) => {
    if (event.type === 'user/message') return [event.data]
    if (event.type === 'assistant/message') return [event.data.message]
    return []
  })
}

// 只有助手已经说完话、轮到用户的时候才给建议
async function settledMessages(ctx, sessionId) {
  if (typeof sessionId !== 'string') return undefined
  let messages
  try {
    messages = await messagesOf(ctx, sessionId)
  } catch {
    return undefined
  }
  const last = messages.at(-1)
  if (last?.role !== 'assistant') return undefined
  if (last.content?.some?.((block) => block?.type === 'tool-call')) return undefined
  if (textOf(last).trim() === '') return undefined
  return messages
}

async function resolveRoute(ctx, config) {
  if (config.provider !== undefined && config.model !== undefined) return { provider: config.provider, model: config.model }
  const providers = ctx.llm.listProviders().map((info) => info.id)
  const ordered = [...providers.filter((id) => /deepseek/i.test(id)), ...providers.filter((id) => !/deepseek/i.test(id))]
  for (const provider of ordered) {
    let models
    try {
      models = await ctx.llm.listModels(provider)
    } catch {
      continue
    }
    const flash = models.find((model) => /flash/i.test(model.id))
    if (flash !== undefined) return { provider, model: flash.id }
  }
  throw new Error('找不到可用的 flash 模型，请在 cordis.patch.yml 里给 dsh-prompt-suggestions 配 provider 和 model')
}

function clean(raw) {
  let text = raw.replace(/\r/g, '').trim().split('\n')[0].trim()
  text = text.replace(/^["“「『]+|["”」』]+$/g, '').trim()
  return text
}

async function predict(ctx, config, route, messages) {
  const dialogue = dialogueOf(messages, config.maxContextChars)
  const prompt = `之前的对话：\n${dialogue.map((turn) => `【${turn.role}】\n${turn.text}`).join('\n\n')}\n\n用户的下一条消息：`
  let text = ''
  let finish
  for await (const chunk of ctx.llm.stream({
    provider: route.provider,
    model: route.model,
    reasoningEffort: 'off',
    system: SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    maxTokens: config.maxOutputTokens,
    temperature: 0.3,
    purpose: 'prompt-suggestions',
    signal: AbortSignal.timeout(config.timeoutMs),
  })) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'finish') finish = chunk.reason
  }
  if (finish?.kind === 'error' || finish?.kind === 'aborted') throw new Error(finish.failure?.message ?? '模型调用失败')
  return clean(text)
}

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig ?? {}) }
  if ((config.provider === undefined) !== (config.model === undefined)) throw new Error('dsh-prompt-suggestions: provider 和 model 要一起配')
  let route
  // 每个会话只为最新的那条助手回复算一次，前端反复来问直接给缓存
  const cache = new Map()
  // 前端问过的会话；这些会话一轮结束就先算好，等前端来取时直接命中
  const watched = new Set()

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end' || !watched.has(session.id)) return
    setTimeout(() => {
      suggest(session.id).catch(() => {})
    }, 0)
  })

  // 不跟请求一起取消：算到一半的结果留在缓存里，下次来问正好用上
  async function suggest(sessionId) {
    if (typeof sessionId === 'string') watched.add(sessionId)
    const messages = await settledMessages(ctx, sessionId)
    if (messages === undefined) return ''
    const key = `${messages.length}:${messages.at(-1).id ?? ''}`
    const hit = cache.get(sessionId)
    if (hit?.key === key) return await hit.text
    const text = (async () => {
      route ??= await resolveRoute(ctx, config)
      return await predict(ctx, config, route, messages)
    })()
    cache.set(sessionId, { key, text })
    try {
      return await text
    } catch (error) {
      if (cache.get(sessionId)?.text === text) cache.delete(sessionId)
      throw error
    }
  }

  // 两种载体共用的应答逻辑：算建议，失败时清掉已缓存的 route 以便下次重新解析
  async function answerFor(message) {
    try {
      return { ok: true, value: { text: await suggest(message?.payload?.sessionId) } }
    } catch (error) {
      route = undefined
      return { ok: false, error: { code: 'failed', message: error instanceof Error ? error.message : String(error), details: {} } }
    }
  }

  // connection.rpc.handle 在 0.1.7-rc.2 上从第三方插件调用会报缺 webServer 注入，
  // 所以自己挂路由，鉴权照样走官方的 admit（Host/Origin 校验 + 浏览器登录 cookie）
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${CHANNEL}/suggest`,
    handler: async (req, res) => {
      const reply = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(body))
      }
      const admission = ctx.connection.admit(req)
      if ('rejection' in admission) return reply(admission.rejection, { error: 'unauthorized' })
      if (req.method !== 'POST' || !String(req.headers['content-type'] ?? '').startsWith('application/json')) return reply(415, { error: 'POST application/json only' })
      let message
      try {
        let raw = ''
        for await (const chunk of req) {
          raw += chunk
          if (raw.length > 16384) return reply(413, { error: 'too large' })
        }
        message = JSON.parse(raw)
      } catch {
        return reply(400, { error: 'bad json' })
      }
      reply(200, { type: 'server-response', rpcId: message?.rpcId, result: await answerFor(message) })
    },
  }), 'prompt-suggestions: suggest route')

  // 载体中立副本（桌面端必需）：桌面端的页面 origin 是 dsh-app://，请求不会经过 webServer
  // 上的路由，而是由 shell 载体直接分发给这个 shared Fetch handler
  // （见 dsh-client-connection README：a shell-owned carrier dispatches the shared Fetch handler directly）。
  // shell 载体的请求没有 Host 头，此时跳过 web 侧的 admit；浏览器请求有 Host，照旧校验。
  ctx.effect(() => ctx.connection.fetch.register({
    path: `${API_PATH}/suggest`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const send = (status, body) => new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })
      if (request.headers.get('host') !== null) {
        const admission = ctx.connection.admit(request)
        if ('rejection' in admission) return send(admission.rejection, { error: 'unauthorized' })
      }
      let message
      try {
        message = await request.json()
      } catch {
        return send(400, { error: 'bad json' })
      }
      return send(200, { type: 'server-response', rpcId: message?.rpcId, result: await answerFor(message) })
    },
  }), 'prompt-suggestions: carrier-neutral suggest route')
}
