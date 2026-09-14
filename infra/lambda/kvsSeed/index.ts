import type { CloudFormationCustomResourceEvent } from 'aws-lambda';
// CloudFront KeyValueStore requests are signed with SigV4A (multi-region).
// The AWS SDK v3 does not ship a SigV4A implementation by default — it must
// be registered explicitly via this side-effect import (there's no native
// CRT binary available in the Lambda runtime, so the pure-JS package is
// used instead of @aws-sdk/signature-v4-crt).
import '@aws-sdk/signature-v4a';
import {
  CloudFrontKeyValueStoreClient,
  DescribeKeyValueStoreCommand,
  PutKeyCommand,
} from '@aws-sdk/client-cloudfront-keyvaluestore';

const client = new CloudFrontKeyValueStoreClient({});

interface ResourceProperties {
  kvsArn: string;
  secretValue: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Custom resource that seeds the CloudFront KeyValueStore with the HMAC
 * signing secret used to sign/verify session cookies. Runs on Create and
 * Update (re-asserting the same value is a harmless no-op, and repeats if
 * the secret is intentionally rotated).
 *
 * KVS writes require the current ETag (optimistic concurrency), and a
 * freshly-created store can take a few seconds to become ready — so this
 * polls DescribeKeyValueStore briefly before writing.
 */
export async function handler(event: CloudFormationCustomResourceEvent): Promise<{ PhysicalResourceId: string }> {
  const { kvsArn, secretValue } = event.ResourceProperties as unknown as ResourceProperties;
  const physicalResourceId = `${kvsArn}/hmacSecret`;

  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: physicalResourceId };
  }

  let etag: string | undefined;
  for (let attempt = 0; attempt < 10; attempt++) {
    const describe = await client.send(new DescribeKeyValueStoreCommand({ KvsARN: kvsArn }));
    if (describe.Status === 'READY' && describe.ETag) {
      etag = describe.ETag;
      break;
    }
    await sleep(3000);
  }

  if (!etag) {
    throw new Error(`KeyValueStore ${kvsArn} did not become READY in time`);
  }

  await client.send(new PutKeyCommand({
    KvsARN: kvsArn,
    Key: 'hmacSecret',
    Value: secretValue,
    IfMatch: etag,
  }));

  return { PhysicalResourceId: physicalResourceId };
}
