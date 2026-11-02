/**
 * Minimal HTTPS client. No dependencies: a plain https.Agent is used when no
 * proxy is configured, otherwise a CONNECT tunnel is opened on the proxy and the
 * TLS socket is handed back to https.Agent via createConnection, so response
 * parsing (chunked, keep-alive, redirects) stays with Node.
 */
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'

const CONNECT_TIMEOUT_MS = 15000

function parseProxy(proxy) {
  const url = new URL(proxy)
  if (url.protocol !== 'http:') {
    throw new Error(`unsupported proxy protocol ${url.protocol} in ${proxy} (only http:// CONNECT proxies are supported)`)
  }
  return { host: url.hostname, port: Number(url.port || 80) }
}

class ConnectAgent extends https.Agent {
  constructor(proxy) {
    super({ keepAlive: false, maxSockets: 4 })
    this.proxy = parseProxy(proxy)
  }

  createConnection(options, callback) {
    const targetHost = options.servername || options.host
    const targetPort = options.port || 443
    const authority = `${targetHost}:${targetPort}`
    const proxy = this.proxy
    let settled = false

    const finish = (err, socket) => {
      if (settled) {
        socket?.destroy()
        return
      }
      settled = true
      callback(err, socket)
    }

    const tunnel = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: authority,
      headers: { host: authority },
      agent: false,
    })

    tunnel.setTimeout(CONNECT_TIMEOUT_MS, () => {
      tunnel.destroy(new Error(`proxy CONNECT ${authority} timed out after ${CONNECT_TIMEOUT_MS}ms (proxy ${proxy.host}:${proxy.port})`))
    })

    tunnel.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        finish(new Error(`proxy CONNECT ${authority} failed: HTTP ${res.statusCode} (proxy ${proxy.host}:${proxy.port})`))
        return
      }
      const secure = tls.connect({ socket, servername: targetHost, ALPNProtocols: ['http/1.1'] })
      const onError = (err) => finish(err)
      secure.once('error', onError)
      secure.once('secureConnect', () => {
        secure.off('error', onError)
        finish(null, secure)
      })
    })

    tunnel.once('error', (err) => finish(err))
    tunnel.end()
  }
}

const agents = new Map()

function agentFor(proxy) {
  const key = proxy || 'direct'
  let agent = agents.get(key)
  if (!agent) {
    agent = proxy ? new ConnectAgent(proxy) : new https.Agent({ keepAlive: false })
    agents.set(key, agent)
  }
  return agent
}

/** Keep the bot token out of error messages and logs. */
const redact = (url) => url.replace(/\/bot[^/]+\//, '/bot<token>/')

/**
 * @param {string} url absolute https URL
 * @returns {Promise<{ status: number, headers: Record<string, string>, body: string }>}
 */
export function request(url, { method = 'GET', headers = {}, body = null, timeoutMs = 60000, proxy = '', signal } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers, agent: agentFor(proxy), signal }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('error', reject)
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
      })
    })

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`request timed out after ${timeoutMs}ms: ${method} ${redact(url)}`))
    })
    req.once('error', reject)
    if (body) req.write(body)
    req.end()
  })
}
