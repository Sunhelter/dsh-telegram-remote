/**
 * Model catalog and selection helpers for `/model` and bind replies.
 *
 * The Host owns the catalog: `sessionController.modelCatalog()` groups every
 * routable model by provider, and the durable choice is the `modelSelection`
 * projection (`next` falls back to `lastUsed`). A live agent's `options` is the
 * fallback when the projection has not recorded anything yet.
 */

import { truncate } from './sessions.js'

const PAGE_SIZE = 10
const BUTTON_LIMIT = 60
const CATALOG_TTL_MS = 60_000

/** Cached catalog; the model list changes rarely and every `/model` needs it. */
let cached = { at: 0, catalog: null }

/**
 * Read the provider-grouped model catalog, reusing a copy up to a minute old.
 * @param {object} ctx host context
 * @returns {Promise<{ ok: true, catalog: object } | { ok: false, error: string }>}
 */
export async function loadCatalog(ctx) {
  const controller = ctx.get('sessionController')
  if (!controller?.modelCatalog) {
    return { ok: false, error: '当前部署没有 sessionController，读不到模型列表。' }
  }
  if (cached.catalog && Date.now() - cached.at < CATALOG_TTL_MS) {
    return { ok: true, catalog: cached.catalog }
  }
  try {
    const catalog = await controller.modelCatalog()
    cached = { at: Date.now(), catalog }
    return { ok: true, catalog }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `读取模型列表失败：${message}` }
  }
}

/** Flatten provider groups into one ordered list for the picker. */
export function modelItems(catalog) {
  const items = []
  for (const group of catalog?.groups ?? []) {
    for (const model of group.models ?? []) {
      items.push({
        provider: group.id,
        providerName: group.name || group.id,
        model: model.id,
        modelName: model.name || model.id,
        reasoning: model.reasoning,
      })
    }
  }
  return items
}

/** Durable selection for one session, falling back to the live agent's options. */
export async function currentSelection(ctx, sessionId) {
  const cache = ctx.get('sessionProjectionCache')
  const persistence = ctx.get('sessionPersistence')
  if (cache && persistence) {
    try {
      const snapshots = await persistence.list()
      const header = snapshots.find((snapshot) => snapshot.header.id === sessionId)?.header
      if (header) {
        const value = cache.cachedSnapshot(header, ['modelSelection'])?.values?.modelSelection
        const selection = value?.next ?? value?.lastUsed
        if (selection?.provider && selection.model) return selection
      }
    } catch {
      // Fall through to the live agent: a broken projection must not block /model.
    }
  }

  const options = ctx.get('agents')?.get?.(sessionId)?.options
  if (options?.provider && options?.model) {
    return {
      provider: options.provider,
      model: options.model,
      ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
    }
  }
  return null
}

/** `提供商/模型名（effort）` for messages; ids stand in for unknown names. */
export function selectionLabel(selection, catalog) {
  if (!selection?.provider || !selection?.model) return '未知'
  const group = catalog?.groups?.find((item) => item.id === selection.provider)
  const model = group?.models?.find((item) => item.id === selection.model)
  const name = `${group?.name || selection.provider}/${model?.name || selection.model}`
  return selection.reasoningEffort ? `${name}（${selection.reasoningEffort}）` : name
}

/** Effort a pick should use: the model's default, matching the Web picker. */
export function selectionFor(item) {
  const effort = item.reasoning?.defaultEffort
  return {
    provider: item.provider,
    model: item.model,
    ...(effort ? { reasoningEffort: effort } : {}),
  }
}

/** Model picker keyboard and header; `items` indexes are the callback payloads. */
export function modelView({ items, page = 0, current = null, currentLabel = '', failures = [] }) {
  const lines = ['选择模型：']
  if (currentLabel) lines.push(`当前：${currentLabel}`)
  for (const failure of failures) {
    lines.push(`读取失败：${failure.name || failure.id}（${failure.message}）`)
  }

  if (items.length === 0) {
    lines.push('', '没有可用的模型。')
    return { text: lines.join('\n'), buttons: [] }
  }

  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE))
  const requested = Number.parseInt(page, 10)
  const currentPage = Number.isFinite(requested) ? Math.min(Math.max(requested, 0), pages - 1) : 0
  const start = currentPage * PAGE_SIZE
  const shown = items.slice(start, start + PAGE_SIZE)

  lines[0] = pages > 1
    ? `选择模型（第 ${currentPage + 1}/${pages} 页，共 ${items.length} 个）：`
    : `选择模型（共 ${items.length} 个）：`

  const buttons = shown.map((item, offset) => {
    const mark = current && current.provider === item.provider && current.model === item.model ? '✓ ' : ''
    return [{
      text: truncate(`${mark}${item.providerName} · ${item.modelName}`, BUTTON_LIMIT),
      callback_data: `m:${start + offset}`,
    }]
  })

  const nav = []
  if (currentPage > 0) nav.push({ text: '‹ 上一页', callback_data: `mp:${currentPage - 1}` })
  if (currentPage < pages - 1) nav.push({ text: '下一页 ›', callback_data: `mp:${currentPage + 1}` })
  if (nav.length > 0) buttons.push(nav)

  return { text: lines.join('\n'), buttons }
}
