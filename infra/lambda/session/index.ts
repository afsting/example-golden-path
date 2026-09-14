import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { verifySession } from '../common/session';
import { getHmacSecret } from '../common/kvsSecret';
import { getSessionToken, jsonResponse } from '../common/http';

const SESSION_COOKIE_CLEAR = 'session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const method = event.requestContext.http.method;

  if (method === 'POST') {
    // Logout unconditionally clears the cookie, even if it was already
    // missing/invalid — there's no meaningful failure mode here.
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: JSON.stringify({ message: 'Logged out.' }),
      cookies: [SESSION_COOKIE_CLEAR],
    };
  }

  const token = getSessionToken(event);
  if (!token) return jsonResponse(200, { authenticated: false });

  const hmacSecret = await getHmacSecret();
  const session = verifySession(token, hmacSecret);
  if (!session) return jsonResponse(200, { authenticated: false });

  return jsonResponse(200, { authenticated: true, email: session.email, admin: session.admin });
}
