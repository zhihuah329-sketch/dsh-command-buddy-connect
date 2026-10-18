/**
 * Generate a throwaway CA and a leaf certificate for the capture proxy.
 *
 * ## Why this is hand-written
 *
 * A capture needs a certificate that the system trusts for the WorkBuddy hosts.
 * Shipping one inside the package would mean publishing a CA private key, which
 * hands every reader the ability to sign certificates for those names. Using a
 * library instead would pull a dozen transitive packages into a plugin that
 * otherwise has no runtime dependencies at all.
 *
 * So the certificates are generated on the user's machine, at first use, and
 * never leave it. Node's crypto can produce the keys and sign with them; only
 * the X.509 envelope has to be encoded here, which is a few hundred bytes of
 * DER. The result is a CA valid for one day and a leaf for the exact hosts the
 * proxy intercepts — useless to anyone who is not this machine.
 *
 * @module buddy-connect/cert-gen
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/* ------------------------------------------------------------------ *
 * Minimal DER encoder
 * ------------------------------------------------------------------ */

/** Encode a length as DER. */
function derLength(length) {
  if (length < 0x80) return Buffer.from([length])
  const bytes = []
  let n = length
  while (n > 0) {
    bytes.unshift(n & 0xff)
    n >>= 8
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

/** Tag one DER value. */
function tlv(tag, content) {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content])
}

const seq = (...items) => tlv(0x30, Buffer.concat(items))
const set = (...items) => tlv(0x31, Buffer.concat(items))
const octetString = (buf) => tlv(0x04, buf)
const bitString = (buf) => tlv(0x03, Buffer.concat([Buffer.from([0]), buf]))
const utf8String = (str) => tlv(0x0c, Buffer.from(str, 'utf8'))
const bool = (value) => tlv(0x01, Buffer.from([value ? 0xff : 0x00]))

/**
 * Encode an integer.
 *
 * DER integers are signed, so a leading high bit needs a zero byte in front.
 */
function integer(buf) {
  let bytes = Buffer.from(buf)
  while (bytes.length > 1 && bytes[0] === 0 && (bytes[1] & 0x80) === 0) {
    bytes = bytes.subarray(1)
  }
  if ((bytes[0] & 0x80) !== 0) bytes = Buffer.concat([Buffer.from([0]), bytes])
  return tlv(0x02, bytes)
}

/** Encode an OID from its dotted string. */
function oid(dotted) {
  const parts = dotted.split('.').map(Number)
  const bytes = [parts[0] * 40 + parts[1]]
  for (const part of parts.slice(2)) {
    const stack = [part & 0x7f]
    let n = part >> 7
    while (n > 0) {
      stack.unshift((n & 0x7f) | 0x80)
      n >>= 7
    }
    bytes.push(...stack)
  }
  return tlv(0x06, Buffer.from(bytes))
}

/** Encode a UTC time (`YYMMDDHHMMSSZ`). */
function utcTime(date) {
  const s = date.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'
  return tlv(0x17, Buffer.from(s, 'ascii'))
}

/** A Distinguished Name with one RDN. */
const commonName = (name) => seq(set(seq(oid('2.5.4.3'), utf8String(name))))

/* ------------------------------------------------------------------ *
 * OIDs used below
 * ------------------------------------------------------------------ */
const OID = {
  sha256WithRSA: '1.2.840.113549.1.1.11',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  subjectAltName: '2.5.29.17',
  serverAuth: '1.3.6.1.5.5.7.3.1'
}

/** Wrap an extension value in the standard Extension SEQUENCE. */
function extension(id, critical, value) {
  return critical
    ? seq(oid(id), bool(true), octetString(value))
    : seq(oid(id), octetString(value))
}

/* ------------------------------------------------------------------ *
 * Certificate assembly
 * ------------------------------------------------------------------ */

/**
 * Build one certificate.
 *
 * @param params - subject, issuer, public key, signing key, serial, dates, extensions.
 * @returns a PEM string.
 */
function buildCertificate(params) {
  const tbs = seq(
    // v3 (2)
    tlv(0xa0, integer(Buffer.from([2]))),
    integer(params.serial),
    seq(oid(OID.sha256WithRSA)),
    params.issuer,
    seq(utcTime(params.notBefore), utcTime(params.notAfter)),
    params.subject,
    params.publicKey,
    tlv(0xa3, seq(...params.extensions))
  )
  const signature = crypto.sign('sha256', tbs, params.signingKey)
  const certificate = seq(tbs, seq(oid(OID.sha256WithRSA)), bitString(signature))
  return toPem('CERTIFICATE', certificate)
}

/** Wrap DER bytes in PEM. */
function toPem(label, der) {
  const body = der.toString('base64').replace(/(.{64})/g, '$1\n').trim()
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`
}

/** Export a key pair as PEM. */
function keyToPem(key, type) {
  return key.export({ type, format: 'pem' }).toString()
}

/**
 * Generate a CA and a leaf certificate for the given hosts.
 *
 * @param options - `hosts` (DNS names), `dir` (where to write), `days`.
 * @returns the written file paths.
 */
export function generateCaptureCertificates(options = {}) {
  const hosts = Array.isArray(options.hosts) && options.hosts.length > 0
    ? options.hosts
    : ['copilot.tencent.com', 'www.workbuddy.cn', 'workbuddy.cn', 'api.workbuddy.cn']
  const dir = options.dir
  const days = typeof options.days === 'number' ? options.days : 1

  fs.mkdirSync(dir, { recursive: true })

  const now = new Date()
  const notBefore = new Date(now.getTime() - 60 * 60 * 1000)
  const notAfter = new Date(now.getTime() + days * 24 * 60 * 60 * 1000)

  // CA
  const caKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const caName = commonName('Buddy Connect Capture CA')
  const caExtensions = [
    extension(OID.basicConstraints, true, seq(bool(true))),
    // keyCertSign | cRLSign
    extension(OID.keyUsage, true, bitString(Buffer.from([0x06])))
  ]
  const caPem = buildCertificate({
    subject: caName,
    issuer: caName,
    publicKey: exportPublicKey(caKeys.publicKey),
    signingKey: caKeys.privateKey,
    serial: crypto.randomBytes(8),
    notBefore,
    notAfter,
    extensions: caExtensions
  })

  // Leaf
  const leafKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const leafName = commonName(hosts[0])
  const altNames = hosts.map((h) => tlv(0x82, Buffer.from(h, 'ascii')))
  const leafExtensions = [
    extension(OID.basicConstraints, true, seq()),
    // digitalSignature | keyEncipherment
    extension(OID.keyUsage, true, bitString(Buffer.from([0xa0]))),
    extension(OID.extKeyUsage, false, seq(oid(OID.serverAuth))),
    extension(OID.subjectAltName, false, seq(...altNames))
  ]
  const leafPem = buildCertificate({
    subject: leafName,
    issuer: caName,
    publicKey: exportPublicKey(leafKeys.publicKey),
    signingKey: caKeys.privateKey,
    serial: crypto.randomBytes(8),
    notBefore,
    notAfter,
    extensions: leafExtensions
  })

  const paths = {
    caCert: path.join(dir, 'ca.crt'),
    caKey: path.join(dir, 'ca.key'),
    leafCert: path.join(dir, 'leaf.crt'),
    leafKey: path.join(dir, 'leaf.key')
  }
  fs.writeFileSync(paths.caCert, caPem, { mode: 0o600 })
  fs.writeFileSync(paths.caKey, keyToPem(caKeys.privateKey, 'pkcs1'), { mode: 0o600 })
  fs.writeFileSync(paths.leafCert, leafPem, { mode: 0o600 })
  fs.writeFileSync(paths.leafKey, keyToPem(leafKeys.privateKey, 'pkcs1'), { mode: 0o600 })
  return paths
}

/** Extract the SubjectPublicKeyInfo from a public key. */
function exportPublicKey(publicKey) {
  return publicKey.export({ type: 'spki', format: 'der' })
}
