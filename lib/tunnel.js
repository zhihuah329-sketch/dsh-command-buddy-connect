/**
 * Detect a network-layer tunnel that would make a system-proxy capture useless.
 *
 * ## The problem this exists for
 *
 * The capture works by pointing the Windows *system proxy* at a local port and
 * waiting for the client to send its token through it. That assumes the client
 * honours the system proxy.
 *
 * A TUN-mode proxy (Clash/Mihomo, sing-box, and similar) installs a virtual
 * network adapter and takes traffic at the IP layer, *below* the system proxy
 * setting. Applications that connect through the tunnel never consult the system
 * proxy at all, so every request bypasses the capture port. The session then
 * sits in `listening` until it times out, which reads to the user as "capture
 * doesn't work" with no explanation.
 *
 * Observed in practice: WorkBuddy's connections went to `198.18.x.x`, the
 * fake-IP range Mihomo hands out, while the system proxy pointed at the capture
 * port. Nothing was wrong with the proxy or the certificates.
 *
 * ## What this module does about it
 *
 * Nothing is changed. It reports whether a tunnel is present so the session can
 * say so *before* the user restarts the client and waits ten minutes, and name
 * the two ways forward: turn the tunnel off for a minute, or skip the capture
 * and paste a token.
 *
 * @module dsh-command-buddy-connect/tunnel
 */

import { execFileSync } from 'node:child_process'

/** Adapter descriptions used by the common TUN implementations. */
const TUN_ADAPTER_HINTS = [
  'mihomo',
  'meta tunnel',
  'clash',
  'wintun',
  'tap-windows',
  'sing-box',
  'wireguard',
  'openvpn'
]

/** The fake-IP range Mihomo/Clash hand out when TUN is active. */
const FAKE_IP_PREFIX = '198.18.'

/**
 * Read the names and descriptions of adapters that are up.
 *
 * @returns an array of `{ name, description }`.
 */
function activeAdapters() {
  try {
    // Get-CimInstance rather than Get-NetAdapter: the latter is unavailable in
    // some constrained PowerShell hosts, and this only needs the names.
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_NetworkAdapter -Filter "NetEnabled=true" | ' +
        'ForEach-Object { "$($_.Name)|$($_.Description)" }'],
      { encoding: 'utf8', windowsHide: true, timeout: 12_000 }
    )
    return out.split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.includes('|'))
      .map((line) => {
        const [name, description] = line.split('|')
        return { name: name ?? '', description: description ?? '' }
      })
  } catch {
    return []
  }
}

/**
 * Whether any application is currently connected into a fake-IP range.
 *
 * This is corroboration, not the decision: the adapter is the reliable signal,
 * and the fake-IP check only adds confidence when a tunnel is present but its
 * adapter is named unusually.
 *
 * @returns whether a fake-IP destination is in use.
 */
function fakeIpInUse() {
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        'Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue | ' +
        `Where-Object { $_.RemoteAddress -like '${FAKE_IP_PREFIX}*' } | ` +
        'Select-Object -First 1 -ExpandProperty RemoteAddress'],
      { encoding: 'utf8', windowsHide: true, timeout: 12_000 }
    )
    return out.trim().length > 0
  } catch {
    return false
  }
}

/**
 * Report whether a network-layer tunnel will defeat a system-proxy capture.
 *
 * @returns `{ tunnel: boolean, adapter, fakeIp, advice }`.
 */
export function detectTunnel() {
  if (process.platform !== 'win32') {
    return { tunnel: false, adapter: null, fakeIp: false, advice: null }
  }
  const adapters = activeAdapters()
  const hit = adapters.find((a) => {
    const text = `${a.name} ${a.description}`.toLowerCase()
    return TUN_ADAPTER_HINTS.some((hint) => text.includes(hint))
  })
  const fakeIp = hit === undefined ? false : fakeIpInUse()
  if (hit === undefined) {
    return { tunnel: false, adapter: null, fakeIp: false, advice: null }
  }
  const label = hit.description.length > 0 ? hit.description : hit.name
  return {
    tunnel: true,
    adapter: label,
    fakeIp,
    advice:
      `检测到网络层代理（${label}）正在运行。它会在 IP 层接管流量，` +
      'WorkBuddy 不会走本插件设置的系统代理，所以抓不到凭据。' +
      '请先退出该代理（或关闭它的 TUN/虚拟网卡模式）再抓取，抓完再打开；' +
      '也可以跳过抓取，直接在本页用「刷新凭证」粘贴令牌。'
  }
}

/**
 * One short line for the session status, or null when nothing blocks capture.
 *
 * @returns a line to show the user, or null.
 */
export function tunnelWarning() {
  const found = detectTunnel()
  return found.tunnel ? found.advice : null
}
