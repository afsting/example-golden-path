import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { createHash, timingSafeEqual } from 'node:crypto';
import { DeleteCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../common/dynamo';
import { checkAllowlist } from '../common/allowlist';
import { signSession } from '../common/session';
import { getHmacSecret } from '../common/kvsSecret';

const OTP_TABLE_NAME = process.env.OTP_TABLE_NAME!;
const ALLOWLIST_TABLE_NAME = process.env.ALLOWLIST_TABLE_NAME!;
const MAX_ATTEMPTS = 5;
const SESSION_TTL_SECONDS = 14 * 24 * 60 * 60; // 14 days, per task.md decision

function invalidCodeResponse(): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: 401,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify({ message: 'Invalid or expired code.' }),
  };
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  let email: string | undefined;
  let code: string | undefined;
  try {
    const body = JSON.parse(event.body || '{}');
    email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : undefined;
    code = typeof body.code === 'string' ? body.code.trim() : undefined;
  } catch {
    return { statusCode: 400, body: JSON.stringify({ message: 'Invalid request body.' }) };
  }

  if (!email || !code) {
    return { statusCode: 400, body: JSON.stringify({ message: 'Email and code are required.' }) };
  }

  const record = await ddb.send(new GetCommand({ TableName: OTP_TABLE_NAME, Key: { email } }));
  const item = record.Item;
  // Check expiry here rather than trusting DynamoDB TTL, which only
  // guarantees deletion within ~48 hours of the ttl timestamp.
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!item || item.attempts >= MAX_ATTEMPTS || typeof item.ttl !== 'number' || item.ttl < nowSeconds) {
    return invalidCodeResponse();
  }

  const suppliedHash = createHash('sha256').update(code).digest();
  const storedHash = Buffer.from(item.codeHash as string, 'hex');
  const match = suppliedHash.length === storedHash.length && timingSafeEqual(suppliedHash, storedHash);

  if (!match) {
    await ddb.send(new UpdateCommand({
      TableName: OTP_TABLE_NAME,
      Key: { email },
      UpdateExpression: 'SET attempts = attempts + :one',
      ExpressionAttributeValues: { ':one': 1 },
    }));
    return invalidCodeResponse();
  }

  // One-time use: remove the code as soon as it's successfully verified.
  await ddb.send(new DeleteCommand({ TableName: OTP_TABLE_NAME, Key: { email } }));

  // Re-check the allowlist rather than trusting the OTP record alone, in
  // case the entry was removed via the admin UI between request and verify.
  const { allowed, admin } = await checkAllowlist(ALLOWLIST_TABLE_NAME, email);
  if (!allowed) {
    return invalidCodeResponse();
  }

  const hmacSecret = await getHmacSecret();
  const token = signSession({ email, admin, exp: nowSeconds + SESSION_TTL_SECONDS }, hmacSecret);

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify({ message: 'Verified.', admin }),
    cookies: [
      `session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`,
    ],
  };
}
