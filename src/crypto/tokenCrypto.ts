import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// AES-256-GCM encryption at rest for Niamos bot tokens (a guild's linked
// draft-creation credential — see services/niamosTokens.ts) — required v1
// scope, not a later hardening pass. Originally written for PTP's tokens
// (INTEGRATIONS.md §8.5); reused unchanged for Niamos's, since it's a
// generic string-in/ciphertext-out primitive with no PTP-specific
// assumptions baked in.

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12

export function encryptToken(plaintext: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex')
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()

  return [iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(':')
}

export function decryptToken(ciphertext: string, keyHex: string): string {
  // Exactly 3 segments, not a truthiness check on each — an empty-string
  // plaintext legitimately encrypts to an empty third segment ("iv:tag:"),
  // which a `!encryptedHex` check would wrongly reject as malformed.
  const parts = ciphertext.split(':')
  if (parts.length !== 3 || !parts[0] || !parts[1]) {
    throw new Error('Malformed encrypted token')
  }
  const [ivHex, authTagHex, encryptedHex] = parts

  const key = Buffer.from(keyHex, 'hex')
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'))

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, 'hex')),
    decipher.final(),
  ])
  return decrypted.toString('utf8')
}
