/**
 * Config resolution. Priority: cordis config > telegram.local.json > env > default.
 *
 * Both files live next to the package so the plugin works when installed as a
 * `link:` dependency from this checkout; nothing is written into the profile.
 * The settings page writes telegram.local.json through `saveLocalConfig`.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

export const LOCAL_CONFIG_PATH = join(PLUGIN_DIR, 'telegram.local.json')
export const STATE_PATH = join(PLUGIN_DIR, 'state.json')

const DEFAULTS = {
  token: '',
  allowedUserIds: [],
  proxy: '',
  pollTimeoutSec: 30,
  maxMessageLength: 4096,
}

export function readLocalConfig(path = LOCAL_CONFIG_PATH) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** Merge one patch into telegram.local.json, atomically and owner-only. */
export function saveLocalConfig(patch, path = LOCAL_CONFIG_PATH) {
  const next = { ...readLocalConfig(path), ...patch }
  for (const key of Object.keys(next)) {
    if (next[key] === undefined) delete next[key]
  }
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
  return next
}

function toIdList(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  const ids = []
  for (const entry of list) {
    const id = Number(String(entry).trim())
    if (Number.isSafeInteger(id) && id > 0) ids.push(id)
  }
  return ids
}

function toPositiveInt(value, fallback) {
  const n = Number(value)
  return Number.isSafeInteger(n) && n > 0 ? n : fallback
}

export function resolveConfig(config = {}, local = readLocalConfig()) {
  const pick = (key, envName) => {
    const fromConfig = config[key]
    if (fromConfig !== undefined && fromConfig !== null && fromConfig !== '') return fromConfig
    const fromLocal = local[key]
    if (fromLocal !== undefined && fromLocal !== null && fromLocal !== '') return fromLocal
    return process.env[envName]
  }

  return {
    token: String(pick('token', 'DSH_TELEGRAM_TOKEN') ?? '').trim(),
    allowedUserIds: toIdList(pick('allowedUserIds', 'DSH_TELEGRAM_ALLOWED_USER_IDS')),
    proxy: String(pick('proxy', 'DSH_TELEGRAM_PROXY') ?? '').trim(),
    pollTimeoutSec: toPositiveInt(pick('pollTimeoutSec', 'DSH_TELEGRAM_POLL_TIMEOUT_SEC'), DEFAULTS.pollTimeoutSec),
    maxMessageLength: toPositiveInt(pick('maxMessageLength', 'DSH_TELEGRAM_MAX_MESSAGE_LENGTH'), DEFAULTS.maxMessageLength),
  }
}

/** Never log or echo the raw token; keep the bot id and a short prefix. */
export function maskToken(token) {
  if (!token) return ''
  const [id, rest = ''] = token.split(':')
  return `${id}:${rest ? `${rest.slice(0, 4)}…` : '…'}`
}
