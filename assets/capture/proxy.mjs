/**
 * Minimal scoped CONNECT-intercepting proxy.
 *
 * Only `copilot.tencent.com` and the workbuddy.cn hosts are terminated; every
 * other CONNECT is tunnelled untouched so unrelated traffic is unaffected.
 * Captured request headers go to captures.jsonl; nothing else is stored.
 */
import net from 'node:net'
import tls from 'node:tls'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.CAP_PORT ?? 18777)
// The host plugin supplies these paths so the capture file and log live beside
// the session that reads them, not inside the installed package.
const OUT = process.env.CAP_OUT ?? path.join(here, 'captures.jsonl')
const LOG = process.env.CAP_LOG ?? path.join(here, 'proxy.log')

const INTERCEPT = new Set([
  'copilot.tencent.com',
  'www.workbuddy.cn',
  'workbuddy.cn',
  'api.workbuddy.cn'
])

// Certificates are generated per machine at first use, so their directory is
// supplied by the host rather than assumed to sit beside this script.
const CERT_DIR = process.env.CAP_CERT_DIR ?? here
const key = fs.readFileSync(path.join(CERT_DIR, 'leaf.key'))
const cert = fs.readFileSync(path.join(CERT_DIR, 'leaf.crt'))

log(`scoped capture proxy listening on 127.0.0.1:${PORT}`)

const server = net.createServer((socket) => {
  let handled = false
  socket.once('data', (chunk) => {
    handled = true
    const text = chunk.toString('latin1')
    const m = /^CONNECT\s+([^\s:]+):(\d+)/i.exec(text)
    if (!m) {
      log(`non-CONNECT request, closing: ${text.split('\r\n')[0]}`)
      socket.destroy()
      return
    }
    const host = m[1].toLowerCase()
    const port = Number(m[2])

    if (!INTERCEPT.has(host)) {
      const upstream = net.connect(port, host, () => {
        upstream.write(chunk)
        socket.pipe(upstream)
        upstream.pipe(socket)
      })
      upstream.on('error', () => socket.destroy())
      socket.on('error', () => upstream.destroy())
      return
    }

    log(`intercepting CONNECT ${host}:${port}`)
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')

    const tlsSocket = new tls.TLSSocket(socket, {
      isServer: true,
      key,
      cert,
      ALPNProtocols: ['http/1.1']
    })

    tlsSocket.on('secure', () => log('TLS handshake done with client'))
    tlsSocket.on('error', (e) => {
      log(`client TLS error: ${e.code ?? ''} ${e.message}`)
      socket.destroy()
    })
    handleHttp(tlsSocket, host, port)
  })
  socket.on('error', (e) => log(`socket error: ${e.message}`))
})

function handleHttp(client, host, port) {
  let buffered = Buffer.alloc(0)

  function onData(chunk) {
    buffered = Buffer.concat([buffered, chunk])
    const idx = buffered.indexOf('\r\n\r\n')
    if (idx < 0) return
    client.off('data', onData)

    const head = buffered.subarray(0, idx).toString('latin1')
    const rest = buffered.subarray(idx + 4)
    const lines = head.split('\r\n')
    const [method, target] = lines[0].split(' ')
    const headers = {}
    for (const line of lines.slice(1)) {
      const i = line.indexOf(':')
      if (i > 0) headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim()
    }

    const interesting = {}
    for (const k of ['authorization', 'x-access-token', 'x-user-id', 'cookie', 'x-domain', 'x-product']) {
      if (headers[k]) interesting[k] = headers[k]
    }
    if (Object.keys(interesting).length > 0) {
      fs.appendFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), host, method, target, headers: interesting }) + '\n')
      log(`CAPTURED ${method} ${host}${target} -> ${Object.keys(interesting).join(',')}`)
    } else {
      log(`no credential headers on ${method} ${host}${target}`)
    }

    // Forward request (head + any body bytes already read).
    const upstream = tls.connect({ host, port, servername: host }, () => {
      upstream.write(head + '\r\n\r\n')
      if (rest.length) upstream.write(rest)
      upstream.pipe(client)
      client.pipe(upstream)
    })
    upstream.on('error', (e) => {
      log(`upstream error: ${e.code ?? ''} ${e.message}`)
      client.destroy()
    })
  }

  client.on('data', onData)
}

function log(msg) {
  try {
    fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {}
}

server.on('error', (e) => log(`server error: ${e.message}`))
server.listen(PORT, '127.0.0.1')
