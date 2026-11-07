/**
 * Streaming reply sink for one assistant attempt.
 *
 * The bridge pushes raw `text-delta`s here; the outbox owns everything the
 * chat sees: markdown is flattened to plain text (Telegram does not render it)
 * and the text spills into the next message once it has grown long enough.
 *
 * Split points prefer readable boundaries as the message approaches the
 * configured limit (80% blank line, 90% sentence end, 95% any punctuation) and
 * fall back to a hard cut at 4000 characters.
 */

const FORCE_CUT = 4000
const PARAGRAPH_SHARE = 0.8
const SENTENCE_SHARE = 0.9
const PUNCTUATION_SHARE = 0.95
// The first message waits for a real sentence: publishing the opening deltas
// right away shows up as "🐳 \n白名", which reads badly in the chat.
const FIRST_SEND_CHARS = 60
const FIRST_SEND_MIN = 6

const SENTENCE_END = /[。！？!?.…]/
const ANY_PUNCT = /[。！？!?.…，、；：,;:]/

/** Flatten common markdown into the plain text Telegram actually displays. */
export function toPlainText(text) {
  return text
    .replace(/^```[^\n]*$/gm, '')
    .replace(/^~~~[^\n]*$/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\*\*\*([^*\n]+)\*\*\*/g, '$1')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
    .replace(/(?<![\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, '$1')
    .replace(/(?<![\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '')
}

/** Whether the first message has enough text to look like a real reply. */
function firstReady(text) {
  if (text.length >= FIRST_SEND_CHARS) return true
  return text.length >= FIRST_SEND_MIN && SENTENCE_END.test(text)
}

/** First punctuation of `pattern` at or after `floor`, cutting after it. */
function firstPunctuation(text, pattern, floor, cap) {
  for (let index = floor; index < cap; index += 1) {
    if (pattern.test(text[index])) return index + 1
  }
  return -1
}

/** Back off one code unit when a hard cut would split a surrogate pair. */
function safeCut(text, index) {
  if (index <= 0 || index >= text.length) return index
  const code = text.charCodeAt(index - 1)
  return code >= 0xd800 && code <= 0xdbff ? index - 1 : index
}

/**
 * Where the current message should end, or -1 to keep growing it.
 *
 * Past 80% the reply waits for a blank line, past 90% for a sentence end and
 * past 95% for any punctuation; with none of them by 4000 characters the
 * message is cut hard there.
 */
export function findCut(text, limit) {
  const length = text.length
  const force = Math.min(FORCE_CUT, limit)
  const cap = Math.min(length, force)
  const paragraph = Math.floor(limit * PARAGRAPH_SHARE)
  const sentence = Math.floor(limit * SENTENCE_SHARE)
  const punctuation = Math.floor(limit * PUNCTUATION_SHARE)

  let cut = -1
  if (length >= punctuation) {
    cut = firstPunctuation(text, ANY_PUNCT, punctuation, cap)
  } else if (length >= sentence) {
    cut = firstPunctuation(text, SENTENCE_END, sentence, cap)
  } else if (length >= paragraph) {
    const index = text.indexOf('\n\n', paragraph)
    if (index >= 0 && index + 2 <= cap) cut = index + 2
  }
  if (cut > 0) return cut
  return length >= force ? safeCut(text, force) : -1
}

/**
 * One chat-side reply: accumulates text, renders the open message, and starts
 * a new Telegram message whenever `findCut` finds a boundary.
 */
export class ReplyOutbox {
  constructor({ limit, sendText, editText, log = () => {}, prefix = '' }) {
    // The prefix rides on every message, so it eats into the budget.
    this.prefix = prefix
    this.limit = Math.max(64, limit - prefix.length)
    this.sendText = sendText
    this.editText = editText
    this.log = log
    /** Raw text not yet folded into the open message. */
    this.pending = ''
    /** Text already rendered into the open message. */
    this.rendered = ''
    /** False until the first message exists; leading whitespace is dropped then. */
    this.started = false
    this.messageId = null
    this.sentText = ''
    this.closed = false
  }

  /** Raw text received so far, cleaned, for tests and callers that need it. */
  get text() {
    const body = this.rendered + toPlainText(this.pending)
    return this.started ? body : body.replace(/^\s+/, '')
  }

  push(delta) {
    if (!this.closed) this.pending += delta
  }

  /** Render the open message; called on the bridge's streaming timer. */
  async flush() {
    if (!this.closed) await this.drain()
  }

  /** Finish the attempt: append `suffix` (e.g. an interruption note) and flush. */
  async close(suffix = '') {
    if (this.closed) return
    this.closed = true
    if (suffix) this.pending += suffix
    await this.drain()
  }

  async drain() {
    for (let guard = 0; guard < 10; guard += 1) {
      // Take the accumulated text now: Telegram writes are slow and deltas keep
      // arriving while the message is in flight.
      const raw = this.pending
      this.pending = ''
      let text = this.rendered + toPlainText(raw)
      if (!this.started) text = text.replace(/^\s+/, '')
      if (!this.started && !this.closed && !firstReady(text)) {
        // Nothing has been posted yet: hold the deltas instead of opening a
        // message with a couple of characters and a stray newline.
        this.pending = text + this.pending
        return
      }
      try {
        const cut = findCut(text, this.limit)
        if (cut <= 0) {
          await this.render(text)
          this.rendered = text
          return
        }

        const head = text.slice(0, cut).trimEnd()
        const rest = text.slice(cut).replace(/^\s+/, '')
        if (head) await this.render(head)
        this.rendered = ''
        this.messageId = null
        this.sentText = ''
        this.pending = rest + this.pending
        if (!this.pending) return
      } catch (error) {
        // Nothing was consumed: retry with everything on the next flush.
        this.pending = raw + this.pending
        throw error
      }
    }
  }

  async render(text) {
    if (!text || text === this.sentText) return
    const body = this.prefix + text
    if (this.messageId === null) {
      const sent = await this.sendText(body)
      if (typeof sent?.message_id === 'number') this.messageId = sent.message_id
      this.started = true
      this.sentText = text
      return
    }
    try {
      await this.editText(this.messageId, body)
      this.sentText = text
    } catch (error) {
      // A 429 has to reach the bridge so it can pause this chat; the text is
      // still in `pending` and the same message is edited again later.
      if (error?.code === 429) throw error
      if (/message is not modified/i.test(error.message)) {
        this.sentText = text
        return
      }
      this.log(`telegram-remote: editing reply failed: ${error.message}`)
      // Send the whole text again as a fresh message on the next flush.
      this.messageId = null
      this.sentText = ''
    }
  }
}
