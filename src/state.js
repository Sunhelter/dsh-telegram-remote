/** Persistent bridge state: the long-poll offset plus chat -> session bindings. */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'

export function emptyState() {
  return { offset: 0, bindings: {} }
}

export class StateStore {
  constructor(path) {
    this.path = path
    this.data = emptyState()
  }

  load() {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'))
      this.data = {
        offset: Number.isSafeInteger(parsed?.offset) ? parsed.offset : 0,
        bindings: parsed?.bindings && typeof parsed.bindings === 'object' ? parsed.bindings : {},
      }
    } catch {
      this.data = emptyState()
    }
    return this.data
  }

  save() {
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, this.path)
  }

  get offset() {
    return this.data.offset
  }

  set offset(value) {
    this.data.offset = Number.isSafeInteger(value) ? value : this.data.offset
  }

  binding(chatId) {
    return this.data.bindings[String(chatId)] ?? null
  }

  setBinding(chatId, binding) {
    this.data.bindings[String(chatId)] = binding
  }

  clearBinding(chatId) {
    delete this.data.bindings[String(chatId)]
  }
}
