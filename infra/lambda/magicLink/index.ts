import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomBytes } from 'node:crypto';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../common/dynamo';
import { checkAllowlist } from '../common/allowlist';
import { signSession, verifySession } from '../common/session';
import { getHmacSecret } from '../common/kvsSecret';
import { getSessionToken, forbidden, jsonResponse } from '../common/http';

const MAGIC_LINK_TABLE_NAME = process.env.MAGIC_LINK_TABLE_NAME!;
const ALLOWLIST_TABLE_NAME = process.env.ALLOWLIST_TABLE_NAME!;
const SITE_DOMAIN = process.env.SITE_DOMAIN!;
const LINK_TTL_SECONDS = 24 * 60 * 60; // 24h — an interviewer isn't waiting by their inbox
const SESSION_TTL_SECONDS = 14 * 24 * 60 * 60; // matches verifyCode's session length

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function htmlResponse(statusCode: number, body: string): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    body,
  };
}

const PAGE_STYLE = `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #1a1d23; background: #f7f8fa; min-height: 100vh;
      display: flex; align-items: center; justify-content: center; padding: 1.5rem;
    }
    main {
      width: 100%; max-width: 380px; background: #fff; border: 1px solid #e2e5ea;
      border-radius: 6px; box-shadow: 0 1px 4px rgba(0,0,0,0.07); padding: 2rem;
    }
    h1 { font-size: 1.25rem; margin-bottom: 0.5rem; }
    p { color: #5a6170; font-size: 0.9rem; margin-bottom: 1.5rem; }
    button {
      width: 100%; padding: 0.65rem 1rem; background: #1a4e8a; color: #fff;
      border: none; border-radius: 6px; font-size: 1rem; cursor: pointer;
    }
    button:hover { background: #153e6e; }
    a { color: #1a4e8a; }`;

function confirmPage(email: string, linkToken: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="robots" content="noindex, nofollow" />
<title>Sign in — Raymond Page</title>
<style>${PAGE_STYLE}</style></head><body>
<main>
  <h1>Sign in</h1>
  <p>Continue as <strong>${escapeHtml(email)}</strong>.</p>
  <form method="POST" action="/auth/consume-link">
    <input type="hidden" name="token" value="${escapeHtml(linkToken)}" />
    <button type="submit">Continue</button>
  </form>
</main>
</body></html>`;
}

function errorPage(message: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="robots" content="noindex, nofollow" />
<title>Sign in — Raymond Page</title>
<style>${PAGE_STYLE}</style></head><body>
<main>
  <h1>Link no longer valid</h1>
  <p>${escapeHtml(message)}</p>
  <p><a href="/login.html">Go to the normal sign-in page</a></p>
</main>
</body></html>`;
}

function parseFormBody(event: APIGatewayProxyEventV2): URLSearchParams {
  const raw = event.isBase64Encoded && event.body
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : (event.body ?? '');
  return new URLSearchParams(raw);
}

// Admin-issued fallback login path: an admin generates a short-lived,
// time-boxed link for a specific allowlisted email and shares it via a
// channel they already trust (Teams, an existing email thread, etc.),
// bypassing SES delivery entirely. In addition to, not instead of, the
// normal email-OTP flow — see task.md for why this exists (corporate spam
// filters can silently swallow OTP emails from an unfamiliar domain, with
// zero visibility on either end when that happens).
//
// The link is reusable for its whole TTL window rather than single-use:
// an earlier single-use version was burned by automated link-prefetching
// (see the GET-vs-POST split below) and, independently, made for a bad
// experience any time the same real click needed to happen twice — a
// browser back button, opening the email on a second device, a link
// preview in the email client. Once the TTL expires, both GET and POST
// treat it as gone.
//
// GET only *renders* a confirmation page and never establishes a session —
// corporate email security (Microsoft Safe Links, Proofpoint, Mimecast,
// etc.) automatically pre-fetches every link in an inbound email to scan
// it (confirmed live: a link emailed to a mutualofomaha.com address
// triggered this). Only an actual button click — a real form POST — logs
// the visitor in, since automated link scanners issue GET/HEAD requests
// and don't submit forms.
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const method = event.requestContext.http.method;
  const path = event.rawPath;

  if (method === 'POST' && path === '/auth/admin/magic-link') {
    const token = getSessionToken(event);
    if (!token) return forbidden();
    const hmacSecret = await getHmacSecret();
    const session = verifySession(token, hmacSecret);
    if (!session || !session.admin) return forbidden();

    let email: string | undefined;
    try {
      const body = JSON.parse(event.body || '{}');
      email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : undefined;
    } catch {
      return jsonResponse(400, { message: 'Invalid request body.' });
    }
    if (!email) return jsonResponse(400, { message: 'email is required.' });

    const { allowed, admin } = await checkAllowlist(ALLOWLIST_TABLE_NAME, email);
    if (!allowed) {
      return jsonResponse(400, { message: 'That email is not on the allowlist. Add it first.' });
    }

    const linkToken = randomBytes(32).toString('base64url');
    const nowSeconds = Math.floor(Date.now() / 1000);
    await ddb.send(new PutCommand({
      TableName: MAGIC_LINK_TABLE_NAME,
      Item: {
        token: linkToken,
        email,
        admin,
        createdAt: nowSeconds,
        ttl: nowSeconds + LINK_TTL_SECONDS,
      },
    }));

    return jsonResponse(201, {
      url: `https://${SITE_DOMAIN}/auth/consume-link?token=${linkToken}`,
      expiresInHours: LINK_TTL_SECONDS / 3600,
    });
  }

  if (method === 'GET' && path === '/auth/consume-link') {
    const linkToken = event.queryStringParameters?.token;
    if (!linkToken) return htmlResponse(400, errorPage('This link is missing its token.'));

    const record = await ddb.send(new GetCommand({ TableName: MAGIC_LINK_TABLE_NAME, Key: { token: linkToken } }));
    const item = record.Item;
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (!item || typeof item.ttl !== 'number' || item.ttl < nowSeconds) {
      return htmlResponse(410, errorPage('This link has expired. Ask the site owner for a new one.'));
    }

    return htmlResponse(200, confirmPage(item.email as string, linkToken));
  }

  if (method === 'POST' && path === '/auth/consume-link') {
    const form = parseFormBody(event);
    const linkToken = form.get('token');
    if (!linkToken) return htmlResponse(400, errorPage('This link is missing its token.'));

    const record = await ddb.send(new GetCommand({ TableName: MAGIC_LINK_TABLE_NAME, Key: { token: linkToken } }));
    const item = record.Item;

    // Deliberately not deleted here — reusable for the rest of its TTL
    // window, not single-use. DynamoDB TTL cleans it up once it expires.
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (!item || typeof item.ttl !== 'number' || item.ttl < nowSeconds) {
      return htmlResponse(410, errorPage('This link has expired. Ask the site owner for a new one.'));
    }

    const hmacSecret = await getHmacSecret();
    const sessionToken = signSession(
      { email: item.email as string, admin: !!item.admin, exp: nowSeconds + SESSION_TTL_SECONDS },
      hmacSecret,
    );

    return {
      statusCode: 302,
      headers: { location: `https://${SITE_DOMAIN}/`, 'cache-control': 'no-store' },
      cookies: [
        `session=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`,
      ],
    };
  }

  return jsonResponse(404, { message: 'Not found.' });
}
