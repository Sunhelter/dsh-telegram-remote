/**
 * `ask_user_question` over Telegram.
 *
 * The Web Client owns a question while it is open on that session; this hub
 * only takes the request when nobody else claimed it (no live Client, or the
 * Client delegated a session it is not showing). The question then sits here
 * untouched until the chat bound to that session answers it, the turn is
 * aborted, or the bridge stops — the same pending state the Web page shows when
 * the session is opened again.
 */
import { randomUUID } from 'node:crypto'

const CALLBACK_PATTERN = /^qa:(t|k|o|x):(\d+)(?::(\d+))?$/
const BUTTON_TEXT_LIMIT = 64
const CARD_TEXT_LIMIT = 3800

/** Trim a card so Telegram's 4096-character cap keeps room for the fix-up. */
function fit(text) {
  return text.length > CARD_TEXT_LIMIT ? `${text.slice(0, CARD_TEXT_LIMIT - 1)}…` : text
}

export class QuestionHub {
  constructor(bridge) {
    this.bridge = bridge
    this.log = bridge.log
    /** Session id -> question batch waiting for a Telegram answer. */
    this.pending = new Map()
    /** Chat id -> `{ pending, messageId, custom }` for the card on screen. */
    this.views = new Map()
  }

  /**
   * Waterfall listener body. With no live Client nothing else can answer, so
   * Telegram claims straight away; otherwise the Web gets first refusal and
   * this only takes over when its forward delegates (`NO_PROVIDER`).
   */
  accept(request, next) {
    if (!this.clientIsLive()) {
      const claimed = this.claim(request)
      return claimed === undefined ? next() : claimed
    }
    return Promise.resolve()
      .then(() => next())
      .catch((error) => {
        if (error?.code !== 'NO_PROVIDER') throw error
        const claimed = this.claim(request)
        if (claimed !== undefined) return claimed
        throw error
      })
  }

  /** True while a Web Client that can answer questions is connected. */
  clientIsLive() {
    const gateway = this.bridge.ctx.get('typertGateway')
    return typeof gateway?.hasLiveClient === 'function' ? gateway.hasLiveClient() : false
  }

  /** Hold one request; undefined means "not claiming, ask the next listener". */
  claim(request) {
    const api = this.bridge.api
    const sessionId = request?.agent?.session?.id
    const questions = Array.isArray(request?.questions) ? request.questions : []
    if (!api || !sessionId || questions.length === 0) return undefined
    // One question per turn; a second one for the same session is not ours.
    if (this.pending.has(sessionId)) return undefined

    const pending = {
      sessionId,
      callId: request.wait?.callId ?? randomUUID(),
      questions,
      index: 0,
      answers: new Map(),
      drafts: new Map(),
      chats: new Map(),
      lastText: '',
      resolve: null,
      reject: null,
      detach: null,
    }

    return new Promise((resolve, reject) => {
      pending.resolve = resolve
      pending.reject = reject
      this.pending.set(sessionId, pending)

      const signal = request.signal
      if (signal?.aborted) {
        this.cancel(pending, signal.reason)
        return
      }
      if (typeof signal?.addEventListener === 'function') {
        const onAbort = () => this.cancel(pending, signal.reason)
        signal.addEventListener('abort', onAbort, { once: true })
        pending.detach = () => signal.removeEventListener('abort', onAbort)
      }

      const bound = this.bridge.boundChatsTo(sessionId)
      this.log.info(
        `telegram-remote: holding ask_user_question for ${sessionId.slice(-8)} (${questions.length} questions, ${bound.length} bound chats)`,
      )
      for (const chatId of bound) {
        this.bridge.noteWaiting(chatId, sessionId)
        void this.show(api, chatId, sessionId)
      }
      void this.notify(api, pending, new Set(bound))
    })
  }

  /** Render this session's pending question in one chat; false when there is none. */
  async show(api, chatId, sessionId) {
    const pending = this.pending.get(sessionId)
    if (!pending) return false
    await this.render(api, chatId, pending, pending.chats.get(chatId))
    return true
  }

  /** Send or edit the current question card and remember its message id. */
  async render(api, chatId, pending, messageId) {
    const card = this.card(pending)
    pending.lastText = card.text
    const view = { pending, messageId: messageId ?? null, custom: false }
    this.views.set(chatId, view)
    const sent = await this.bridge.sendView(api, chatId, messageId, card)
    if (typeof sent === 'number') {
      view.messageId = sent
      pending.chats.set(chatId, sent)
    }
  }

  /** Redraw the card wherever it is on screen, after the cursor moved. */
  async rerender(api, pending) {
    for (const [chatId, view] of [...this.views]) {
      if (view.pending !== pending) continue
      await this.render(api, chatId, pending, view.messageId ?? undefined)
    }
  }

  /** Text and buttons for the question at the current cursor. */
  card(pending) {
    const question = pending.questions[pending.index]
    if (!question) return { text: '这个问答已经结束了。', buttons: [] }

    const lines = []
    const title = this.title(pending.sessionId)
    if (title) lines.push(`会话：${title}`)
    if (question.header) lines.push(`【${question.header}】`)
    lines.push(question.question)
    if (question.detail) lines.push('', question.detail)

    const described = (question.options ?? []).filter((option) => option.description)
    if (described.length > 0) {
      lines.push('')
      for (const option of described) lines.push(`· ${option.label}：${option.description}`)
    }
    if (pending.questions.length > 1) lines.push('', `第 ${pending.index + 1}/${pending.questions.length} 题`)

    const buttons = []
    const draft = pending.drafts.get(question.id)
    for (const [index, option] of (question.options ?? []).entries()) {
      const mark = question.multiSelect ? (draft?.has(option.label) ? '☑ ' : '☐ ') : ''
      buttons.push([{
        text: `${mark}${option.label}`.slice(0, BUTTON_TEXT_LIMIT),
        callback_data: `qa:t:${pending.index}:${index}`,
      }])
    }
    if (question.multiSelect && (question.options ?? []).length > 0) {
      buttons.push([{ text: '确认', callback_data: `qa:k:${pending.index}` }])
    }
    buttons.push([
      { text: '其他…', callback_data: `qa:o:${pending.index}` },
      { text: '暂不处理', callback_data: `qa:x:${pending.index}` },
    ])

    return { text: fit(lines.join('\n')), buttons }
  }

  /** Session title from whichever bound chat carries one; '' when unknown. */
  title(sessionId) {
    for (const chatId of this.bridge.boundChatsTo(sessionId)) {
      const title = this.bridge.state.binding(chatId)?.title
      if (title) return title
    }
    return ''
  }

  /** Tell whitelisted chats that were not already shown the card. */
  async notify(api, pending, bound) {
    const allowed = Array.isArray(this.bridge.config.allowedUserIds) ? this.bridge.config.allowedUserIds : []
    const title = this.title(pending.sessionId)
    const text = title ? `您有一条会话等待回答：${title}` : '您有一条会话等待回答'
    for (const chatId of allowed) {
      if (!Number.isSafeInteger(chatId) || bound.has(chatId)) continue
      await this.bridge.reply(api, chatId, text, {
        reply_markup: { inline_keyboard: [[{ text: '切换到该会话', callback_data: `sw:${pending.sessionId}` }]] },
      })
    }
  }

  /** Record one submitted answer and move to the next question. */
  async submit(api, pending, question, answer) {
    pending.answers.set(question.id, { id: question.id, ...answer })
    pending.drafts.delete(question.id)
    pending.index += 1
    if (pending.index >= pending.questions.length) {
      this.finish(pending)
      return
    }
    await this.rerender(api, pending)
  }

  /** Close every card, then hand the answers back to the waiting tool call. */
  finish(pending) {
    if (this.pending.get(pending.sessionId) !== pending) return
    this.pending.delete(pending.sessionId)
    pending.detach?.()

    const answers = pending.questions.map((question) => {
      const answer = pending.answers.get(question.id)
      return answer ? { ...answer } : { id: question.id, selected: [] }
    })

    const api = this.bridge.api
    for (const [chatId, messageId] of pending.chats) {
      this.forgetChat(chatId)
      if (api && typeof messageId === 'number') {
        void this.bridge.sendView(api, chatId, messageId, {
          text: `${pending.lastText}\n\n✅ 已回答`,
          buttons: [],
        })
      }
    }
    pending.chats.clear()
    this.log.info(`telegram-remote: ask_user_question for ${pending.sessionId.slice(-8)} answered`)
    pending.resolve({ answers })
  }

  /** The turn died before an answer: drop the cards and fail the request. */
  cancel(pending, reason) {
    if (this.pending.get(pending.sessionId) !== pending) return
    this.pending.delete(pending.sessionId)
    pending.detach?.()

    const api = this.bridge.api
    for (const [chatId, messageId] of pending.chats) {
      this.forgetChat(chatId)
      if (api && typeof messageId === 'number') {
        void this.bridge.sendView(api, chatId, messageId, {
          text: `${pending.lastText}\n\n❔ 问题已取消`,
          buttons: [],
        })
      }
    }
    pending.chats.clear()
    pending.reject(reason instanceof Error ? reason : new Error('会话问答已取消'))
  }

  /** Handle one `qa:` callback; false when the payload is not ours. */
  async onCallback(api, query, chatId, data) {
    const match = CALLBACK_PATTERN.exec(data)
    if (!match) return false

    const view = this.views.get(chatId)
    const pending = view?.pending
    if (!pending || this.pending.get(pending.sessionId) !== pending) {
      await this.bridge.answer(api, query.id, '这个问答已经不在当前会话了')
      return true
    }

    const index = Number.parseInt(match[2], 10)
    if (index !== pending.index) {
      await this.bridge.answer(api, query.id, '这个按钮已经过期了')
      return true
    }

    const question = pending.questions[pending.index]
    const action = match[1]
    const optionIndex = match[3] === undefined ? -1 : Number.parseInt(match[3], 10)

    if (action === 't') {
      const option = question.options?.[optionIndex]
      if (!option) {
        await this.bridge.answer(api, query.id, '这个按钮已经过期了')
        return true
      }
      if (question.multiSelect) {
        const draft = pending.drafts.get(question.id) ?? new Set()
        if (draft.has(option.label)) draft.delete(option.label)
        else draft.add(option.label)
        pending.drafts.set(question.id, draft)
        await this.bridge.answer(api, query.id)
        await this.rerender(api, pending)
        return true
      }
      await this.bridge.answer(api, query.id)
      await this.submit(api, pending, question, { selected: [option.label] })
      return true
    }

    if (action === 'k') {
      if (!question.multiSelect) {
        await this.bridge.answer(api, query.id, '这个按钮已经过期了')
        return true
      }
      const draft = pending.drafts.get(question.id)
      if (!draft || draft.size === 0) {
        await this.bridge.answer(api, query.id, '至少要选一项')
        return true
      }
      await this.bridge.answer(api, query.id)
      await this.submit(api, pending, question, { selected: [...draft] })
      return true
    }

    if (action === 'o') {
      view.custom = true
      await this.bridge.answer(api, query.id, '直接发文本')
      await this.bridge.reply(api, chatId, '请直接发文本，作为这一题的回答。')
      return true
    }

    // 暂不处理: leave the question alone and go back to the unbound state.
    await this.bridge.answer(api, query.id)
    this.bridge.dropBinding(chatId)
    await this.bridge.reply(api, chatId, '已返回未绑定状态。这个问题还留着，发 /sessions 再进这个会话就能回答。')
    return true
  }

  /** Consume a text message as the answer it is; false when this chat has no card. */
  async consumeText(api, chatId, text) {
    if (!text) return false
    const view = this.views.get(chatId)
    const pending = view?.pending
    if (!pending) return false
    if (this.pending.get(pending.sessionId) !== pending) {
      this.forgetChat(chatId)
      return false
    }

    const question = pending.questions[pending.index]
    if (!question) return false
    if (!view.custom && (question.options ?? []).length > 0) {
      await this.bridge.reply(api, chatId, '这个会话正在等回答：先点上面的选项，或点「其他…」输入自己的回答。')
      return true
    }

    await this.submit(api, pending, question, { selected: [], custom: text })
    return true
  }

  /** Drop the card shown in one chat (unbound, switched away, answered). */
  forgetChat(chatId) {
    this.views.delete(chatId)
  }

  /**
   * Close the card one chat was showing while the question stays open, so
   * coming back sends a fresh card instead of silently re-editing the old
   * message with the text it already has.
   */
  retire(chatId, note) {
    const view = this.views.get(chatId)
    this.views.delete(chatId)
    if (!view) return
    const pending = view.pending
    const messageId = pending.chats.get(chatId)
    pending.chats.delete(chatId)
    const api = this.bridge.api
    if (!api || typeof messageId !== 'number') return
    void this.bridge.sendView(api, chatId, messageId, {
      text: `${pending.lastText}\n\n${note}`,
      buttons: [],
    })
  }

  /** Reject everything still waiting; the bridge is going away. */
  dispose() {
    for (const pending of [...this.pending.values()]) {
      this.pending.delete(pending.sessionId)
        pending.detach?.()
      pending.reject(new Error('telegram-remote stopped'))
    }
    this.pending.clear()
    this.views.clear()
  }
}
