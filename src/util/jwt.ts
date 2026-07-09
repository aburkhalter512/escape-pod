// Unverified decode only — we don't have PTP's JWT_SECRET and shouldn't try
// to obtain it. This is for the anti-mistake discord_id check and display
// purposes only (INTEGRATIONS.md §8.2b). Real trust comes from the token
// actually working against PTP's live API (§8.2d), which the backend checks.
export interface UnverifiedPtpTokenPayload {
  id: string
  discord_id?: string
  username: string
  exp: number
  [key: string]: unknown
}

export function decodeJwtPayloadUnverified(token: string): UnverifiedPtpTokenPayload | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null

  try {
    const payloadSegment = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = payloadSegment.padEnd(
      payloadSegment.length + ((4 - (payloadSegment.length % 4)) % 4),
      '='
    )
    const json = Buffer.from(padded, 'base64').toString('utf8')
    return JSON.parse(json) as UnverifiedPtpTokenPayload
  } catch {
    return null
  }
}
