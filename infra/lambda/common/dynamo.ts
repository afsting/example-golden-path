import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/** Shared DynamoDB Document client, reused across warm Lambda invocations. */
export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
