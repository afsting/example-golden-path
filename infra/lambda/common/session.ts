import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed session token format: `${base64url(JSON payload)}.${base64url(HMAC-SHA256 signature)}`
 *
 * The same format is verified by the CloudFront Function (session-check.js)
 * at the edge, using the same HMAC secret stored in the CloudFront
 * KeyValueStore. Keep the two implementations in sync if this changes.
 */
export interface SessionPayload {
  email: string;
  admin: boolean;
  /** Expiry, in epoch seconds. */
  exp: number;
}

export function signSession(payload: SessionPayload, hmacSecretHex: string): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const key = Buffer.from(hmacSecretHex, 'hex');
  const signature = createHmac('sha256', key).update(payloadB64).digest('base64url');
  return `${payloadB64}.${signature}`;
}

export function verifySession(token: string, hmacSecretHex: string): SessionPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, signature] = parts;

  const key = Buffer.from(hmacSecretHex, 'hex');
  const expectedSignature = createHmac('sha256', key).update(payloadB64).digest('base64url');

  const expectedBuf = Buffer.from(expectedSignature);
  const actualBuf = Buffer.from(signature);
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    return null;
  }

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (typeof payload?.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }

  return payload;
}
