import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

/** Reads the signed session cookie's value from an API Gateway v2 event. */
export function getSessionToken(event: APIGatewayProxyEventV2): string | undefined {
  for (const cookie of event.cookies ?? []) {
    const eq = cookie.indexOf('=');
    if (eq === -1) continue;
    if (cookie.slice(0, eq) === 'session') return cookie.slice(eq + 1);
  }
  return undefined;
}

export function forbidden(): APIGatewayProxyStructuredResultV2 {
  return jsonResponse(403, { message: 'Forbidden.' });
}

export function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(body),
  };
}
