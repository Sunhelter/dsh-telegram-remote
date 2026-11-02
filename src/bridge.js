/**
 * Telegram bridge: long polling, whitelist, offset and session binding.
 *
 * Serves the bot commands, binds a chat to one session, forwards prompts into
 * that agent and mirrors the assistant stream, tool activity and elapsed time
 * back into the chat. Messages from users outside `allowedUserIds` are dropped,
 * and the bot stays off until both a token and at least one allowed id exist.
 */
import { randomUUID } from 'node:crypto'
import { STATE_PATH, maskToken } from './config.js'
import { createLog } from './logbuffer.js'
import { currentSelection, loadCatalog, modelItems, modelView, selectionFor, selectionLabel } from './models.js'
import { ReplyOutbox } from './outbox.js'
import { blankSessionIn, listWorkspaces, sessionView, truncate, workspaceView } from './sessions.js'
import { StateStore } from './state.js'
import { TelegramApi } from './telegram.js'

const COMMANDS = [
  { command: 'start', description: '开始使用' },
  { command: 'sessions', description: '选择工作区和会话' },
  { command: 'new', description: '在新工作区新建会话' },
  { command: 'model', description: '切换模型' },
  { command: 'status', description: '查看绑定状态' },
  { command: 'unbind', description: '解除会话绑定' },
  { command: 'help', description: '查看命令' },
]

const PERMISSION_NOTICE_MS = 60_000
const BACKOFF_START_MS = 1_000
const BACKOFF_MAX_MS = 30_000
/** Minimum gap between edits of one streaming Telegram message. */
const STREAM_EDIT_MS = 1_000
/** How often the live turn status publishes its latest detail and elapsed time. */
const STATUS_TICK_MS = 1_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))


/** Human-readable elapsed time, e.g. `1分25秒`. */
function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}秒`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes < 60) return rest ? `${minutes}分${rest}秒` : `${minutes}分`
  const hours = Math.floor(minutes / 60)
  const extra = minutes % 60
  return extra ? `${hours}小时${extra}分` : `${hours}小时`
}

/** `调用工具：bash、read…` for the tools still running. */
function toolStatusText(status) {
  const names = [...new Set(status.pending.values())]
  if (names.length === 0) return '工具返回，继续思考…'
  const shown = names.slice(0, 3).join('、')
  return `调用工具：${shown}${names.length > 3 ? ' 等' : ''}…`
}

/** One-line error text for Telegram. */
function errorText(error) {
  const text = error instanceof Error ? error.message : String(error ?? '未知错误')
  return text.length > 500 ? `${text.slice(0, 499)}…` : text
}

/** Same fields `createUserMessage` would mint; we cannot import the factory. */
function userMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/** Busy-Enter preference from the Web settings document; `queue` when unavailable. */
function busyBehavior(ctx) {
  try {
    const form = ctx.get('settings')?.describe?.().find((row) => row.ns === 'ui-conversation')
    return form?.value?.busyEnter === 'steer' ? 'steer' : 'queue'
  } catch (error) {
    createLog(ctx).warn(`telegram-remote: cannot read the busy-enter setting: ${error.message}`)
    return 'queue'
  }
}

/** Default provider/model so a resumed agent can run before a per-session model is picked. */
function defaultAgentOptions(ctx) {
  try {
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    if (!selection?.provider || !selection?.model) return undefined
    return {
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
    }
  } catch (error) {
    createLog(ctx).warn(`telegram-remote: cannot read the default model: ${error.message}`)
    return undefined
  }
}

const isUnauthorized = (error) => error?.status === 401 || error?.code === 401
const isConflict = (error) => error?.status === 409 || error?.code === 409

export class Bridge {
  constructor(ctx, config) {
    this.ctx = ctx
    this.log = createLog(ctx)
    this.config = config
    this.api = null
    this.state = new StateStore(STATE_PATH)
    this.status = { running: false, bot: null, error: null, offset: this.state.offset }
    this.noticeAt = new Map()
    /** Agents resumed by this bridge, keyed by session id; owned by this fiber. */
    this.handles = new Map()
    /** Live assistant streams mirrored to Telegram, keyed by `${chatId}:${sessionId}`. */
    this.streams = new Map()
    /** Per-chat turn status message (`思考中…` / tool / completed). */
    this.statuses = new Map()
    /** Model picker snapshot per chat; callback payloads index into `items`. */
    this.modelMenus = new Map()
    /** Turn number per session, from `turn/start`. */
    this.currentTurns = new Map()
    /** Session -> wall clock of its current turn, for the log window. */
    this.turnStarted = new Map()
    /** Session -> turn that was started by a scheduled message. */
    this.scheduleTurns = new Map()
    /** Session -> `{ turn, chats, started }` for a scheduled turn that is
     *  pushed to whitelisted chats which are not bound to its session. */
    this.pushes = new Map()
  }

  start() {
    this.stop()

    if (!this.config.token) {
      this.status = { running: false, bot: null, error: 'missing bot token', offset: this.state.offset }
      return
    }
    if (!Array.isArray(this.config.allowedUserIds) || this.config.allowedUserIds.length === 0) {
      this.status = { running: false, bot: null, error: 'missing allowed user ids', offset: this.state.offset }
      return
    }

    this.state.load()
    const api = new TelegramApi({ token: this.config.token, proxy: this.config.proxy })
    this.api = api
    this.status = { running: true, bot: null, error: null, offset: this.state.offset }

    const route = this.config.proxy ? `via ${this.config.proxy}` : 'direct'
    this.log.info(`telegram-remote: starting (token ${maskToken(this.config.token)}, ${route}, offset ${this.state.offset})`)
    void this.run(api)
  }

  stop() {
    const api = this.api
    this.api = null
    if (api) api.close()
    for (const stream of this.streams.values()) {
      if (stream.timer) clearTimeout(stream.timer)
    }
    this.streams.clear()
    for (const status of this.statuses.values()) this.clearStatusTimer(status)
    this.statuses.clear()
    this.modelMenus.clear()
    this.currentTurns.clear()
    this.turnStarted.clear()
    this.scheduleTurns.clear()
    this.pushes.clear()
    this.status = { running: false, bot: null, error: null, offset: this.state.offset }
  }

  /** Apply a new config: tear the old client down, then start again. */
  restart(config) {
    this.stop()
    this.config = config
    this.start()
  }

  async run(api) {
    await this.hello(api)
    if (this.api !== api) return

    try {
      await api.setMyCommands(COMMANDS)
    } catch (error) {
      if (this.api !== api) return
      this.log.warn(`telegram-remote: cannot register command menu: ${error.message}`)
    }

    let backoff = BACKOFF_START_MS
    while (this.api === api) {
      let updates
      try {
        updates = await api.getUpdates({
          offset: this.state.offset + 1,
          timeoutSec: this.config.pollTimeoutSec,
        })
      } catch (error) {
        if (this.api !== api) return
        if (!(await this.recover(api, error, backoff))) return
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
        continue
      }

      backoff = BACKOFF_START_MS
      if (this.status.error) this.status.error = null
      if (updates.length === 0) continue

      for (const update of updates) {
        if (this.api !== api) return
        try {
          await this.handleUpdate(api, update)
        } catch (error) {
          if (this.api !== api) return
          this.log.warn(`telegram-remote: update ${update.update_id} failed: ${error.message}`)
        }
        this.state.offset = update.update_id
        this.state.save()
        this.status.offset = this.state.offset
      }
    }
  }

  /** Return false when polling must stop (bad token, another poller). */
  async recover(api, error, backoff) {
    this.status.error = error.message

    if (isUnauthorized(error)) {
      this.status.running = false
      this.log.error(`telegram-remote: bot token rejected: ${error.message}`)
      return false
    }

    if (isConflict(error)) {
      this.status.running = false
      this.log.error('telegram-remote: another process is polling this bot (getUpdates 409); stop it first')
      return false
    }

    if (error.code === 429) {
      const wait = Math.max(1, Number(error.retryAfter) || 1)
      this.log.warn(`telegram-remote: rate limited, retrying in ${wait}s`)
      await sleep(wait * 1000)
      return this.api === api
    }

    this.log.warn(`telegram-remote: polling failed, retrying in ${Math.round(backoff / 1000)}s: ${error.message}`)
    await sleep(backoff)
    return this.api === api
  }

  async hello(api) {
    try {
      const me = await api.getMe()
      if (this.api !== api) return
      this.status.bot = me.username ? `@${me.username}` : String(me.first_name ?? me.id)
      this.status.error = null
      this.log.info(`telegram-remote: connected as ${this.status.bot} (${me.id})`)
    } catch (error) {
      if (this.api !== api) return
      this.status.error = error.message
      this.log.warn(`telegram-remote: cannot reach Bot API: ${error.message}`)
    }
  }

  async handleUpdate(api, update) {
    if (update.message) {
      await this.handleMessage(api, update.message)
      return
    }
    if (update.callback_query) {
      await this.handleCallback(api, update.callback_query)
    }
  }

  async handleCallback(api, query) {
    const chatId = query.message?.chat?.id ?? query.from?.id
    const messageId = query.message?.message_id
    const data = typeof query.data === 'string' ? query.data : ''
    if (typeof chatId !== 'number') return

    if (!this.isAllowed(query.from?.id)) {
      await this.answer(api, query.id, '无权限')
      return
    }

    if (data === 'b' || data.startsWith('p:')) {
      const page = data === 'b' ? 0 : Number.parseInt(data.slice(2), 10) || 0
      await this.answer(api, query.id)
      await this.showWorkspaces(api, chatId, messageId, page)
      return
    }

    if (data === 'n' || data.startsWith('np:')) {
      const page = data === 'n' ? 0 : Number.parseInt(data.slice(3), 10) || 0
      await this.answer(api, query.id)
      await this.showNewWorkspaces(api, chatId, messageId, page)
      return
    }

    if (data.startsWith('nw:')) {
      await this.startNewSession(api, query, chatId, data.slice(3))
      return
    }

    if (data.startsWith('w:')) {
      const rest = data.slice(2)
      const colon = rest.lastIndexOf(':')
      const workspaceId = colon === -1 ? rest : rest.slice(0, colon)
      const page = colon === -1 ? 0 : Number.parseInt(rest.slice(colon + 1), 10) || 0

      const result = await listWorkspaces(this.ctx)
      if (!result.ok) {
        await this.answer(api, query.id, '读取会话列表失败')
        return
      }
      const workspace = result.workspaces.find((item) => item.id === workspaceId)
      if (!workspace) {
        await this.answer(api, query.id, '这个工作区已经不在了')
        return
      }
      await this.answer(api, query.id)
      await this.sendView(api, chatId, messageId, sessionView(workspace, page, this.boundSessionId(chatId)))
      return
    }

    if (data.startsWith('mp:')) {
      const page = Number.parseInt(data.slice(3), 10) || 0
      await this.answer(api, query.id)
      await this.showModels(api, chatId, messageId, { page, refresh: false })
      return
    }

    if (data.startsWith('m:')) {
      await this.pickModel(api, query, chatId, data.slice(2))
      return
    }

    if (data.startsWith('sw:')) {
      // Quick switch offered after a scheduled push; only now does binding move.
      await this.bindSession(api, query, chatId, data.slice(3))
      return
    }

    if (data.startsWith('s:')) {
      await this.bindSession(api, query, chatId, data.slice(2))
      return
    }

    await this.answer(api, query.id, '这个按钮已经过期了')
  }

  /** Session id bound to this chat, or null. */
  boundSessionId(chatId) {
    return this.state.binding(chatId)?.sessionId ?? null
  }

  /** Remove this chat's binding and persist the change; returns the old one. */
  dropBinding(chatId) {
    const binding = this.state.binding(chatId)
    if (!binding) return null
    this.abortStream(chatId, binding.sessionId)
    this.abortStatus(chatId)
    this.modelMenus.delete(chatId)
    this.state.clearBinding(chatId)
    try {
      this.state.save()
    } catch (error) {
      this.log.warn(`telegram-remote: cannot save unbind: ${error.message}`)
    }
    return binding
  }

  /** Drop the binding when its session file is gone, even if it is still live. */
  async pruneBinding(chatId) {
    const binding = this.state.binding(chatId)
    if (!binding) return null

    const persistence = this.ctx.get('sessionPersistence')
    if (!persistence) return null
    try {
      const snapshots = await persistence.list()
      if (snapshots.some((snapshot) => snapshot.header.id === binding.sessionId)) return null
    } catch {
      return null
    }
    return this.dropBinding(chatId)
  }

  /** Deliver one text message to the bound session, steering it when running. */
  async sendPrompt(api, chatId, binding, text) {
    const agents = this.ctx.get('agents')
    if (!agents) {
      await this.reply(api, chatId, '当前部署没有 agents 服务，发不了消息。')
      return
    }

    let agent = agents.get(binding.sessionId)
    if (!agent) {
      try {
        const handle = await agents.resume({ resumeSessionId: binding.sessionId, agentOptions: defaultAgentOptions(this.ctx) })
        this.handles.set(binding.sessionId, handle)
        agent = handle.agent
        this.log.info(`telegram-remote: resumed ${binding.sessionId} to send a message`)
      } catch (error) {
        this.log.warn(`telegram-remote: cannot resume ${binding.sessionId}: ${error.message}`)
        await this.reply(api, chatId, `恢复会话失败：${error.message}`)
        return
      }
    }

    const message = userMessage(text)
    const behavior = agent.status === 'running' ? busyBehavior(this.ctx) : 'queue'
    try {
      if (behavior === 'steer') agent.steer(message)
      else agent.followup(message)
    } catch (error) {
      this.log.warn(`telegram-remote: ${behavior} on ${binding.sessionId} failed: ${error.message}`)
      await this.reply(api, chatId, `发送失败：${error.message}`)
      return
    }
  }

  /** Distribute one live assistant frame to every chat bound to its session. */
  onAssistantStream(payload) {
    if (!this.api) return
    const sessionId = payload?.agent?.session?.id
    const frame = payload?.frame
    if (!sessionId || !frame) return
    for (const chatId of this.chatsBoundTo(sessionId)) {
      this.applyStreamFrame(chatId, sessionId, frame)
    }
  }

  /** Report a terminal turn failure on the chats bound to that session. */
  onAgentError(payload) {
    if (!this.api) return
    const sessionId = payload?.agent?.session?.id
    if (!sessionId) return
    const text = `运行出错：${errorText(payload.error)}`
    for (const chatId of this.chatsBoundTo(sessionId)) {
      void this.reply(this.api, chatId, text)
    }
  }

  /** Map session lifecycle and tool events to the per-chat status message. */
  onSessionEvent(session, event) {
    if (!this.api) return
    const sessionId = session?.id
    const type = event?.type
    const data = event?.data
    if (!sessionId || !type) return

    if (type === 'turn/start') {
      // A push whose turn never closed must not leak into the next turn.
      this.pushes.delete(sessionId)
      this.currentTurns.set(sessionId, data?.turn)
      if (this.chatsBoundTo(sessionId).length > 0) this.turnStarted.set(sessionId, Date.now())
    } else if (type === 'user/message' && data?.source?.kind === 'schedule') {
      this.noteScheduledTurn(sessionId)
    }

    const scheduledTurn = this.scheduleTurns.get(sessionId)
    for (const chatId of this.chatsBoundTo(sessionId)) {
      if (type === 'step/start') {
        // A scheduled turn only pushes its reply; no 深度求索中 status.
        if (scheduledTurn !== undefined && scheduledTurn === data?.turn) continue
        this.openStatus(chatId, sessionId, data?.turn)
        continue
      }

      const status = this.statuses.get(chatId)
      if (!status || status.sessionId !== sessionId) continue

      if (type === 'tool/call') {
        status.phase = 'tool'
        status.pending.set(data.callId, data.name)
        this.setDetail(status, toolStatusText(status))
      } else if (type === 'tool/result') {
        status.phase = 'thinking'
        status.pending.delete(data.message?.toolCallId)
        this.setDetail(status, toolStatusText(status))
      } else if (type === 'turn/end') {
        if (data?.turn !== undefined && status.turn !== undefined && data.turn !== status.turn) continue
        this.closeStatus(chatId, status, data?.reason?.kind)
      }
    }

    if (type === 'turn/end') {
      const started = this.turnStarted.get(sessionId)
      if (started !== undefined) {
        this.turnStarted.delete(sessionId)
        this.log.info(
          `回合结束：${this.sessionLabel(sessionId)}，${data?.reason?.kind ?? 'unknown'}，用时 ${formatDuration(Date.now() - started)}`,
        )
      }
      this.endTurn(sessionId, data?.turn)
    }
  }

  /** A scheduled message entered the session; remember it and its push targets. */
  noteScheduledTurn(sessionId) {
    const turn = this.currentTurns.get(sessionId)
    if (turn === undefined) return
    this.scheduleTurns.set(sessionId, turn)

    // Every whitelisted user gets the reply in their private chat (a private
    // chat id equals its user id). Chats already bound here receive the same
    // text through the binding path, so they need no extra push.
    const allowed = Array.isArray(this.config.allowedUserIds) ? this.config.allowedUserIds : []
    const bound = new Set(this.boundChatsTo(sessionId))
    const chats = new Set(allowed.filter((id) => Number.isSafeInteger(id) && !bound.has(id)))
    if (chats.size > 0) this.pushes.set(sessionId, { turn, chats, started: new Set() })
  }

  /** Drop the turn bookkeeping; each push that never streamed still gets a footer. */
  endTurn(sessionId, turn) {
    if (this.currentTurns.get(sessionId) === turn) this.currentTurns.delete(sessionId)
    if (this.scheduleTurns.get(sessionId) !== turn) return
    this.scheduleTurns.delete(sessionId)

    const push = this.pushes.get(sessionId)
    if (!push || push.turn !== turn) return
    for (const chatId of [...push.chats]) {
      if (push.started.has(chatId)) continue
      push.chats.delete(chatId)
      void this.sendPushFooter(chatId, sessionId)
    }
    if (push.chats.size === 0) this.pushes.delete(sessionId)
  }

  /** Start (or reuse) the status message for one chat's current turn. */
  openStatus(chatId, sessionId, turn) {
    const current = this.statuses.get(chatId)
    if (current && current.sessionId === sessionId && current.turn === turn) return current
    // A missing turn/end must not leak its timer into the next turn.
    if (current) this.closeStatus(chatId, current, 'unknown')

    const startedAt = Date.now()

    const status = {
      sessionId,
      turn,
      startedAt,
      messageId: null,
      ids: [],
      reclaiming: false,
      sent: '',
      text: '',
      target: null,
      busy: false,
      pending: new Map(),
      phase: 'thinking',
      detail: '思考中…',
      ticker: null,
    }
    this.statuses.set(chatId, status)
    status.ticker = setInterval(() => {
      if (this.statuses.get(chatId) === status) this.publishStatus(chatId, status)
    }, STATUS_TICK_MS)
    if (typeof status.ticker.unref === 'function') status.ticker.unref()
    this.publishStatus(chatId, status)
    return status
  }

  /** Web-style live header: 深度求索中，用时 12秒：思考中… */
  renderStatus(status) {
    return `深度求索中，用时 ${formatDuration(Date.now() - status.startedAt)}：${status.detail}`
  }

  clearStatusTimer(status) {
    if (!status.ticker) return
    clearInterval(status.ticker)
    status.ticker = null
  }

  /** Record the latest detail; the status ticker publishes it once per second. */
  setDetail(status, detail) {
    status.detail = detail
  }

  /** Push the current detail and elapsed time to Telegram, coalescing edits. */
  publishStatus(chatId, status, finalText = null) {
    const text = `🫍 ${finalText ?? this.renderStatus(status)}`
    if (text === status.sent || text === status.target) return
    status.text = text
    status.target = text
    void this.flushStatus(chatId, status)
  }

  async flushStatus(chatId, status) {
    if (status.busy) return
    status.busy = true
    try {
      while (status.target !== null) {
        const text = status.target
        status.target = null
        if (text === status.sent) continue
        const api = this.api
        if (!api) return
        if (status.messageId === null) {
          const sent = await api.sendMessage(chatId, text)
          if (typeof sent?.message_id === 'number') {
            status.messageId = sent.message_id
            status.ids.push(sent.message_id)
          }
        } else {
          await api.editMessageText(chatId, status.messageId, text)
        }
        status.sent = text
        await this.reclaimStatus(chatId, status)
      }
    } catch (error) {
      if (!this.api) return
      if (/message is not modified/i.test(error.message)) {
        status.sent = status.text
      } else if (error.code === 429) {
        // Rate limited: keep the message and retry on the next tick.
      } else {
        this.log.warn(`telegram-remote: status update for ${chatId} failed: ${error.message}`)
        status.messageId = null
        status.sent = ''
      }
    } finally {
      status.busy = false
      if (status.target !== null) void this.flushStatus(chatId, status)
    }
  }

  /**
   * When an edit has to be abandoned the replacement is a fresh message; delete
   * the older ones so each turn keeps exactly one status message.
   */
  async reclaimStatus(chatId, status) {
    const api = this.api
    if (!api || status.reclaiming || status.ids.length < 2) return
    status.reclaiming = true
    try {
      while (status.ids.length > 1) {
        const id = status.ids[0]
        try {
          await this.api?.deleteMessage?.(chatId, id)
        } catch (error) {
          // 400 means it is already gone; anything else (429, network) is
          // retried on the next flush.
          if (error?.code !== 400) return
        }
        status.ids.shift()
      }
    } finally {
      status.reclaiming = false
    }
  }

  /** Close the turn with web-style elapsed time. */
  closeStatus(chatId, status, reason) {
    this.clearStatusTimer(status)
    if (this.statuses.get(chatId) === status) this.statuses.delete(chatId)
    const elapsed = formatDuration(Date.now() - status.startedAt)
    const label =
      reason === 'completed'
        ? '已完成'
        : reason === 'aborted' || reason === 'interrupted'
          ? '已中断'
          : reason === 'error'
            ? '运行出错'
            : '已结束'
    this.publishStatus(chatId, status, `${label}，用时 ${elapsed}`)
  }

  abortStatus(chatId) {
    const status = this.statuses.get(chatId)
    if (!status) return
    // Finalize instead of dropping the message, otherwise it stays on screen
    // showing 深度求索中 forever.
    this.closeStatus(chatId, status, 'unknown')
  }

  /** Chats whose binding points at this session. */
  boundChatsTo(sessionId) {
    const chats = []
    for (const [key, binding] of Object.entries(this.state.data.bindings)) {
      if (binding?.sessionId === sessionId) chats.push(Number(key))
    }
    return chats
  }

  /** Session title for log lines; falls back to the short id. */
  sessionLabel(sessionId) {
    for (const chatId of this.chatsBoundTo(sessionId)) {
      const title = this.state.binding(chatId)?.title
      if (title) return title
    }
    return sessionId.slice(-8)
  }

  /** Every chat that should receive this session's live output right now. */
  chatsBoundTo(sessionId) {
    const chats = new Set(this.boundChatsTo(sessionId))
    const push = this.pushes.get(sessionId)
    if (push) for (const chatId of push.chats) chats.add(chatId)
    return [...chats]
  }

  /** Stream key: one chat can mirror two sessions (bound one + scheduled push). */
  streamKey(chatId, sessionId) {
    return `${chatId}:${sessionId}`
  }

  applyStreamFrame(chatId, sessionId, frame) {
    const key = this.streamKey(chatId, sessionId)
    const stream = this.streams.get(key)

    if (frame.type === 'start') {
      if (stream) {
        if (stream.attemptId === frame.attemptId) return
        this.abortStream(chatId, sessionId)
      }
      const push = this.pushes.get(sessionId)
      const pushed = Boolean(push && push.chats.has(chatId))
      if (pushed) push.started.add(chatId)
      this.streams.set(key, {
        key,
        chatId,
        sessionId,
        pushed,
        attemptId: frame.attemptId,
        outbox: new ReplyOutbox({
          limit: this.messageLimit(),
          prefix: '🐳 ',
          sendText: (text) => this.api.sendMessage(chatId, text, { disable_web_page_preview: true }),
          editText: (messageId, text) => this.api.editMessageText(chatId, messageId, text, { disable_web_page_preview: true }),
          log: (line) => this.log.warn(line),
        }),
        lastAt: 0,
        timer: null,
        busy: false,
        dirty: false,
        ending: false,
      })
      return
    }

    if (frame.type === 'chunk') {
      // Every publication gets a fresh revision, so only the attempt id is
      // stable across start/chunk/end.
      if (!stream || stream.attemptId !== frame.attemptId) {
        return
      }
      const chunk = frame.chunk
      if (chunk?.type === 'reasoning-delta') {
        const status = this.statuses.get(chatId)
        if (status && status.sessionId === sessionId && status.phase !== 'replying' && status.pending.size === 0) {
          status.phase = 'thinking'
          this.setDetail(status, '思考中…')
        }
        return
      }
      if (chunk?.type !== 'text-delta') return
      stream.outbox.push(chunk.text)
      const status = this.statuses.get(chatId)
      if (status && status.sessionId === sessionId && status.phase !== 'replying') {
        status.phase = 'replying'
        this.setDetail(status, '回复中…')
      }
      this.scheduleStream(chatId, stream)
      return
    }

    if (frame.type === 'end') {
      if (!stream || stream.attemptId !== frame.attemptId) return
      stream.ending = true
      if (stream.timer) {
        clearTimeout(stream.timer)
        stream.timer = null
      }
      void this.finalizeStream(chatId, stream, frame.outcome)
    }
  }

  scheduleStream(chatId, stream) {
    if (!this.api || stream.ending || stream.timer) return
    if (stream.busy) {
      // A slow edit is in flight; flush again as soon as it settles.
      stream.dirty = true
      return
    }
    const wait = Math.max(0, STREAM_EDIT_MS - (Date.now() - stream.lastAt))
    stream.timer = setTimeout(() => {
      stream.timer = null
      void this.flushStream(chatId, stream)
    }, wait)
    if (typeof stream.timer.unref === 'function') stream.timer.unref()
  }

  /** Render the open reply message, at most once per `STREAM_EDIT_MS`. */
  async flushStream(chatId, stream) {
    if (!this.api) return
    if (stream.busy) {
      stream.dirty = true
      return
    }

    const api = this.api
    stream.busy = true
    try {
      await stream.outbox.flush()
      stream.lastAt = Date.now()
    } catch (error) {
      if (this.api !== api) return
      this.log.warn(`telegram-remote: streaming to ${chatId} failed: ${error.message}`)
    } finally {
      stream.busy = false
      if (stream.dirty && !stream.ending) {
        stream.dirty = false
        this.scheduleStream(chatId, stream)
      }
    }
  }

  /** Telegram rejects anything past 4096 characters, config included. */
  messageLimit() {
    const configured = Number(this.config.maxMessageLength)
    return Number.isSafeInteger(configured) && configured > 0 ? Math.min(configured, 4096) : 4096
  }

  /** Finish the reply: let the outbox render whatever is left of the attempt. */
  async finalizeStream(chatId, stream, outcome) {
    if (stream.timer) {
      clearTimeout(stream.timer)
      stream.timer = null
    }
    while (stream.busy) await sleep(50)
    this.streams.delete(stream.key)

    if (!this.api) return
    const committed = outcome?.kind === 'committed' && outcome.eventType === 'assistant/message'
    const abandoned = outcome?.kind === 'abandoned'
    if (!committed && !abandoned) return

    try {
      await stream.outbox.close(abandoned ? '\n\n（已中断）' : '')
    } catch (error) {
      this.log.warn(`telegram-remote: final reply to ${chatId} failed: ${error.message}`)
    }
    if (stream.pushed) await this.finishPush(stream.sessionId, chatId)
  }

  abortStream(chatId, sessionId) {
    if (sessionId == null) return
    const stream = this.streams.get(this.streamKey(chatId, sessionId))
    if (!stream) return
    if (stream.timer) clearTimeout(stream.timer)
    this.streams.delete(stream.key)
  }

  /** A pushed scheduled reply ended for one chat; offer a switch to its session. */
  async finishPush(sessionId, chatId) {
    const push = this.pushes.get(sessionId)
    if (!push || !push.chats.has(chatId)) return
    push.chats.delete(chatId)
    await this.sendPushFooter(chatId, sessionId)
    if (push.chats.size === 0) this.pushes.delete(sessionId)
  }

  async sendPushFooter(chatId, sessionId) {
    const api = this.api
    if (!api) return
    if (this.boundSessionId(chatId) === sessionId) return

    let title = ''
    const listed = await listWorkspaces(this.ctx)
    if (listed.ok) {
      for (const item of listed.workspaces) {
        const found = item.sessions.find((candidate) => candidate.id === sessionId)
        if (found) {
          title = found.title || ''
          break
        }
      }
    }
    const text = title ? `⏰ 定时任务已结束：${truncate(title, 40)}` : '⏰ 定时任务已结束'
    await this.sendView(api, chatId, undefined, {
      text,
      buttons: [[{ text: '切到这个会话', callback_data: `sw:${sessionId}` }]],
    })
  }

  /**
   * Bind a chat to one stored session. Live agents are reused; a cold session
   * is resumed through the agent registry and the handle kept for chat.
   */
  async bindSession(api, query, chatId, sessionId) {
    await this.answer(api, query.id)

    const listed = await listWorkspaces(this.ctx)
    if (!listed.ok) {
      await this.reply(api, chatId, listed.error)
      return
    }

    let workspace = null
    let session = null
    for (const item of listed.workspaces) {
      const found = item.sessions.find((candidate) => candidate.id === sessionId)
      if (!found) continue
      workspace = item
      session = found
      break
    }
    if (!session) {
      const binding = this.dropBinding(chatId)
      const suffix = binding?.sessionId === sessionId ? '，已解除绑定' : ''
      await this.reply(api, chatId, `这个会话已经不在了${suffix}。发 /sessions 重新选。`)
      return
    }

    const agents = this.ctx.get('agents')
    if (!agents) {
      await this.reply(api, chatId, '当前部署没有 agents 服务，绑定不了会话。')
      return
    }

    if (!agents.get(sessionId)) {
      try {
        const handle = await agents.resume({ resumeSessionId: sessionId, agentOptions: defaultAgentOptions(this.ctx) })
        this.handles.set(sessionId, handle)
        this.log.info(`telegram-remote: resumed ${sessionId} for chat ${chatId}`)
      } catch (error) {
        if (!agents.get(sessionId)) {
          this.log.warn(`telegram-remote: cannot resume ${sessionId}: ${error.message}`)
          await this.reply(api, chatId, `恢复会话失败：${error.message}`)
          return
        }
      }
    }

    await this.applyBinding(api, chatId, query.message?.message_id, {
      sessionId,
      title: session.title || '',
      workspaceId: workspace.id,
      workspaceTitle: workspace.title,
    })
  }

  /**
   * Persist one chat binding and report the session, workspace and model it
   * points at. Binding a different session drops the old chat's stream/status.
   */
  async applyBinding(api, chatId, messageId, { sessionId, title, workspaceId, workspaceTitle, heading = '已绑定' }) {
    const previous = this.boundSessionId(chatId)
    if (previous !== sessionId) {
      this.abortStream(chatId, previous)
      this.abortStatus(chatId)
    }
    this.state.setBinding(chatId, {
      sessionId,
      title: title || '',
      workspaceId,
      workspaceTitle,
      boundAt: Date.now(),
    })
    try {
      this.state.save()
    } catch (error) {
      this.log.warn(`telegram-remote: cannot save binding: ${error.message}`)
    }

    const catalog = (await loadCatalog(this.ctx)).catalog
    const selection = (await currentSelection(this.ctx, sessionId)) ?? catalog?.default ?? null
    const model = selection ? selectionLabel(selection, catalog) : '未知'

    await this.sendView(api, chatId, messageId, {
      text: `${heading}：${title || '未命名'}\n工作区：${workspaceTitle}\n模型：${model}\n\n直接发文本开始对话，/model 切换模型，/unbind 解除绑定。`,
      buttons: [],
    })
  }

  /** `/new`: create (or reuse the workspace's blank) session there, then bind it. */
  async startNewSession(api, query, chatId, workspaceId) {
    const listed = await listWorkspaces(this.ctx)
    if (!listed.ok) {
      await this.answer(api, query.id, '读取工作区失败')
      await this.reply(api, chatId, listed.error)
      return
    }

    const workspace = listed.workspaces.find((item) => item.id === workspaceId)
    if (!workspace) {
      await this.answer(api, query.id, '这个工作区已经不在了')
      return
    }
    if (!workspace.path) {
      await this.answer(api, query.id, '这个工作区没有目录')
      await this.reply(api, chatId, '这个工作区没有目录路径，建不了会话。')
      return
    }

    const controller = this.ctx.get('sessionController')
    if (typeof controller?.create !== 'function') {
      await this.answer(api, query.id, '当前部署建不了新会话')
      await this.reply(api, chatId, '当前部署没有 sessionController.create，建不了新会话。')
      return
    }

    // Same path as the Web "+": reuse the workspace's blank session while it is
    // still blank, otherwise let the Host mint one. `create` attaches the
    // session to the workspace itself (and throws when that fails).
    const blank = await blankSessionIn(this.ctx, workspaceId)
    let created
    try {
      created = await controller.create({
        workspaceId,
        ...(blank ? { sessionId: blank } : {}),
      })
    } catch (error) {
      this.log.warn(`telegram-remote: cannot create a session in ${workspace.path}: ${error.message}`)
      await this.answer(api, query.id, '新建失败')
      await this.reply(api, chatId, `新建会话失败：${errorText(error)}`)
      return
    }

    const sessionId = created?.sessionId
    if (!sessionId) {
      await this.answer(api, query.id, '新建失败')
      await this.reply(api, chatId, '新建会话失败：宿主没有返回会话。')
      return
    }

    this.log.info(`telegram-remote: ${sessionId === blank ? 'reused blank' : 'created'} ${sessionId} in ${workspace.path} for chat ${chatId}`)

    await this.answer(api, query.id, '已新建')
    await this.applyBinding(api, chatId, query.message?.message_id, {
      sessionId,
      title: '',
      workspaceId: workspace.id,
      workspaceTitle: workspace.title,
      heading: '已新建并绑定',
    })
  }

  /** Render the model picker; `refresh` rebuilds the per-chat callback snapshot. */
  async showModels(api, chatId, messageId, { page = 0, refresh = true, current: pinned = null } = {}) {
    const binding = this.state.binding(chatId)
    if (!binding) {
      await this.reply(api, chatId, '先发 /sessions 选一个会话。')
      return
    }

    let menu = this.modelMenus.get(chatId)
    if (refresh || !menu) {
      const loaded = await loadCatalog(this.ctx)
      if (!loaded.ok) {
        await this.reply(api, chatId, loaded.error)
        return
      }
      menu = {
        items: modelItems(loaded.catalog),
        catalog: loaded.catalog,
        failures: loaded.catalog.failures ?? [],
      }
      this.modelMenus.set(chatId, menu)
    }

    menu.page = page
    const current = pinned ?? (await currentSelection(this.ctx, binding.sessionId)) ?? menu.catalog?.default ?? null
    await this.sendView(api, chatId, messageId, modelView({
      items: menu.items,
      page,
      current,
      currentLabel: current ? selectionLabel(current, menu.catalog) : '',
      failures: menu.failures,
    }))
  }

  /** Apply one pick from the stored menu snapshot and close the picker. */
  async pickModel(api, query, chatId, index) {
    const menu = this.modelMenus.get(chatId)
    const item = menu?.items?.[Number.parseInt(index, 10)]
    const binding = this.state.binding(chatId)
    if (!item || !binding) {
      await this.answer(api, query.id, '这个菜单已经过期了，重发 /model')
      return
    }

    const controller = this.ctx.get('sessionController')
    if (!controller?.selectModel) {
      await this.answer(api, query.id, '当前部署切不了模型')
      return
    }

    const picked = selectionFor(item)
    let selected = picked
    try {
      const value = await controller.selectModel({ sessionId: binding.sessionId, ...picked })
      if (value?.selected) selected = value.selected
    } catch (error) {
      this.log.warn(`telegram-remote: cannot switch model on ${binding.sessionId}: ${error.message}`)
      await this.answer(api, query.id, `切换失败：${error.message}`)
      return
    }

    await this.answer(api, query.id, '已切换')
    this.modelMenus.delete(chatId)
    await this.sendView(api, chatId, query.message?.message_id, {
      text: `已切换模型：${selectionLabel(selected, menu.catalog)}\n\n再发 /model 重新选择。`,
      buttons: [],
    })
  }

  /** Render the workspace picker into a message, editing when possible. */
  async showWorkspaces(api, chatId, messageId, page = 0) {
    const result = await listWorkspaces(this.ctx)
    if (!result.ok) {
      await this.reply(api, chatId, result.error)
      return
    }
    await this.sendView(api, chatId, messageId, workspaceView(result.workspaces, page))
  }

  /** Workspace picker for `/new`; tapping one creates a session in that directory. */
  async showNewWorkspaces(api, chatId, messageId, page = 0) {
    const result = await listWorkspaces(this.ctx)
    if (!result.ok) {
      await this.reply(api, chatId, result.error)
      return
    }
    await this.sendView(api, chatId, messageId, workspaceView(result.workspaces, page, {
      action: 'nw',
      pageAction: 'np',
      heading: '选择工作区（在这个目录新建会话）',
    }))
  }

  async sendView(api, chatId, messageId, view) {
    const extra = { reply_markup: { inline_keyboard: view.buttons } }
    if (messageId !== undefined) {
      try {
        await api.editMessageText(chatId, messageId, view.text, extra)
        return
      } catch (error) {
        if (this.api !== api) return
        if (/message is not modified/i.test(error.message)) return
      }
    }
    await this.reply(api, chatId, view.text, extra)
  }

  async answer(api, id, text = '') {
    try {
      await api.answerCallbackQuery(id, text)
    } catch (error) {
      if (this.api !== api) return
      this.log.warn(`telegram-remote: answerCallbackQuery failed: ${error.message}`)
    }
  }

  async handleMessage(api, message) {
    const chatId = message.chat?.id
    const userId = message.from?.id
    if (typeof chatId !== 'number') return

    if (typeof userId !== 'number' || !this.isAllowed(userId)) {
      this.log.warn(`忽略未授权消息：user ${userId ?? '未知'}，chat ${chatId}`)
      await this.reject(api, chatId)
      return
    }

    const text = typeof message.text === 'string' ? message.text.trim() : ''
    if (!text.startsWith('/')) {
      this.log.info(`收到文本：user ${userId}，chat ${chatId}，${text.length} 字`)
      const stale = await this.pruneBinding(chatId)
      if (stale) {
        await this.reply(api, chatId, `之前绑定的「${stale.title || '未命名'}」已经不在了，已解除绑定。发 /sessions 重新选。`)
        return
      }
      const binding = this.state.binding(chatId)
      if (binding) {
        await this.sendPrompt(api, chatId, binding, text)
      } else {
        await this.reply(api, chatId, '先发 /sessions 选一个会话。')
      }
      return
    }

    const [head] = text.split(/\s+/)
    const command = head.slice(1).split('@')[0].toLowerCase()
    this.log.info(`收到命令 /${command}：user ${userId}，chat ${chatId}`)
    if (command === 'start') {
      await this.reply(api, chatId, '已连上。发 /sessions 选工作区和会话。')
      return
    }
    if (command === 'sessions') {
      await this.showWorkspaces(api, chatId)
      return
    }
    if (command === 'new') {
      await this.showNewWorkspaces(api, chatId)
      return
    }
    if (command === 'model') {
      await this.showModels(api, chatId, undefined, { page: 0, refresh: true })
      return
    }
    if (command === 'status') {
      const binding = this.state.binding(chatId)
      if (!binding) {
        await this.reply(api, chatId, '现在没有绑定会话。发 /sessions 选一个。')
        return
      }
      const menu = await loadCatalog(this.ctx)
      const selection = await currentSelection(this.ctx, binding.sessionId)
      const model = selection ? selectionLabel(selection, menu.ok ? menu.catalog : null) : '未知'
      await this.reply(
        api,
        chatId,
        `绑定会话：${binding.title || '未命名'}\n会话 ID：${binding.sessionId}\n工作区：${binding.workspaceTitle || '未知'}\n模型：${model}`,
      )
      return
    }
    if (command === 'unbind') {
      const binding = this.dropBinding(chatId)
      if (!binding) {
        await this.reply(api, chatId, '现在没有绑定会话。')
        return
      }
      await this.reply(api, chatId, `已解除绑定：${binding.title || '未命名'}`)
      return
    }
    if (command === 'help') {
      await this.reply(api, chatId, '可用命令：\n/start 检查连接\n/sessions 选择工作区/会话\n/new 在新工作区新建会话\n/model 切换模型\n/status 查看绑定状态\n/unbind 解除绑定\n/help 查看命令\n直接发文本：发到已绑定的会话')
      return
    }
    await this.reply(api, chatId, `还不认识 /${command}，发 /help 看现有命令。`)
  }

  isAllowed(userId) {
    const allowed = this.config.allowedUserIds
    return Array.isArray(allowed) && allowed.includes(userId)
  }

  async reject(api, chatId) {
    const now = Date.now()
    const last = this.noticeAt.get(chatId) ?? 0
    if (now - last < PERMISSION_NOTICE_MS) return
    this.noticeAt.set(chatId, now)
    await this.reply(api, chatId, '无权限：这个 bot 只服务白名单里的用户。')
  }

  async reply(api, chatId, text, extra = {}) {
    try {
      await api.sendMessage(chatId, text, extra)
    } catch (error) {
      if (this.api !== api) return
      this.log.warn(`telegram-remote: sendMessage to ${chatId} failed: ${error.message}`)
    }
  }
}
