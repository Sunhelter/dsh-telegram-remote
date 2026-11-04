/**
 * dsh-telegram-remote client bundle.
 *
 * Hand-written in the format the Host module loader executes: one `load` call
 * whose factory returns `{ inject, apply }`. React comes from the shared module
 * table via `require`; nothing is bundled and no build step exists.
 *
 * The only surface is a Settings page that reads and writes the bot config over
 * the plugin's own same-origin route (GET/POST /plugins/telegram-remote/config).
 */
window.__ModuleLoader__.load({
	id: '@local/dsh-telegram-remote',
	factory(require) {
		var module = { exports: {} }
		var exports = module.exports
		const React = require('react')
		const h = React.createElement

		const NS = 'telegramRemote'
		const CONFIG_PATH = '/plugins/telegram-remote/config'
		const LOGS_PATH = '/plugins/telegram-remote/logs'

		const NAV_ICON_MARKER = 'data-telegram-remote-nav-icon'
		const NAV_ROW_SELECTOR = '[role="dialog"] nav button'
		const NAV_ICON_URL =
			'data:image/svg+xml,' +
			encodeURIComponent(
				'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#000"><g transform="translate(12 12) scale(0.4668) translate(-25.15 -37.9)"><path d="M43.8 20.8 C44.8 20.3 45.8 21.1 45.5 22.2 L39.8 51.9 C39.4 54.1 37.8 54.8 35.9 53.7 L24.1 46.4 C22.6 45.5 22.5 44.2 23.8 43.1 L37.9 29.4 C38.7 28.7 37.8 28.4 37.0 29.0 L16.8 41.7 C15.5 42.5 14.2 42.7 12.7 42.2 L6.6 40.2 C4.8 39.6 4.8 38.4 6.8 37.5 Z"/><circle cx="18" cy="50" r="5.5" fill-opacity="0.5"/></g></svg>',
			)

		/** Swap the section row's default gear for a paper plane with a dot. */
		function installNavIcon(ctx, resolveLabel) {
			if (typeof document === 'undefined') return
			ctx.effect(() => {
				const style = document.createElement('style')
				style.dataset.plugin = 'telegram-remote'
				style.dataset.pluginCss = 'telegram-remote/settings-nav-icon'
				style.textContent = [
					`[${NAV_ICON_MARKER}] > svg { display: none; }`,
					`[${NAV_ICON_MARKER}]::before {`,
					`  content: '';`,
					`  flex: none;`,
					`  width: 16px;`,
					`  height: 16px;`,
					`  background-color: currentColor;`,
					`  -webkit-mask-image: url("${NAV_ICON_URL}");`,
					`  mask-image: url("${NAV_ICON_URL}");`,
					`  -webkit-mask-repeat: no-repeat;`,
					`  mask-repeat: no-repeat;`,
					`  -webkit-mask-position: center;`,
					`  mask-position: center;`,
					`  -webkit-mask-size: 16px 16px;`,
					`  mask-size: 16px 16px;`,
					`}`,
				].join('\n')
				document.head.appendChild(style)
				let disposed = false
				let scheduled = false
				const sync = () => {
					scheduled = false
					if (disposed) return
					const wanted = String(resolveLabel() ?? '').trim()
					if (!wanted) return
					for (const row of document.querySelectorAll(NAV_ROW_SELECTOR)) {
						if (row.textContent.trim() === wanted) row.setAttribute(NAV_ICON_MARKER, '')
						else row.removeAttribute(NAV_ICON_MARKER)
					}
				}
				const schedule = () => {
					if (scheduled || disposed) return
					scheduled = true
					queueMicrotask(sync)
				}
				sync()
				const observer = new MutationObserver(schedule)
				observer.observe(document.body, { childList: true, subtree: true, characterData: true })
				return () => {
					disposed = true
					observer.disconnect()
					for (const row of document.querySelectorAll(`[${NAV_ICON_MARKER}]`)) {
						row.removeAttribute(NAV_ICON_MARKER)
					}
					style.remove()
				}
			}, 'telegram-remote: settings nav icon')
		}

		const zh = {
			nav: 'Telegram 遥控',
			title: 'Telegram 遥控',
			desc: '在 Telegram 里操作本机 Harness：列会话、切模型、直接对话。填好 bot token 和允许的用户 ID，保存后启用。',
			token: 'Bot Token',
			tokenPlaceholder: '123456:ABC-DEF…',
			tokenSaved: '已保存 {token}，留空保持不变',
			allowed: '允许的用户 ID',
			allowedPlaceholder: '例如 123456789, 987654321',
			allowedHint: '必填，留空不启用。填自己的数字 ID，多个用逗号分隔。',
			proxy: '代理地址',
			proxyPlaceholder: 'http://127.0.0.1:7890',
			proxyHint: 'api.telegram.org 直连不通时需要；留空表示直连。',
			timeout: '长轮询秒数',
			save: '保存并启用',
			saving: '保存中…',
			saved: '已保存，已按新配置重新启用',
			failed: '保存失败：{error}',
			status: '当前状态',
			connected: '已连接 {bot}',
			starting: '已启用，正在连接…',
			disconnected: '未启用',
			needToken: '未启用：还没有 bot token',
			needAllowed: '未启用：还没有允许的用户 ID',
			broken: '启用失败：{error}',
			loading: '正在读取配置…',
			loadFailed: '读取配置失败：{error}',
			retry: '重试',
			hint: 'Token 在 @BotFather 创建 bot 后拿到；自己的数字 ID 发给 @userinfobot 就能查到。',
			badRequest: '请求失败',
			logTitle: '日志',
			logHint: '只显示本插件的日志，保留最近 200 条。',
			logEmpty: '暂无日志。',
			logClear: '清空',
			logFailed: '日志读取失败：{error}',
		}

		const en = {
			nav: 'Telegram Remote',
			title: 'Telegram Remote',
			desc: 'Drive this Harness from Telegram: list sessions, switch models, chat from your phone. Fill in a bot token and at least one allowed user ID, then save to enable.',
			token: 'Bot token',
			tokenPlaceholder: '123456:ABC-DEF…',
			tokenSaved: 'Saved {token}; leave empty to keep it',
			allowed: 'Allowed user IDs',
			allowedPlaceholder: 'e.g. 123456789, 987654321',
			allowedHint: 'Required; the bot stays off while this is empty. Comma-separated numeric ids.',
			proxy: 'Proxy',
			proxyPlaceholder: 'http://127.0.0.1:7890',
			proxyHint: 'Needed when api.telegram.org is unreachable directly; empty means direct.',
			timeout: 'Long-poll seconds',
			save: 'Save and enable',
			saving: 'Saving…',
			saved: 'Saved; enabled with the new config',
			failed: 'Save failed: {error}',
			status: 'Status',
			connected: 'Connected as {bot}',
			starting: 'Enabled, connecting…',
			disconnected: 'Off',
			needToken: 'Off: no bot token yet',
			needAllowed: 'Off: no allowed user id yet',
			broken: 'Failed to enable: {error}',
			loading: 'Loading config…',
			loadFailed: 'Cannot load config: {error}',
			retry: 'Retry',
			hint: 'Create a bot with @BotFather to get a token; send a message to @userinfobot to read your numeric id.',
			badRequest: 'Request failed',
			logTitle: 'Logs',
			logHint: 'This plugin only; the latest 200 lines are kept.',
			logEmpty: 'No logs yet.',
			logClear: 'Clear',
			logFailed: 'Cannot load logs: {error}',
		}

		const CSS = `
.tg-remote-root { display: flex; flex-direction: column; gap: 18px; max-width: 680px; }
.tg-remote-header { display: flex; flex-direction: column; gap: 6px; }
.tg-remote-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.tg-remote-desc { font-size: 13px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.tg-remote-card { display: flex; flex-direction: column; gap: 16px; padding: 16px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
.tg-remote-field { display: flex; flex-direction: column; gap: 6px; }
.tg-remote-label { font-size: 13px; color: var(--dsw-alias-label-primary); }
.tg-remote-hint { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.tg-remote-input { height: 34px; padding: 0 10px; font-size: 13px; font-family: inherit; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; }
.tg-remote-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.tg-remote-row { display: flex; align-items: center; gap: 12px; }
.tg-remote-status { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--dsw-alias-label-secondary); }
.tg-remote-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); }
.tg-remote-dot.is-on { background: var(--dsw-alias-state-success-primary); }
.tg-remote-dot.is-err { background: var(--dsw-alias-state-error-primary); }
.tg-remote-button { height: 34px; padding: 0 16px; font-size: 13px; font-family: inherit; color: var(--dsw-alias-label-primary-foreground, #fff); background: var(--dsw-alias-brand-primary); border: none; border-radius: 8px; cursor: pointer; }
.tg-remote-button:hover:not(:disabled) { background-image: linear-gradient(var(--dsw-alias-interactive-bg-hover, transparent), var(--dsw-alias-interactive-bg-hover, transparent)); }
.tg-remote-button:disabled { opacity: 0.6; cursor: default; }
.tg-remote-notice { font-size: 13px; line-height: 1.5; }
.tg-remote-notice.is-ok { color: var(--dsw-alias-state-success-primary); }
.tg-remote-notice.is-err { color: var(--dsw-alias-state-error-primary); }
.tg-remote-logs { gap: 10px; }
.tg-remote-logs-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.tg-remote-logbox { max-height: 260px; min-height: 90px; overflow: auto; padding: 10px 12px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; }
.tg-remote-logline { display: block; white-space: pre-wrap; overflow-wrap: anywhere; }
.tg-remote-logline.is-warn { color: var(--dsw-alias-state-warning-primary, #b26b00); }
.tg-remote-logline.is-error { color: var(--dsw-alias-state-error-primary); }
.tg-remote-logtime { opacity: 0.7; margin-right: 8px; }
.tg-remote-button.is-ghost { color: var(--dsw-alias-label-primary); background: transparent; border: 1px solid var(--dsw-alias-border-l1); }
.tg-remote-button.is-ghost:hover:not(:disabled) { background-color: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.05)); background-image: none; }
`

		function call(payload) {
			const init =
				payload === undefined
					? { credentials: 'same-origin' }
					: {
							method: 'POST',
							credentials: 'same-origin',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify(payload),
						}
			return fetch(CONFIG_PATH, init)
				.then((response) =>
					response
						.json()
						.catch(() => ({ ok: false, error: `HTTP ${response.status}` })),
				)
				.catch((error) => ({ ok: false, error: String(error?.message ?? error) }))
		}

		function Field(props) {
			return h(
				'div',
				{ className: 'tg-remote-field' },
				h('label', { className: 'tg-remote-label', htmlFor: props.id }, props.label),
				h('input', {
					id: props.id,
					className: 'tg-remote-input',
					type: props.type ?? 'text',
					value: props.value,
					placeholder: props.placeholder,
					autoComplete: 'off',
					spellCheck: false,
					onChange: (event) => props.onChange(event.target.value),
				}),
				props.hint ? h('span', { className: 'tg-remote-hint' }, props.hint) : null,
			)
		}

		function Section(props) {
			const t = props.t ?? ((key) => key)
			const [view, setView] = React.useState({ kind: 'loading' })
			const [data, setData] = React.useState(null)
			const [form, setForm] = React.useState({ token: '', allowed: '', proxy: '', timeout: '30' })
			const [saving, setSaving] = React.useState(false)
			const [notice, setNotice] = React.useState(null)
			const [logs, setLogs] = React.useState([])
			const [logError, setLogError] = React.useState(null)
			const logSeq = React.useRef(0)
			const logBox = React.useRef(null)
			const stickToTop = React.useRef(true)

			const adopt = React.useCallback((payload) => {
				setData(payload)
				setForm({
					token: '',
					allowed: (payload.config.allowedUserIds ?? []).join(', '),
					proxy: payload.config.proxy ?? '',
					timeout: String(payload.config.pollTimeoutSec ?? 30),
				})
			}, [])

			const load = React.useCallback(() => {
				setView({ kind: 'loading' })
				void call().then((payload) => {
					if (payload?.ok) {
						adopt(payload)
						setView({ kind: 'ready' })
					} else {
						setView({ kind: 'error', error: payload?.error ?? t('badRequest') })
					}
				})
			}, [adopt, t])

			React.useEffect(() => {
				load()
			}, [load])

			React.useEffect(() => {
				let stopped = false
				const poll = () => {
					fetch(`${LOGS_PATH}?after=${logSeq.current}`, { credentials: 'same-origin' })
						.then((response) =>
							response
								.json()
								.catch(() => ({ ok: false, error: `HTTP ${response.status}` })),
						)
						.catch((error) => ({ ok: false, error: String(error?.message ?? error) }))
						.then((payload) => {
							if (stopped) return
							if (!payload?.ok) {
								setLogError(payload?.error ?? t('badRequest'))
								return
							}
							setLogError(null)
							logSeq.current = payload.seq ?? logSeq.current
							if (Array.isArray(payload.entries) && payload.entries.length > 0) {
								setLogs((current) => {
									const last = current.length > 0 ? current[current.length - 1].seq : 0
									const fresh = payload.entries.filter((entry) => entry.seq > last)
									if (fresh.length === 0) return current
									return [...current, ...fresh].slice(-400)
								})
							}
						})
				}
				poll()
				const timer = setInterval(poll, 1500)
				return () => {
					stopped = true
					clearInterval(timer)
				}
			}, [t])

			React.useEffect(() => {
				const box = logBox.current
				if (box && stickToTop.current) box.scrollTop = 0
			}, [logs])

			const clearLogs = () => {
				setLogs([])
			}

			const submit = (event) => {
				event.preventDefault()
				setSaving(true)
				setNotice(null)
				void call({
					token: form.token,
					allowedUserIds: form.allowed,
					proxy: form.proxy,
					pollTimeoutSec: Number(form.timeout),
				}).then((payload) => {
					setSaving(false)
					if (payload?.ok) {
						adopt(payload)
						setNotice({ kind: 'ok', text: t('saved') })
					} else {
						setNotice({ kind: 'err', text: t('failed', { error: payload?.error ?? t('badRequest') }) })
					}
				})
			}

			if (view.kind === 'loading') {
				return h('div', { className: 'tg-remote-root' }, h('p', { className: 'tg-remote-hint' }, t('loading')))
			}

			if (view.kind === 'error') {
				return h(
					'div',
					{ className: 'tg-remote-root' },
					h('p', { className: 'tg-remote-notice is-err' }, t('loadFailed', { error: view.error })),
					h(
						'div',
						{ className: 'tg-remote-row' },
						h('button', { className: 'tg-remote-button', type: 'button', onClick: load }, t('retry')),
					),
				)
			}

			const status = data?.status ?? {}
			const running = status.running === true
			const bot = status.bot
			const failure = status.error
			const dotClass = running && bot ? 'tg-remote-dot is-on' : running && failure ? 'tg-remote-dot is-err' : 'tg-remote-dot'
			const statusText = running
				? bot
					? t('connected', { bot })
					: failure
						? t('broken', { error: failure })
						: t('starting')
				: failure === 'missing bot token'
					? t('needToken')
					: failure === 'missing allowed user ids'
						? t('needAllowed')
						: t('disconnected')

			const tokenPlaceholder = data?.config.hasToken
				? t('tokenSaved', { token: data.config.token })
				: t('tokenPlaceholder')

			return h(
				'div',
				{ className: 'tg-remote-root' },
				h(
					'div',
					{ className: 'tg-remote-header' },
					h('div', { className: 'tg-remote-title' }, t('title')),
					h('div', { className: 'tg-remote-desc' }, t('desc')),
				),
				h(
					'div',
					{ className: 'tg-remote-status' },
					h('span', { className: dotClass }),
					h('span', null, `${t('status')}：${statusText}`),
				),
				h(
					'form',
					{ className: 'tg-remote-card', onSubmit: submit },
					h(Field, {
						id: 'tg-remote-token',
						label: t('token'),
						type: 'password',
						value: form.token,
						placeholder: tokenPlaceholder,
						onChange: (value) => setForm({ ...form, token: value }),
						hint: t('hint'),
					}),
					h(Field, {
						id: 'tg-remote-allowed',
						label: t('allowed'),
						value: form.allowed,
						placeholder: t('allowedPlaceholder'),
						onChange: (value) => setForm({ ...form, allowed: value }),
						hint: t('allowedHint'),
					}),
					h(Field, {
						id: 'tg-remote-proxy',
						label: t('proxy'),
						value: form.proxy,
						placeholder: t('proxyPlaceholder'),
						onChange: (value) => setForm({ ...form, proxy: value }),
						hint: t('proxyHint'),
					}),
					h(Field, {
						id: 'tg-remote-timeout',
						label: t('timeout'),
						type: 'number',
						value: form.timeout,
						placeholder: '30',
						onChange: (value) => setForm({ ...form, timeout: value }),
					}),
					h(
						'div',
						{ className: 'tg-remote-row' },
						h('button', { className: 'tg-remote-button', type: 'submit', disabled: saving }, saving ? t('saving') : t('save')),
					),
					notice ? h('div', { className: `tg-remote-notice is-${notice.kind}` }, notice.text) : null,
				),
				h(
					'div',
					{ className: 'tg-remote-card tg-remote-logs' },
					h(
						'div',
						{ className: 'tg-remote-logs-head' },
						h(
							'div',
							null,
							h('div', { className: 'tg-remote-label' }, t('logTitle')),
							h(
								'div',
								{ className: 'tg-remote-hint' },
								logError ? t('logFailed', { error: logError }) : t('logHint'),
							),
						),
						logs.length > 0
							? h(
									'button',
									{ className: 'tg-remote-button is-ghost', type: 'button', onClick: clearLogs },
									t('logClear'),
								)
							: null,
					),
					h(
						'div',
						{
							className: 'tg-remote-logbox',
							ref: logBox,
							onScroll: (event) => {
								stickToTop.current = event.currentTarget.scrollTop < 24
							},
						},
						logs.length === 0
							? h('div', { className: 'tg-remote-logline' }, t('logEmpty'))
							: logs
									.slice()
									.reverse()
									.map((entry) =>
										h(
											'span',
											{ key: entry.seq, className: `tg-remote-logline is-${entry.level}` },
											h('span', { className: 'tg-remote-logtime' }, new Date(entry.at).toLocaleTimeString()),
											entry.message,
										),
									),
					),
				),
			)
		}

		exports.inject = ['slots', 'locale']

		exports.apply = function (ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'telegram-remote: dictionaries')

			ctx.effect(() => {
				const style = document.createElement('style')
				style.dataset.plugin = 'telegram-remote'
				style.textContent = CSS
				document.head.appendChild(style)
				return () => {
					style.remove()
				}
			}, 'telegram-remote: styles')

			const t = ctx.locale.bind(NS)
			installNavIcon(ctx, () => t('nav'))

			ctx.slots.inject('settings.section', () =>
				ctx.slots.register(
					{
						name: 'settings.section',
						id: 'telegram-remote',
						order: 40,
						label: () => t('nav'),
						locale: NS,
					},
					(slotProps) => h(Section, { ...slotProps, t: slotProps.t ?? t }),
				),
			)
		}

		return module.exports
	},
})
