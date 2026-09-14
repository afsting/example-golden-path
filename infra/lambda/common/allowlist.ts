import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './dynamo';

export interface AllowlistCheckResult {
  allowed: boolean;
  admin: boolean;
}

/**
 * Checks whether an email is allowlisted, either as an exact match or via a
 * domain-suffix entry (e.g. `mutualofomaha.com` allows any
 * `*@mutualofomaha.com` address). Table layout:
 *   - Exact email entries: pk = "EMAIL", sk = lowercased email
 *   - Domain entries:      pk = "DOMAIN", sk = lowercased domain (no "@")
 */
export async function checkAllowlist(tableName: string, email: string): Promise<AllowlistCheckResult> {
  const exact = await ddb.send(new GetCommand({
    TableName: tableName,
    Key: { pk: 'EMAIL', sk: email },
  }));
  if (exact.Item) {
    return { allowed: true, admin: !!exact.Item.admin };
  }

  const domains = await ddb.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: 'pk = :p',
    ExpressionAttributeValues: { ':p': 'DOMAIN' },
  }));

  for (const item of domains.Items ?? []) {
    const domain = item.sk as string;
    if (email.endsWith(`@${domain}`)) {
      return { allowed: true, admin: !!item.admin };
    }
  }

  return { allowed: false, admin: false };
}
