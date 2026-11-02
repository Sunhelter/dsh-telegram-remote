/** Thin Telegram Bot API client. Every method posts JSON and unwraps `result`. */
import { request } from './proxy.js'

const PREVIEW_LIMIT = 300

/** API error carrying the status, error_code and retry_after the bridge reacts to. */
export class TelegramError extends Error {
  constructor(message, { method, status = 0, code = 0, retryAfter = 0 } = {}) {
    super(message)
    this.name = 'TelegramError'
    this.method = method
    this.status = status
    this.code = code
    this.retryAfter = retryAfter
  }
}

export class TelegramApi {
  constructor({ token, proxy = '', timeoutMs = 60000 }) {
    this.token = token
    this.proxy = proxy
    this.timeoutMs = timeoutMs
    this.controllers = new Set()
  }

  async call(method, params = {}, { timeoutMs = this.timeoutMs } = {}) {
    const url = `https://api.telegram.org/bot${this.token}/${method}`
    const controller = new AbortController()
    this.controllers.add(controller)

    let res
    try {
      res = await request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params ?? {}),
        timeoutMs,
        proxy: this.proxy,
        signal: controller.signal,
      })
    } finally {
      this.controllers.delete(controller)
    }

    let data
    try {
      data = JSON.parse(res.body)
    } catch {
      throw new TelegramError(`Telegram API ${method}: HTTP ${res.status} ${res.body.slice(0, PREVIEW_LIMIT)}`, {
        method,
        status: res.status,
      })
    }

    if (!data.ok) {
      throw new TelegramError(
        `Telegram API ${method}: ${data.description ?? `HTTP ${res.status}`}${data.error_code ? ` (${data.error_code})` : ''}`,
        {
          method,
          status: res.status,
          code: data.error_code ?? 0,
          retryAfter: data.parameters?.retry_after ?? 0,
        },
      )
    }
    return data.result
  }

  /** Abort every in-flight request; used when the bridge stops or restarts. */
  close() {
    for (const controller of this.controllers) controller.abort()
    this.controllers.clear()
  }

  getMe() {
    return this.call('getMe')
  }

  getUpdates({ offset = 0, timeoutSec = 30, allowedUpdates = ['message', 'callback_query'] } = {}) {
    return this.call(
      'getUpdates',
      { offset, timeout: timeoutSec, allowed_updates: allowedUpdates },
      { timeoutMs: (timeoutSec + 20) * 1000 },
    )
  }

  sendMessage(chatId, text, extra = {}) {
    return this.call('sendMessage', { chat_id: chatId, text, ...extra })
  }

  editMessageText(chatId, messageId, text, extra = {}) {
    return this.call('editMessageText', { chat_id: chatId, message_id: messageId, text, ...extra })
  }

  answerCallbackQuery(callbackQueryId, text) {
    return this.call('answerCallbackQuery', { callback_query_id: callbackQueryId, ...(text ? { text } : {}) })
  }

  setMyCommands(commands) {
    return this.call('setMyCommands', { commands })
  }
}
