import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { createHash, randomInt } from 'node:crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { ddb } from '../common/dynamo';
import { checkAllowlist } from '../common/allowlist';

const OTP_TABLE_NAME = process.env.OTP_TABLE_NAME!;
const ALLOWLIST_TABLE_NAME = process.env.ALLOWLIST_TABLE_NAME!;
const RESEND_API_KEY = process.env.RESEND_API_KEY!;
const RESEND_FROM_ADDRESS = process.env.RESEND_FROM_ADDRESS!;
const RESEND_REPLY_TO = process.env.RESEND_REPLY_TO!;
const OTP_TTL_SECONDS = 10 * 60;
// Anyone who knows an allowlisted address could otherwise trigger an
// unbounded stream of emails to it (and burn through the Resend quota);
// the stage-level throttle alone doesn't stop a slow drip.
const RESEND_COOLDOWN_SECONDS = 60;

// Anti-enumeration: always return the same response, whether or not the
// submitted email is actually allowlisted, so this endpoint can't be used
// to discover which addresses/domains are on the allowlist.
const GENERIC_RESPONSE: APIGatewayProxyStructuredResultV2 = {
  statusCode: 200,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify({ message: 'If that email is allowlisted, a verification code has been sent.' }),
};

function isValidEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  let email: string | undefined;
  try {
    const body = JSON.parse(event.body || '{}');
    email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : undefined;
  } catch {
    return { statusCode: 400, body: JSON.stringify({ message: 'Invalid request body.' }) };
  }

  if (!email || !isValidEmail(email)) {
    return { statusCode: 400, body: JSON.stringify({ message: 'A valid email address is required.' }) };
  }

  const { allowed } = await checkAllowlist(ALLOWLIST_TABLE_NAME, email);
  if (!allowed) {
    return GENERIC_RESPONSE;
  }

  const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
  const codeHash = createHash('sha256').update(code).digest('hex');
  const nowSeconds = Math.floor(Date.now() / 1000);

  try {
    await ddb.send(new PutCommand({
      TableName: OTP_TABLE_NAME,
      Item: {
        email,
        codeHash,
        attempts: 0,
        createdAt: nowSeconds,
        ttl: nowSeconds + OTP_TTL_SECONDS,
      },
      ConditionExpression: 'attribute_not_exists(email) OR createdAt < :cutoff',
      ExpressionAttributeValues: { ':cutoff': nowSeconds - RESEND_COOLDOWN_SECONDS },
    }));
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      // Still inside the cooldown from the previous code — the earlier
      // email is on its way. Same generic response, so this can't be
      // used to probe the allowlist either.
      return GENERIC_RESPONSE;
    }
    throw err;
  }

  try {
    // Resend's transactional email API — replaced SES here specifically
    // because SES sandbox mode requires every recipient to individually
    // verify their address before they can receive mail, while Resend only
    // requires the sending domain to be verified (already done for
    // send.pages-enterprise.com). See task.md for the full migration
    // rationale.
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: RESEND_FROM_ADDRESS,
        reply_to: RESEND_REPLY_TO,
        to: [email],
        subject: 'Your verification code',
        text: `Your verification code is ${code}. It expires in 10 minutes. If you didn't request this, you can ignore this email.`,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(`Resend API returned ${response.status}: ${errorBody}`);
    }
  } catch (err) {
    console.error('Failed to send verification code email', err);
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: JSON.stringify({ message: 'Something went wrong sending the verification code. Please try again shortly.' }),
    };
  }

  return GENERIC_RESPONSE;
}
