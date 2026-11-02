/**
 * Host half of the Telegram remote bundle.
 *
 * The bridge starts from telegram.local.json (or the row config) and can be
 * reconfigured at runtime from the plugin's Settings page. `agents` and
 * `webServer` are required: the settings page talks to this plugin over
 * same-origin routes, never over a direct Host service call.
 */
import { maskToken, resolveConfig, saveLocalConfig } from './src/config.js'
import { createLog, logSnapshot } from './src/logbuffer.js'
import { Bridge } from './src/bridge.js'

export const name = 'telegram-remote'

export const inject = ['agents', 'webServer']

/** Same-origin endpoint the settings page reads and writes. */
const CONFIG_PATH = '/plugins/telegram-remote/config'

/** Same-origin endpoint the settings page polls for the log window. */
const LOGS_PATH = '/plugins/telegram-remote/logs'

const MAX_BODY_BYTES = 16 * 1024

const TOKEN_PATTERN = /^\d{5,}:[A-Za-z0-9_-]{20,}$/

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

async function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  return JSON.parse(text)
}

/** Apply Connection's Host/Origin and browser-authentication checks to this route. */
function rejectUntrusted(ctx, req, res) {
  const connection = ctx.get('connection')
  if (connection === undefined) return false
  const rejection = connection.requestRejection(req)
  if (rejection === undefined) return false
  sendJson(res, rejection, {
    ok: false,
    error: rejection === 401 ? '未通过浏览器鉴权' : '受信任来源校验失败',
  })
  return true
}

/** Validate one form submission and turn it into a telegram.local.json patch. */
function normalizeTicket(body) {
  const patch = {}

  if (typeof body.token === 'string' && body.token.trim() !== '') {
    const token = body.token.trim()
    if (!TOKEN_PATTERN.test(token)) throw new Error('token 格式不对，应为 123456:ABC… 形式')
    patch.token = token
  }
  if (body.clearToken === true) patch.token = ''

  if (body.allowedUserIds !== undefined) {
    const raw = Array.isArray(body.allowedUserIds)
      ? body.allowedUserIds
      : String(body.allowedUserIds).split(',')
    const ids = []
    for (const entry of raw) {
      const text = String(entry).trim()
      if (text === '') continue
      if (!/^\d+$/.test(text)) throw new Error(`用户 ID 只能是数字：${text}`)
      ids.push(Number(text))
    }
    patch.allowedUserIds = ids
  }

  if (body.proxy !== undefined) {
    const proxy = String(body.proxy).trim()
    if (proxy !== '') {
      let parsed
      try {
        parsed = new URL(proxy)
      } catch {
        throw new Error('代理地址格式不对，例如 http://127.0.0.1:7890')
      }
      if (parsed.protocol !== 'http:') {
        throw new Error('代理只支持 http:// 的 CONNECT 隧道')
      }
    }
    patch.proxy = proxy
  }

  if (body.pollTimeoutSec !== undefined) {
    const seconds = Number(body.pollTimeoutSec)
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 300) {
      throw new Error('长轮询秒数应为 1 到 300 之间的整数')
    }
    patch.pollTimeoutSec = seconds
  }

  return patch
}

export function apply(ctx, config) {
  const rowConfig = config ?? {}
  let resolved = resolveConfig(rowConfig)
  const bridge = new Bridge(ctx, resolved)
  const log = createLog(ctx)
  // Agents owned by the Web app live outside this plugin's scope; global
  // listeners are required to mirror their streams and session events.
  ctx.on('agent/assistant-stream', (payload) => bridge.onAssistantStream(payload), { global: true })
  ctx.on('agent/error', (payload) => bridge.onAgentError(payload), { global: true })
  ctx.on('session/event', (session, event) => bridge.onSessionEvent(session, event), { global: true })
  // ask_user_question: the Web Client claims first while it is open on the
  // session. With no live Client the forwarded Remote waterfall would hold the
  // request forever, so this listener has to run before it and take the
  // question itself.
  ctx.on(
    'user-questions/request',
    (request, next) => bridge.questions.accept(request, next),
    { global: true, prepend: true },
  )

  const snapshot = () => ({
    ok: true,
    config: {
      token: maskToken(resolved.token),
      hasToken: Boolean(resolved.token),
      allowedUserIds: resolved.allowedUserIds,
      proxy: resolved.proxy,
      pollTimeoutSec: resolved.pollTimeoutSec,
    },
    status: bridge.status,
  })

  ctx.effect(() => {
    // Both are required: an empty whitelist would otherwise let anyone who
    // finds the bot drive this machine, so it counts as "not configured".
    // `start` itself refuses in that case and records why for the settings page.
    if (!resolved.token) {
      log.warn('telegram-remote: no bot token yet; add one in Settings > Telegram 遥控')
    } else if (resolved.allowedUserIds.length === 0) {
      log.warn('telegram-remote: no allowed user id yet; add one in Settings > Telegram 遥控')
    }
    bridge.start()
    return () => bridge.stop()
  }, 'telegram-remote: bridge lifecycle')

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: CONFIG_PATH,
        handler: async (req, res) => {
          if (rejectUntrusted(ctx, req, res)) return

          if (req.method === 'GET') {
            sendJson(res, 200, snapshot())
            return
          }

          if (req.method !== 'POST') {
            res.writeHead(405, { allow: 'GET, POST' })
            res.end()
            return
          }

          let body
          try {
            body = await readJsonBody(req)
          } catch (error) {
            sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : '请求体无法解析' })
            return
          }

          let patch
          try {
            patch = normalizeTicket(body)
          } catch (error) {
            sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : '参数不正确' })
            return
          }

          try {
            saveLocalConfig(patch)
            resolved = resolveConfig(rowConfig)
            bridge.restart(resolved)
            log.info(`telegram-remote: config saved from settings page (token ${maskToken(resolved.token) || 'none'})`)
            sendJson(res, 200, snapshot())
          } catch (error) {
            sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : '保存配置失败' })
          }
        },
      }),
    'telegram-remote: config route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: LOGS_PATH,
        handler: (req, res) => {
          if (rejectUntrusted(ctx, req, res)) return
          if (req.method !== 'GET') {
            res.writeHead(405, { allow: 'GET' })
            res.end()
            return
          }
          const requested = Number.parseInt(new URL(req.url ?? LOGS_PATH, 'http://localhost').searchParams.get('after') ?? '', 10)
          const after = Number.isFinite(requested) ? Math.max(0, requested) : 0
          sendJson(res, 200, { ok: true, ...logSnapshot({ after }) })
        },
      }),
    'telegram-remote: logs route',
  )
}
