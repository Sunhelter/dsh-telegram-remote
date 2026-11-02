/**
 * In-memory log ring for the Settings page log window.
 *
 * Every telegram-remote log line goes through `createLog`, which mirrors the
 * line to `ctx.logger` and appends it here. The buffer lives in the module, so
 * it survives `bridge.restart()`; it is intentionally bounded and lost on
 * process restart.
 */

const LIMIT = 200

const entries = []
let seq = 0

function describe(value) {
  if (value instanceof Error) return value.message
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function record(level, args) {
  const message = args.map(describe).join(' ')
  seq += 1
  entries.push({ seq, at: Date.now(), level, message })
  if (entries.length > LIMIT) entries.splice(0, entries.length - LIMIT)
  return message
}

/** Logger that feeds the ring buffer and forwards to the host logger. */
export function createLog(ctx) {
  const logger = ctx.logger
  const write = (level) => (...args) => {
    const message = record(level, args)
    logger?.[level]?.(message)
  }
  return { info: write('info'), warn: write('warn'), error: write('error') }
}

/** Entries newer than `after` (0 means the whole retained buffer). */
export function logSnapshot({ after = 0 } = {}) {
  const list = after > 0 ? entries.filter((entry) => entry.seq > after) : entries.slice()
  return { seq, entries: list }
}
