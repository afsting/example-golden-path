#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ResumeSiteStack } from '../lib/resume-site-stack';

const app = new cdk.App();

/**
 * Required for a real synth/diff/deploy — the OTP access gate must not
 * silently fall back to the stack's placeholder defaults outside of
 * direct-instantiation test contexts (e.g. the jest suite, which
 * constructs ResumeSiteStack with no props at all). Fail fast instead.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. Set it before running ` +
        'cdk synth/diff/deploy (see task.md — Email OTP access gate).',
    );
  }
  return value;
}

// Stack name and all of the overrides below default to this stack's actual
// deployed identity/domain/role-name values (see ResumeSiteStackProps) — set
// STACK_NAME (and the others) only to deploy a second, independent copy of
// this stack into the same AWS account, e.g. to time-test the "Use this
// template" golden-path claim without touching the original deployment.
new ResumeSiteStack(app, process.env.STACK_NAME || 'ResumeSiteStack', {
  /**
   * To target a specific AWS account and region, uncomment the env block below
   * and set values via CDK context, environment variables, or parameter store.
   * Do not hard-code account IDs or credentials here.
   *
   * env: {
   *   account: process.env.CDK_DEFAULT_ACCOUNT,
   *   region: process.env.CDK_DEFAULT_REGION,
   * },
   */
  description: 'Raymond Page résumé site: S3 + CloudFront (OAC)',
  otpAdminEmail: requireEnv('OTP_ADMIN_EMAIL'),
  otpHmacSecret: requireEnv('OTP_HMAC_SECRET'),
  resendApiKey: requireEnv('RESEND_API_KEY'),
  siteDomainName: process.env.SITE_DOMAIN_NAME,
  hostedZoneName: process.env.HOSTED_ZONE_NAME,
  hostedZoneId: process.env.HOSTED_ZONE_ID,
  githubOidcProviderArn: process.env.GITHUB_OIDC_PROVIDER_ARN,
  githubRoleNamePrefix: process.env.GITHUB_ROLE_NAME_PREFIX,
  githubOwner: process.env.GITHUB_REPO_OWNER,
  githubRepoName: process.env.GITHUB_REPO_NAME,
});
