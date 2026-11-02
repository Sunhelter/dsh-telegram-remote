/**
 * Workspace and Session listing for `/sessions`.
 *
 * The bridge runs inside the Host, so it reads the same services the Web
 * sidebar uses instead of an RPC client: `workspaceRegistry` for workspace
 * records and their header-validated session membership, `sessionPersistence`
 * for the durable headers, and `sessionProjectionCache` for the listed title.
 * Every service is optional; a profile without them gets a plain error text.
 */

const PAGE_SIZE = 10
const TITLE_LIMIT = 40
const BUTTON_LIMIT = 60

/** Shorten text for a Telegram message or button label. */
export function truncate(text, limit) {
  const value = String(text ?? '')
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`
}

/** Today shows HH:MM, older sessions show MM-DD. */
function clock(ms, now = new Date()) {
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value) => String(value).padStart(2, '0')
  const sameDay = date.toDateString() === now.toDateString()
  return sameDay
    ? `${pad(date.getHours())}:${pad(date.getMinutes())}`
    : `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Read the listed title and list metadata for one stored header. */
function describe(cache, header) {
  let block
  try {
    block = cache?.cachedSnapshot(header, ['title', 'sessionListMetadata'])
  } catch {
    block = undefined
  }

  const values = block?.values ?? {}
  let title = typeof values.title === 'string' ? values.title : ''
  if (title === '') {
    try {
      const predecessor = cache?.cachedPredecessorTitle(header)?.values?.title
      if (typeof predecessor === 'string') title = predecessor
    } catch {
      title = ''
    }
  }

  const metadata = values.sessionListMetadata
  const lastPrompt = Number(metadata?.lastPromptAt)
  return {
    id: header.id,
    title: title.trim(),
    updatedAt: Number.isFinite(lastPrompt) && lastPrompt > 0
      ? Math.max(header.createdAt, lastPrompt)
      : header.createdAt,
    blank: metadata?.blank === true,
  }
}

/**
 * Collect every workspace with its visible sessions, newest first.
 * @param {object} ctx host context
 * @returns {Promise<{ ok: true, workspaces: object[] } | { ok: false, error: string }>}
 */
export async function listWorkspaces(ctx) {
  const registry = ctx.get('workspaceRegistry')
  if (!registry) return { ok: false, error: '当前部署没有 workspaceRegistry，列不了会话。' }

  const persistence = ctx.get('sessionPersistence')
  if (!persistence) return { ok: false, error: '当前部署没有 sessionPersistence，列不了会话。' }

  let snapshots
  try {
    snapshots = await persistence.list()
  } catch (error) {
    return { ok: false, error: `读取会话失败：${error instanceof Error ? error.message : String(error)}` }
  }

  const cache = ctx.get('sessionProjectionCache')
  const headers = new Map()
  for (const snapshot of snapshots) headers.set(snapshot.header.id, snapshot.header)

  const archived = new Set(registry.archivedSessionIds ?? [])
  const workspaces = []
  for (const entity of registry.list()) {
    const sessions = []
    for (const id of entity.sessionIds ?? []) {
      if (archived.has(id)) continue
      const header = headers.get(id)
      if (!header) continue
      const info = describe(cache, header)
      if (info.blank) continue
      sessions.push(info)
    }
    sessions.sort((left, right) => right.updatedAt - left.updatedAt)
    workspaces.push({
      id: entity.id,
      title: entity.title?.trim() || entity.path,
      path: entity.path,
      sessions,
    })
  }
  return { ok: true, workspaces }
}

/**
 * First blank session already attached to one workspace. The Web sidebar reuses
 * such a row when you open a new conversation instead of minting another empty
 * session, and `/new` follows the same rule.
 * @param {object} ctx host context
 * @param {string} workspaceId workspace to look in
 * @returns {Promise<string | undefined>} reusable session id
 */
export async function blankSessionIn(ctx, workspaceId) {
  const registry = ctx.get('workspaceRegistry')
  const workspace = registry?.get?.(workspaceId)
  const persistence = ctx.get('sessionPersistence')
  const cache = ctx.get('sessionProjectionCache')
  if (!workspace || !persistence || !cache) return undefined

  const archived = new Set(registry.archivedSessionIds ?? [])
  const members = new Set(workspace.sessionIds ?? [])
  let snapshots
  try {
    snapshots = await persistence.list()
  } catch {
    return undefined
  }

  for (const { header } of snapshots) {
    if (archived.has(header.id) || !members.has(header.id)) continue
    let metadata
    try {
      metadata = cache.cachedSnapshot(header, ['sessionListMetadata'])?.values?.sessionListMetadata
    } catch {
      metadata = undefined
    }
    if (metadata?.blank === true) return header.id
  }
  return undefined
}

/** Clamp a requested page into range and return its slice start. */
function pageInfo(total, size, page) {
  const pages = Math.max(1, Math.ceil(total / size))
  const requested = Number.parseInt(page, 10)
  const current = Number.isFinite(requested) ? Math.min(Math.max(requested, 0), pages - 1) : 0
  return { pages, current, start: current * size }
}

/**
 * Workspace keyboard; one workspace per row keeps long titles readable.
 * `/sessions` and `/new` share it through different callback prefixes, so a tap
 * either lists that workspace's sessions or starts a new one there.
 */
export function workspaceView(workspaces, page = 0, { action = 'w', pageAction = 'p', heading = '选择工作区' } = {}) {
  if (workspaces.length === 0) {
    return { text: '还没有工作区。先在 Web 里新建一个会话。', buttons: [] }
  }

  const { pages, current, start } = pageInfo(workspaces.length, PAGE_SIZE, page)
  const shown = workspaces.slice(start, start + PAGE_SIZE)
  const lines = [pages > 1
    ? `${heading}（第 ${current + 1}/${pages} 页，共 ${workspaces.length} 个）：`
    : `${heading}：`]
  const buttons = shown.map((workspace) => [{
    text: truncate(`${workspace.title} (${workspace.sessions.length})`, BUTTON_LIMIT),
    callback_data: `${action}:${workspace.id}`,
  }])

  const nav = []
  if (current > 0) nav.push({ text: '‹ 上一页', callback_data: `${pageAction}:${current - 1}` })
  if (current < pages - 1) nav.push({ text: '下一页 ›', callback_data: `${pageAction}:${current + 1}` })
  if (nav.length > 0) buttons.push(nav)
  return { text: lines.join('\n'), buttons }
}

/** Session keyboard for one workspace; the bound session gets a check mark. */
export function sessionView(workspace, page = 0, boundId = null) {
  const lines = [`工作区：${workspace.title}`]
  if (workspace.path && workspace.path !== workspace.title) lines.push(workspace.path)

  const { pages, current, start } = pageInfo(workspace.sessions.length, PAGE_SIZE, page)
  const buttons = []
  if (workspace.sessions.length === 0) {
    lines.push('', '这个工作区还没有会话。')
  } else {
    const shown = workspace.sessions.slice(start, start + PAGE_SIZE)
    const suffix = pages > 1 ? `（第 ${current + 1}/${pages} 页）` : ''
    lines.push('', `共 ${workspace.sessions.length} 个会话，按最近使用排序${suffix}：`)
    for (const session of shown) {
      const title = session.title || '未命名'
      const mark = session.id === boundId ? '✓ ' : ''
      buttons.push([{
        text: `${mark}${clock(session.updatedAt)}  ${truncate(title, TITLE_LIMIT)}`,
        callback_data: `s:${session.id}`,
      }])
    }
  }

  const nav = []
  if (current > 0) {
    nav.push({ text: '‹ 上一页', callback_data: `w:${workspace.id}:${current - 1}` })
  }
  if (current < pages - 1) {
    nav.push({ text: '下一页 ›', callback_data: `w:${workspace.id}:${current + 1}` })
  }
  if (nav.length > 0) buttons.push(nav)
  buttons.push([{ text: '‹ 工作区', callback_data: 'p:0' }])
  return { text: lines.join('\n'), buttons }
}
