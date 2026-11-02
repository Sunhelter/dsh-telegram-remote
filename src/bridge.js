/**
 * Telegram bridge: long polling, whitelist, offset and session binding.
 *
 * M2 keeps `/sessions`, workspace/session pagination and chat -> session
 * bindings on top of the transport layer; chat and model switching build on the
 * same class. Messages from users outside `allowedUserIds` are dropped.
 */
import { STATE_PATH, maskToken } from './config.js'
import { listWorkspaces, sessionView, workspaceView } from './sessions.js'
import { StateStore } from './state.js'
import { TelegramApi } from './telegram.js'

const COMMANDS = [
  { command: 'start', description: '开始使用' },
  { command: 'sessions', description: '选择工作区和会话' },
  { command: 'unbind', description: '解除会话绑定' },
  { command: 'help', description: '查看命令' },
]

const PERMISSION_NOTICE_MS = 60_000
const BACKOFF_START_MS = 1_000
const BACKOFF_MAX_MS = 30_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const isUnauthorized = (error) => error?.status === 401 || error?.code === 401
const isConflict = (error) => error?.status === 409 || error?.code === 409

export class Bridge {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.api = null
    this.state = new StateStore(STATE_PATH)
    this.status = { running: false, bot: null, error: null, offset: this.state.offset }
    this.noticeAt = new Map()
    /** Agents resumed by this bridge, keyed by session id; owned by this fiber. */
    this.handles = new Map()
  }

  start() {
    this.stop()

    if (!this.config.token) {
      this.status = { running: false, bot: null, error: 'missing bot token', offset: this.state.offset }
      return
    }

    this.state.load()
    const api = new TelegramApi({ token: this.config.token, proxy: this.config.proxy })
    this.api = api
    this.status = { running: true, bot: null, error: null, offset: this.state.offset }

    const route = this.config.proxy ? `via ${this.config.proxy}` : 'direct'
    this.ctx.logger.info(`telegram-remote: starting (token ${maskToken(this.config.token)}, ${route}, offset ${this.state.offset})`)
    void this.run(api)
  }

  stop() {
    const api = this.api
    this.api = null
    if (api) api.close()
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
      this.ctx.logger.warn(`telegram-remote: cannot register command menu: ${error.message}`)
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
          this.ctx.logger.warn(`telegram-remote: update ${update.update_id} failed: ${error.message}`)
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
      this.ctx.logger.error(`telegram-remote: bot token rejected: ${error.message}`)
      return false
    }

    if (isConflict(error)) {
      this.status.running = false
      this.ctx.logger.error('telegram-remote: another process is polling this bot (getUpdates 409); stop it first')
      return false
    }

    if (error.code === 429) {
      const wait = Math.max(1, Number(error.retryAfter) || 1)
      this.ctx.logger.warn(`telegram-remote: rate limited, retrying in ${wait}s`)
      await sleep(wait * 1000)
      return this.api === api
    }

    this.ctx.logger.warn(`telegram-remote: polling failed, retrying in ${Math.round(backoff / 1000)}s: ${error.message}`)
    await sleep(backoff)
    return this.api === api
  }

  async hello(api) {
    try {
      const me = await api.getMe()
      if (this.api !== api) return
      this.status.bot = me.username ? `@${me.username}` : String(me.first_name ?? me.id)
      this.status.error = null
      this.ctx.logger.info(`telegram-remote: connected as ${this.status.bot} (${me.id})`)
    } catch (error) {
      if (this.api !== api) return
      this.status.error = error.message
      this.ctx.logger.warn(`telegram-remote: cannot reach Bot API: ${error.message}`)
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
    this.state.clearBinding(chatId)
    try {
      this.state.save()
    } catch (error) {
      this.ctx.logger.warn(`telegram-remote: cannot save unbind: ${error.message}`)
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
        const handle = await agents.resume({ resumeSessionId: sessionId })
        this.handles.set(sessionId, handle)
        this.ctx.logger.info(`telegram-remote: resumed ${sessionId} for chat ${chatId}`)
      } catch (error) {
        if (!agents.get(sessionId)) {
          this.ctx.logger.warn(`telegram-remote: cannot resume ${sessionId}: ${error.message}`)
          await this.reply(api, chatId, `恢复会话失败：${error.message}`)
          return
        }
      }
    }

    this.state.setBinding(chatId, {
      sessionId,
      title: session.title || '',
      workspaceId: workspace.id,
      workspaceTitle: workspace.title,
      boundAt: Date.now(),
    })
    try {
      this.state.save()
    } catch (error) {
      this.ctx.logger.warn(`telegram-remote: cannot save binding: ${error.message}`)
    }

    await this.sendView(api, chatId, query.message?.message_id, {
      text: `已绑定：${session.title || '未命名'}\n工作区：${workspace.title}\n\n/unbind 解除绑定。`,
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
      this.ctx.logger.warn(`telegram-remote: answerCallbackQuery failed: ${error.message}`)
    }
  }

  async handleMessage(api, message) {
    const chatId = message.chat?.id
    const userId = message.from?.id
    if (typeof chatId !== 'number') return

    if (typeof userId !== 'number' || !this.isAllowed(userId)) {
      await this.reject(api, chatId)
      return
    }

    const text = typeof message.text === 'string' ? message.text.trim() : ''
    if (!text.startsWith('/')) {
      const stale = await this.pruneBinding(chatId)
      if (stale) {
        await this.reply(api, chatId, `之前绑定的「${stale.title || '未命名'}」已经不在了，已解除绑定。发 /sessions 重新选。`)
        return
      }
      const binding = this.state.binding(chatId)
      if (binding) {
        await this.reply(api, chatId, `已绑定「${binding.title || '未命名'}」。对话还没接上，先发 /help 看命令。`)
      } else {
        await this.reply(api, chatId, '先发 /sessions 选一个会话。')
      }
      return
    }

    const [head] = text.split(/\s+/)
    const command = head.slice(1).split('@')[0].toLowerCase()
    if (command === 'start') {
      await this.reply(api, chatId, '已连上。发 /sessions 选工作区和会话。')
      return
    }
    if (command === 'sessions') {
      await this.showWorkspaces(api, chatId)
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
      await this.reply(api, chatId, '可用命令：\n/start 检查连接\n/sessions 选择工作区/会话\n/unbind 解除绑定\n/help 查看命令')
      return
    }
    await this.reply(api, chatId, `还不认识 /${command}，发 /help 看现有命令。`)
  }

  isAllowed(userId) {
    const allowed = this.config.allowedUserIds
    return !Array.isArray(allowed) || allowed.length === 0 || allowed.includes(userId)
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
      this.ctx.logger.warn(`telegram-remote: sendMessage to ${chatId} failed: ${error.message}`)
    }
  }
}
