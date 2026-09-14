import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DeleteCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../common/dynamo';
import { verifySession } from '../common/session';
import { getHmacSecret } from '../common/kvsSecret';
import { getSessionToken, forbidden } from '../common/http';

const ALLOWLIST_TABLE_NAME = process.env.ALLOWLIST_TABLE_NAME!;

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const token = getSessionToken(event);
  if (!token) return forbidden();

  // Admin authorization comes entirely from the signed session's `admin`
  // claim (set at verify-code time from the allowlist) — no extra DB
  // lookup needed to authorize each admin request.
  const hmacSecret = await getHmacSecret();
  const session = verifySession(token, hmacSecret);
  if (!session || !session.admin) return forbidden();

  const method = event.requestContext.http.method;
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };

  if (method === 'GET') {
    const [emails, domains] = await Promise.all([
      ddb.send(new QueryCommand({
        TableName: ALLOWLIST_TABLE_NAME,
        KeyConditionExpression: 'pk = :p',
        ExpressionAttributeValues: { ':p': 'EMAIL' },
      })),
      ddb.send(new QueryCommand({
        TableName: ALLOWLIST_TABLE_NAME,
        KeyConditionExpression: 'pk = :p',
        ExpressionAttributeValues: { ':p': 'DOMAIN' },
      })),
    ]);
    const entries = [...(emails.Items ?? []), ...(domains.Items ?? [])].map((item) => ({
      type: item.pk === 'EMAIL' ? 'email' : 'domain',
      value: item.sk,
      admin: !!item.admin,
    }));
    return { statusCode: 200, headers, body: JSON.stringify({ entries }) };
  }

  if (method === 'POST') {
    let type: unknown;
    let value: string | undefined;
    let isAdmin: boolean;
    try {
      const body = JSON.parse(event.body || '{}');
      type = body.type;
      value = typeof body.value === 'string' ? body.value.trim().toLowerCase() : undefined;
      isAdmin = !!body.admin;
    } catch {
      return { statusCode: 400, headers, body: JSON.stringify({ message: 'Invalid request body.' }) };
    }
    if ((type !== 'email' && type !== 'domain') || !value) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ message: 'type must be "email" or "domain", and value is required.' }),
      };
    }
    await ddb.send(new PutCommand({
      TableName: ALLOWLIST_TABLE_NAME,
      Item: {
        pk: type === 'email' ? 'EMAIL' : 'DOMAIN',
        sk: value,
        admin: isAdmin,
        createdAt: Math.floor(Date.now() / 1000),
      },
    }));
    return { statusCode: 201, headers, body: JSON.stringify({ message: 'Added.' }) };
  }

  if (method === 'DELETE') {
    const type = event.queryStringParameters?.type;
    const value = event.queryStringParameters?.value;
    if ((type !== 'email' && type !== 'domain') || !value) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ message: 'type and value query parameters are required.' }),
      };
    }
    await ddb.send(new DeleteCommand({
      TableName: ALLOWLIST_TABLE_NAME,
      Key: { pk: type === 'email' ? 'EMAIL' : 'DOMAIN', sk: value.toLowerCase() },
    }));
    return { statusCode: 200, headers, body: JSON.stringify({ message: 'Removed.' }) };
  }

  return { statusCode: 405, headers, body: JSON.stringify({ message: 'Method not allowed.' }) };
}
