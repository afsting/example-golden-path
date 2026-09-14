import * as path from 'path';
import * as crypto from 'crypto';
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

/**
 * ResumeSiteStack
 *
 * Provisions a private S3 bucket and a CloudFront distribution using
 * Origin Access Control (OAC) — the current AWS-recommended approach,
 * replacing the legacy Origin Access Identity (OAI).
 *
 * Architecture decisions documented in site/how-it-was-built.html.
 *
 * Custom domain: resume.pages-enterprise.com by default (overridable via
 * ResumeSiteStackProps — see siteDomainName/hostedZone* below), served
 * over the CloudFront distribution via an ACM certificate (DNS-validated)
 * and Route 53 alias A/AAAA records, both provisioned in this stack
 * against the pre-existing hosted zone.
 *
 * Deployable a second, independent time into the same AWS account — e.g.
 * to time-test the "Use this template" golden-path claim without
 * touching the original deployment — by overriding siteDomainName,
 * githubOidcProviderArn (import the existing provider; AWS allows only
 * one per issuer URL per account), and githubRoleNamePrefix so nothing
 * collides. A deploy with no props behaves exactly as it always has.
 */

export interface ResumeSiteStackProps extends cdk.StackProps {
  /**
   * Email seeded as the bootstrap admin for the OTP access gate's
   * /admin.html allowlist UI. Required for a real deploy — supplied by
   * bin/resume-site.ts from the OTP_ADMIN_EMAIL repo secret, which throws
   * if it's missing. Falls back to a non-functional placeholder only for
   * local/test synth (e.g. the jest suite constructs this stack directly
   * with no props).
   */
  readonly otpAdminEmail?: string;

  /**
   * Hex-encoded HMAC secret used to sign/verify OTP-gate session cookies,
   * shared between the CloudFront Function and the verify-code/admin
   * Lambdas via the CloudFront KeyValueStore. Must stay stable across
   * deploys — regenerating it invalidates every active session. Supplied
   * via the OTP_HMAC_SECRET repo secret; falls back to a random per-synth
   * value only for local/test synth.
   */
  readonly otpHmacSecret?: string;

  /**
   * Resend API key used to send OTP login-code email. Replaces SES for
   * this purpose (see task.md — Email provider: SES -> Resend migration)
   * since SES sandbox mode requires every recipient to individually
   * verify their address, while Resend only requires sending-domain
   * verification. Supplied via the RESEND_API_KEY repo secret; falls
   * back to a non-functional placeholder only for local/test synth.
   */
  readonly resendApiKey?: string;

  /**
   * Custom domain this stack serves, and the pre-existing public Route 53
   * hosted zone backing it. All three default to the values this stack
   * has always used (resume.pages-enterprise.com in the pages-enterprise.com
   * zone) — a deploy with no props behaves exactly as before. Override
   * when deploying a *second*, independent copy of this stack (e.g.
   * proving out the "Use this template" golden-path claim) so its Route 53
   * alias records target a different name instead of colliding with the
   * original site's.
   */
  readonly siteDomainName?: string;
  readonly hostedZoneName?: string;
  readonly hostedZoneId?: string;

  /**
   * ARN of an existing GitHub Actions OIDC provider (for
   * token.actions.githubusercontent.com) to import instead of creating a
   * new one. AWS allows only one OIDC provider per issuer URL per
   * account — a second stack deployed into an account that already has
   * one MUST import it via this prop, or `cdk deploy` fails outright
   * trying to create a duplicate. Leave unset for a stack's first deploy
   * into a given account (the common case, and this stack's own default).
   */
  readonly githubOidcProviderArn?: string;

  /**
   * Name prefix for the three GitHub Actions IAM roles this stack
   * creates (diff/deploy/metrics — see the "GitHub Actions OIDC" section
   * below). Defaults to 'github-actions-resume-site', this stack's actual
   * deployed role names. Override when deploying a second copy into the
   * same account so the role names don't collide with the original's.
   */
  readonly githubRoleNamePrefix?: string;

  /**
   * GitHub owner/org and repo name the IAM trust policies match against
   * (via a wildcarded `sub` claim — see the comment above
   * githubSubPullRequest). Defaults to this stack's actual repo,
   * afsting/developer-experience-concepts. A second copy of this stack
   * deployed for a *different* repo (e.g. one created from this one as a
   * GitHub template) MUST override githubRepoName, or its GitHub Actions
   * workflows can never assume the roles this stack creates — the OIDC
   * token's `sub` claim simply won't match.
   */
  readonly githubOwner?: string;
  readonly githubRepoName?: string;
}

export class ResumeSiteStack extends cdk.Stack {
  /** The CloudFront distribution domain name, output for reference. */
  public readonly distributionDomainName: string;

  constructor(scope: Construct, id: string, props?: ResumeSiteStackProps) {
    super(scope, id, props);

    const otpAdminEmail = props?.otpAdminEmail ?? 'admin@example.invalid';
    const otpHmacSecret = props?.otpHmacSecret ?? crypto.randomBytes(32).toString('hex');
    const resendApiKey = props?.resendApiKey ?? 'placeholder-resend-key';
    // Derived from the verified Resend sending domain (send.pages-enterprise.com,
    // a fresh subdomain kept separate from SES's mail.pages-enterprise.com to
    // avoid any DNS record collision) — not secret, so kept as a plain
    // constant rather than another required repo secret. A display name
    // and a real reply-to address are deliberate: corporate mail gateways
    // score both, and OTP mail from a bare noreply@ subdomain is exactly
    // what the magic-link fallback exists to work around.
    const resendFromAddress = 'Raymond Page <noreply@send.pages-enterprise.com>';
    const resendReplyTo = 'raymond.page@mutualofomaha.com';

    // ----------------------------------------------------------------
    // Custom domain — resume.pages-enterprise.com by default (see the
    // siteDomainName/hostedZone* props above for why these are
    // overridable).
    // Referenced by fixed attributes (not `fromLookup`) so synth doesn't
    // need an explicit account/region context lookup.
    // ----------------------------------------------------------------
    const siteDomainName = props?.siteDomainName ?? 'resume.pages-enterprise.com';
    const siteHostedZone = route53.PublicHostedZone.fromPublicHostedZoneAttributes(this, 'SiteHostedZone', {
      zoneName: props?.hostedZoneName ?? 'pages-enterprise.com',
      hostedZoneId: props?.hostedZoneId ?? 'Z09464661R0CYHRXA10JN',
    });

    const siteCertificate = new acm.Certificate(this, 'SiteCertificate', {
      domainName: siteDomainName,
      validation: acm.CertificateValidation.fromDns(siteHostedZone),
    });

    // ----------------------------------------------------------------
    // S3 Bucket — private, all public access blocked
    // ----------------------------------------------------------------
    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });

    // ----------------------------------------------------------------
    // Origin Access Control (OAC)
    // OAC is preferred over OAI for new distributions.
    // ----------------------------------------------------------------
    const oac = new cloudfront.CfnOriginAccessControl(this, 'OAC', {
      originAccessControlConfig: {
        name: `${this.stackName}-OAC`,
        description: 'OAC for resume site S3 origin',
        originAccessControlOriginType: 's3',
        signingBehavior: 'always',
        signingProtocol: 'sigv4',
      },
    });

    // ----------------------------------------------------------------
    // Cache policies
    // ----------------------------------------------------------------

    // HTML: short/no-cache so content updates appear immediately
    // after a CloudFront invalidation
    const htmlCachePolicy = new cloudfront.CachePolicy(this, 'HtmlCachePolicy', {
      cachePolicyName: `${this.stackName}-html-no-cache`,
      comment: 'No cache for HTML — invalidate on deploy',
      defaultTtl: cdk.Duration.seconds(1),
      minTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.seconds(31536000),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    // Static assets (CSS, JS, images): long cache (1 year)
    // Bust by changing the filename/content hash on deploy
    const staticAssetCachePolicy = new cloudfront.CachePolicy(this, 'StaticAssetCachePolicy', {
      cachePolicyName: `${this.stackName}-static-1y`,
      comment: 'Long-lived cache for versioned static assets',
      defaultTtl: cdk.Duration.days(365),
      minTtl: cdk.Duration.days(365),
      maxTtl: cdk.Duration.days(365),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    // ----------------------------------------------------------------
    // Email OTP access gate
    //
    // Makes the deployed site invite-only: every request to the default
    // behavior is checked by a CloudFront Function for a signed session
    // cookie (fails closed — any error redirects to /login.html). A
    // session is only issued after verifying a one-time code sent to an
    // allowlisted email. Full design rationale in task.md.
    // ----------------------------------------------------------------

    // Allowlist: pk="EMAIL"/sk=<email> for exact addresses, pk="DOMAIN"/
    // sk=<domain> for suffix matches (e.g. "mutualofomaha.com" allows any
    // *@mutualofomaha.com address). Managed via /admin.html after the
    // bootstrap admin entry below is seeded.
    const allowlistTable = new dynamodb.Table(this, 'AllowlistTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // One-time codes, keyed by email. The `ttl` attribute auto-expires
    // codes via DynamoDB TTL; requestCode/verifyCode Lambdas also enforce
    // the 10-minute expiry and a max-attempts lockout independently.
    const otpTable = new dynamodb.Table(this, 'OtpTable', {
      partitionKey: { name: 'email', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // CloudFront KeyValueStore holding the HMAC secret used to sign/verify
    // session cookies — read by the CloudFront Function via cf.kvs() and
    // by the verify-code/admin Lambdas via the KVS data plane API, so
    // there's a single source of truth for the secret at the edge and in
    // Lambda. Seeded by the KvsSeed custom resource below (not
    // ImportSource — its update semantics on an existing store aren't
    // guaranteed safe for a secret that must survive redeploys).
    const sessionKvs = new cloudfront.KeyValueStore(this, 'SessionKvs');

    const kvsSeedFn = new lambdaNode.NodejsFunction(this, 'KvsSeedFunction', {
      entry: path.join(__dirname, '../lambda/kvsSeed/index.ts'),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.minutes(2),
      bundling: { externalModules: [] },
    });
    kvsSeedFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudfront-keyvaluestore:DescribeKeyValueStore', 'cloudfront-keyvaluestore:PutKey'],
      resources: [sessionKvs.keyValueStoreArn],
    }));

    const kvsSeedProvider = new cr.Provider(this, 'KvsSeedProvider', {
      onEventHandler: kvsSeedFn,
    });

    new cdk.CustomResource(this, 'KvsSeed', {
      serviceToken: kvsSeedProvider.serviceToken,
      properties: {
        kvsArn: sessionKvs.keyValueStoreArn,
        secretValue: otpHmacSecret,
      },
    });

    // Bootstrap admin allowlist entry — reasserted on every deploy
    // (Create *and* Update), so redeploying always restores your own
    // admin access even if it were ever accidentally removed via
    // /admin.html. Every other entry is managed exclusively through the
    // admin UI from here on.
    const bootstrapAdminItem = {
      TableName: allowlistTable.tableName,
      Item: {
        pk: { S: 'EMAIL' },
        sk: { S: otpAdminEmail },
        admin: { BOOL: true },
        createdAt: { N: `${Math.floor(Date.now() / 1000)}` },
      },
    };
    new cr.AwsCustomResource(this, 'SeedAdminAllowlistEntry', {
      onCreate: {
        service: 'DynamoDB',
        action: 'putItem',
        parameters: bootstrapAdminItem,
        physicalResourceId: cr.PhysicalResourceId.of(`${this.stackName}-bootstrap-admin`),
      },
      onUpdate: {
        service: 'DynamoDB',
        action: 'putItem',
        parameters: bootstrapAdminItem,
        physicalResourceId: cr.PhysicalResourceId.of(`${this.stackName}-bootstrap-admin`),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: [allowlistTable.tableArn],
      }),
      // The runtime's bundled SDK already has DynamoDB putItem; the
      // default would npm-install the latest SDK inside the Lambda on
      // every deploy for nothing.
      installLatestAwsSdk: false,
    });

    // ---- API Lambdas behind /auth/* ----
    const requestCodeFn = new lambdaNode.NodejsFunction(this, 'RequestCodeFunction', {
      entry: path.join(__dirname, '../lambda/requestCode/index.ts'),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(10),
      environment: {
        OTP_TABLE_NAME: otpTable.tableName,
        ALLOWLIST_TABLE_NAME: allowlistTable.tableName,
        RESEND_API_KEY: resendApiKey,
        RESEND_FROM_ADDRESS: resendFromAddress,
        RESEND_REPLY_TO: resendReplyTo,
      },
      bundling: { externalModules: [] },
    });
    otpTable.grantReadWriteData(requestCodeFn);
    allowlistTable.grantReadData(requestCodeFn);
    // No IAM grant needed for sending — Resend is a plain HTTPS API
    // authorized by the RESEND_API_KEY env var above, not an AWS service
    // call. (SES's ses:SendEmail grant lived here previously; removed
    // along with the SES send path itself — see task.md.)

    const verifyCodeFn = new lambdaNode.NodejsFunction(this, 'VerifyCodeFunction', {
      entry: path.join(__dirname, '../lambda/verifyCode/index.ts'),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(10),
      environment: {
        OTP_TABLE_NAME: otpTable.tableName,
        ALLOWLIST_TABLE_NAME: allowlistTable.tableName,
        KVS_ARN: sessionKvs.keyValueStoreArn,
      },
      bundling: { externalModules: [] },
    });
    otpTable.grantReadWriteData(verifyCodeFn);
    allowlistTable.grantReadData(verifyCodeFn);
    verifyCodeFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudfront-keyvaluestore:GetKey'],
      resources: [sessionKvs.keyValueStoreArn],
    }));

    const adminFn = new lambdaNode.NodejsFunction(this, 'AdminAllowlistFunction', {
      entry: path.join(__dirname, '../lambda/admin/index.ts'),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(10),
      environment: {
        ALLOWLIST_TABLE_NAME: allowlistTable.tableName,
        KVS_ARN: sessionKvs.keyValueStoreArn,
      },
      bundling: { externalModules: [] },
    });
    allowlistTable.grantReadWriteData(adminFn);
    adminFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudfront-keyvaluestore:GetKey'],
      resources: [sessionKvs.keyValueStoreArn],
    }));

    // Session status/logout — lets the frontend show "Logged in as
    // <email>" and clear the session cookie, since the cookie itself is
    // HttpOnly and unreadable from JS. GET reports the current signed
    // session's identity (or authenticated: false); POST clears the
    // cookie unconditionally.
    const sessionFn = new lambdaNode.NodejsFunction(this, 'SessionFunction', {
      entry: path.join(__dirname, '../lambda/session/index.ts'),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(10),
      environment: {
        KVS_ARN: sessionKvs.keyValueStoreArn,
      },
      bundling: { externalModules: [] },
    });
    sessionFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudfront-keyvaluestore:GetKey'],
      resources: [sessionKvs.keyValueStoreArn],
    }));

    // Admin-issued magic-link fallback login. In addition to (never instead
    // of) the email-OTP flow above — for the case where a recipient's own
    // corporate mail gateway silently swallows the OTP email with no
    // visibility on either end (the motivating case: a candidate's
    // interviewer on a locked-down corporate domain). An admin generates a
    // short-lived, single-use link from admin.html and shares it via a
    // channel they already trust instead of relying on email reaching an
    // unfamiliar inbox.
    const magicLinkTable = new dynamodb.Table(this, 'MagicLinkTable', {
      partitionKey: { name: 'token', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
    });

    const magicLinkFn = new lambdaNode.NodejsFunction(this, 'MagicLinkFunction', {
      entry: path.join(__dirname, '../lambda/magicLink/index.ts'),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(10),
      environment: {
        MAGIC_LINK_TABLE_NAME: magicLinkTable.tableName,
        ALLOWLIST_TABLE_NAME: allowlistTable.tableName,
        KVS_ARN: sessionKvs.keyValueStoreArn,
        SITE_DOMAIN: siteDomainName,
      },
      bundling: { externalModules: [] },
    });
    magicLinkTable.grantReadWriteData(magicLinkFn);
    allowlistTable.grantReadData(magicLinkFn);
    magicLinkFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudfront-keyvaluestore:GetKey'],
      resources: [sessionKvs.keyValueStoreArn],
    }));

    // ---- AI assistant applet (sitewide, page-aware chat) ----
    // Direct Bedrock Runtime `Converse` call, not an Agent + Knowledge
    // Base — the site's entire public data surface (the four JSON files
    // below) is small enough to stuff into the prompt directly, so a
    // vector store (and its always-on cost) buys nothing here. See
    // task.md feature 2 ("Redesigned 2026-08-30") for the full rationale.
    const chatSessionTable = new dynamodb.Table(this, 'ChatSessionTable', {
      partitionKey: { name: 'email', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
    });

    // Guardrail applied to every chat call: PII anonymization plus
    // standard content filters, including PROMPT_ATTACK — relevant here
    // specifically because the visitor's current page name is injected
    // into the prompt alongside their message. Left on the CloudFormation-
    // managed DRAFT version rather than publishing a numbered
    // CfnGuardrailVersion — this is a single-environment deployment, so
    // there's no multi-environment version-pinning need that would justify
    // the extra publishing step.
    const chatGuardrail = new bedrock.CfnGuardrail(this, 'ChatGuardrail', {
      name: `${this.stackName}-chat-guardrail`,
      blockedInputMessaging: 'I can\'t help with that. Ask me about Raymond\'s experience or this site instead.',
      blockedOutputsMessaging: 'Sorry, I can\'t provide that response. Try rephrasing your question.',
      contentPolicyConfig: {
        filtersConfig: [
          { type: 'HATE', inputStrength: 'MEDIUM', outputStrength: 'MEDIUM' },
          { type: 'INSULTS', inputStrength: 'MEDIUM', outputStrength: 'MEDIUM' },
          { type: 'SEXUAL', inputStrength: 'MEDIUM', outputStrength: 'MEDIUM' },
          { type: 'VIOLENCE', inputStrength: 'MEDIUM', outputStrength: 'MEDIUM' },
          { type: 'MISCONDUCT', inputStrength: 'MEDIUM', outputStrength: 'MEDIUM' },
          { type: 'PROMPT_ATTACK', inputStrength: 'MEDIUM', outputStrength: 'NONE' },
        ],
      },
      // NAME and EMAIL are deliberately NOT in this list. A PII action
      // (with no explicit inputAction/outputAction override) applies to
      // both directions by default — and this site's entire purpose is
      // answering questions about a named person and surfacing his public
      // contact email. Confirmed live via `aws bedrock-runtime
      // apply-guardrail` (NAME) and real user testing (EMAIL): with either
      // included, every mention of "Raymond" or his email in the
      // assistant's own reply was anonymized to the literal placeholder
      // ("Based on {NAME}'s 100-Day Plan...", "reach out to Raymond
      // directly at {EMAIL}") — breaking the two most basic things a
      // recruiter would ask this assistant. PHONE/SSN/ADDRESS are safe to
      // keep: content.json deliberately never includes Raymond's phone or
      // street address (see its own note_content field), so the model was
      // never given that data and has no legitimate reason to output it —
      // these three can only ever fire on hallucinated or visitor-pasted
      // content, which is exactly the defensive posture intended.
      sensitiveInformationPolicyConfig: {
        piiEntitiesConfig: [
          { type: 'PHONE', action: 'ANONYMIZE' },
          { type: 'US_SOCIAL_SECURITY_NUMBER', action: 'BLOCK' },
          { type: 'ADDRESS', action: 'ANONYMIZE' },
        ],
      },
    });

    // Claude Haiku via Bedrock — small/cheap model, more than sufficient
    // for short grounded Q&A over a few KB of site data.
    //
    // Invoked via its US cross-region inference profile, not the bare
    // foundation-model ID — confirmed by a live test call that on-demand
    // throughput isn't supported for this model directly ("Retry your
    // request with the ID or ARN of an inference profile that contains
    // this model"). A cross-region profile can route the actual inference
    // to any US region, so IAM needs InvokeModel on the underlying
    // foundation model across all regions (wildcarded only on region,
    // still pinned to this exact model ID) in addition to the
    // account/region-scoped inference-profile ARN itself — both are
    // required for calls to succeed, per AWS's own guidance for
    // cross-region inference.
    const chatModelId = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
    const chatFoundationModelId = 'anthropic.claude-haiku-4-5-20251001-v1:0';
    const chatInferenceProfileArn = `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${chatModelId}`;
    const chatFoundationModelArnWildcardRegion = `arn:aws:bedrock:*::foundation-model/${chatFoundationModelId}`;

    const chatFn = new lambdaNode.NodejsFunction(this, 'ChatFunction', {
      entry: path.join(__dirname, '../lambda/chat/index.ts'),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(20),
      environment: {
        CHAT_SESSION_TABLE_NAME: chatSessionTable.tableName,
        SITE_BUCKET_NAME: siteBucket.bucketName,
        KVS_ARN: sessionKvs.keyValueStoreArn,
        CHAT_MODEL_ID: chatModelId,
        GUARDRAIL_ID: chatGuardrail.attrGuardrailId,
        GUARDRAIL_VERSION: 'DRAFT',
        // Runtime kill switch — flip directly on the deployed Lambda
        // (console/CLI) to disable instantly without a redeploy.
        CHAT_ENABLED: 'true',
      },
      bundling: { externalModules: [] },
    });
    chatSessionTable.grantReadWriteData(chatFn);
    chatFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudfront-keyvaluestore:GetKey'],
      resources: [sessionKvs.keyValueStoreArn],
    }));
    // Read-only, scoped to exactly the public JSON files the assistant is
    // allowed to answer from — never the raw résumé docx or JD source,
    // which never leave `.tmp/` in the first place.
    chatFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [
        siteBucket.arnForObjects('content.json'),
        siteBucket.arnForObjects('dora-metrics.json'),
        siteBucket.arnForObjects('security-scorecard.json'),
        siteBucket.arnForObjects('100-day-plan.json'),
        siteBucket.arnForObjects('engineering-enablement.json'),
      ],
    }));
    // Dedicated to this Lambda alone — never shared with the GitHub OIDC
    // deploy/diff/metrics roles above, which have no Bedrock access at all.
    chatFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [chatInferenceProfileArn, chatFoundationModelArnWildcardRegion],
    }));
    chatFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:ApplyGuardrail'],
      resources: [chatGuardrail.attrGuardrailArn],
    }));

    // ---- HTTP API (API Gateway v2) fronting the three Lambdas ----
    // Built from L1 (Cfn*) constructs rather than the L2 HttpApi, which
    // still lives in a separate alpha module version-locked to a specific
    // aws-cdk-lib release — avoided here to keep the dependency surface
    // stable across routine `npm update`s.
    const authApi = new apigwv2.CfnApi(this, 'AuthApi', {
      name: `${this.stackName}-auth-api`,
      protocolType: 'HTTP',
    });

    new apigwv2.CfnStage(this, 'AuthApiDefaultStage', {
      apiId: authApi.ref,
      stageName: '$default',
      autoDeploy: true,
      defaultRouteSettings: {
        // Cheap baseline abuse mitigation for a v1: a stage-level request
        // rate cap. Not per-IP/per-user — see task.md for the known
        // limitation and the WAF/usage-plan alternative considered.
        throttlingRateLimit: 10,
        throttlingBurstLimit: 20,
      },
    });

    const addAuthRoute = (
      routeId: string,
      routeKey: string,
      fn: lambdaNode.NodejsFunction,
      permissionPath: string,
    ): void => {
      const integration = new apigwv2.CfnIntegration(this, `${routeId}Integration`, {
        apiId: authApi.ref,
        integrationType: 'AWS_PROXY',
        integrationUri: fn.functionArn,
        payloadFormatVersion: '2.0',
      });
      new apigwv2.CfnRoute(this, `${routeId}Route`, {
        apiId: authApi.ref,
        routeKey,
        target: `integrations/${integration.ref}`,
      });
      fn.addPermission(`${routeId}InvokePermission`, {
        principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
        sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${authApi.ref}/*/*${permissionPath}`,
      });
    };

    addAuthRoute('RequestCode', 'POST /auth/request-code', requestCodeFn, '/auth/request-code');
    addAuthRoute('VerifyCode', 'POST /auth/verify-code', verifyCodeFn, '/auth/verify-code');
    addAuthRoute('AdminAllowlistGet', 'GET /auth/admin/allowlist', adminFn, '/auth/admin/allowlist');
    addAuthRoute('AdminAllowlistPost', 'POST /auth/admin/allowlist', adminFn, '/auth/admin/allowlist');
    addAuthRoute('AdminAllowlistDelete', 'DELETE /auth/admin/allowlist', adminFn, '/auth/admin/allowlist');
    addAuthRoute('Chat', 'POST /api/chat', chatFn, '/api/chat');
    addAuthRoute('SessionWhoAmI', 'GET /auth/session', sessionFn, '/auth/session');
    addAuthRoute('SessionLogout', 'POST /auth/logout', sessionFn, '/auth/logout');
    addAuthRoute('AdminMagicLink', 'POST /auth/admin/magic-link', magicLinkFn, '/auth/admin/magic-link');
    // NOTE: keep this construct ID as `ConsumeMagicLink`, matching the
    // route already live from an earlier deploy — renaming it once caused
    // CloudFormation to try creating a same-route-key replacement route
    // before deleting the old one, which API Gateway rejects (route keys
    // must be unique per API) and rolled the whole stack update back.
    addAuthRoute('ConsumeMagicLink', 'GET /auth/consume-link', magicLinkFn, '/auth/consume-link');
    addAuthRoute('ConsumeMagicLinkPost', 'POST /auth/consume-link', magicLinkFn, '/auth/consume-link');

    const authApiDomain = `${authApi.ref}.execute-api.${this.region}.${this.urlSuffix}`;

    // CloudFront Function gating the default (static site) behavior.
    // /login.html is exempted in the function code itself — it's the one
    // page that must stay reachable without a session.
    const sessionCheckFunction = new cloudfront.Function(this, 'SessionCheckFunction', {
      code: cloudfront.FunctionCode.fromFile({
        filePath: path.join(__dirname, '../cloudfront-functions/session-check.js'),
      }),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      keyValueStore: sessionKvs,
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'Raymond Page résumé site',

      // Default behavior — HTML (short cache), gated by the session-check
      // CloudFront Function.
      defaultBehavior: {
        origin: new origins.S3Origin(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: htmlCachePolicy,
        compress: true,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        functionAssociations: [{
          function: sessionCheckFunction,
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        }],
      },

      // Static assets — long cache
      additionalBehaviors: {
        '*.css': {
          origin: new origins.S3Origin(siteBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: staticAssetCachePolicy,
          compress: true,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        },
        '*.js': {
          origin: new origins.S3Origin(siteBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: staticAssetCachePolicy,
          compress: true,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        },
      },

      defaultRootObject: 'index.html',

      // Custom 404 page
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 404,
          responsePagePath: '/404.html',
          ttl: cdk.Duration.seconds(10),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 404,
          responsePagePath: '/404.html',
          ttl: cdk.Duration.seconds(10),
        },
      ],

      domainNames: [siteDomainName],
      certificate: siteCertificate,
    });

    // ----------------------------------------------------------------
    // Wire OAC to the distribution's S3 origin
    // CDK's S3Origin uses OAI by default; we override at the L1 level
    // to attach our OAC and remove any OAI reference.
    // ----------------------------------------------------------------
    const cfnDistribution = distribution.node.defaultChild as cloudfront.CfnDistribution;

    cfnDistribution.addPropertyOverride(
      'DistributionConfig.Origins.0.S3OriginConfig.OriginAccessIdentity',
      '',
    );
    cfnDistribution.addPropertyOverride(
      'DistributionConfig.Origins.0.OriginAccessControlId',
      oac.getAtt('Id'),
    );

    // ----------------------------------------------------------------
    // Bucket policy — allow CloudFront service principal via OAC
    // ----------------------------------------------------------------
    siteBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudFrontServicePrincipal',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
        actions: ['s3:GetObject'],
        resources: [siteBucket.arnForObjects('*')],
        conditions: {
          StringEquals: {
            'AWS:SourceArn': `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
          },
        },
      }),
    );

    // ----------------------------------------------------------------
    // /auth/* — proxies to the HTTP API above. Same-origin from the
    // browser's perspective (same distribution/domain as the static
    // site), so no CORS configuration is needed anywhere. No CloudFront
    // Function attached here — these routes must stay reachable
    // pre-authentication.
    // ----------------------------------------------------------------
    distribution.addBehavior('/auth/*', new origins.HttpOrigin(authApiDomain), {
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      // NOTE: must NOT forward the viewer's Host header (which is the
      // CloudFront distribution domain) to the API Gateway origin — API
      // Gateway rejects requests whose Host header doesn't match its own
      // execute-api domain with a 403, which CloudFront's
      // CustomErrorResponses then masks as the site's generic 404 page,
      // making this failure mode very confusing to diagnose from the
      // browser alone. ALL_VIEWER_EXCEPT_HOST_HEADER forwards everything
      // else (headers/cookies/query strings) but lets CloudFront set the
      // Host header to match the origin (API Gateway) domain instead.
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
    });

    // ----------------------------------------------------------------
    // /api/chat — same HTTP API/origin as /auth/*, same reasoning
    // (same-origin, no CORS needed; Host header must not be forwarded).
    // Unlike /auth/*, this route sits behind the session-check gate by
    // virtue of the site itself being gated — an unauthenticated visitor
    // never reaches a page that loads the chat widget in the first
    // place, and the Lambda re-verifies the session cookie server-side
    // regardless (never trust the client alone).
    // ----------------------------------------------------------------
    distribution.addBehavior('/api/chat', new origins.HttpOrigin(authApiDomain), {
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
    });

    this.distributionDomainName = distribution.distributionDomainName;

    // Alias records pointing the custom domain at the CloudFront
    // distribution (A for IPv4, AAAA for IPv6 — CloudFront distributions
    // serve both by default).
    const cloudFrontAliasTarget = route53.RecordTarget.fromAlias(
      new route53Targets.CloudFrontTarget(distribution),
    );

    new route53.ARecord(this, 'SiteAliasRecordA', {
      zone: siteHostedZone,
      recordName: siteDomainName,
      target: cloudFrontAliasTarget,
    });

    new route53.AaaaRecord(this, 'SiteAliasRecordAAAA', {
      zone: siteHostedZone,
      recordName: siteDomainName,
      target: cloudFrontAliasTarget,
    });

    new cdk.CfnOutput(this, 'AllowlistTableName', {
      value: allowlistTable.tableName,
      description: 'DynamoDB table backing the OTP access gate allowlist',
    });

    new cdk.CfnOutput(this, 'OtpBootstrapAdminEmail', {
      value: otpAdminEmail,
      description: 'Email seeded as the bootstrap admin for /admin.html',
    });

    new cdk.CfnOutput(this, 'SiteUrl', {
      value: `https://${siteDomainName}`,
      description: 'Custom domain URL for the résumé site',
      exportName: `${this.stackName}-SiteUrl`,
    });

    // ----------------------------------------------------------------
    // GitHub Actions OIDC — lets GitHub Actions assume short-lived AWS
    // roles instead of storing long-lived access keys as secrets.
    // The OIDC provider is account-wide (only one is allowed per AWS
    // account for a given issuer URL) — a second stack deployed into an
    // account that already has one must import it via githubOidcProviderArn
    // instead of creating a new one, which is why that prop exists.
    // ----------------------------------------------------------------
    const githubOidcProvider = props?.githubOidcProviderArn
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, 'GitHubOidcProvider', props.githubOidcProviderArn)
      : new iam.OpenIdConnectProvider(this, 'GitHubOidcProvider', {
          url: 'https://token.actions.githubusercontent.com',
          clientIds: ['sts.amazonaws.com'],
        });
    const githubRoleNamePrefix = props?.githubRoleNamePrefix ?? 'github-actions-resume-site';

    const githubOwner = props?.githubOwner ?? 'afsting';
    const githubRepoName = props?.githubRepoName ?? 'developer-experience-concepts';

    // GitHub decorates the `sub` claim with internal owner/repo IDs (e.g.
    // `repo:owner@12345/repo@67890:pull_request`) whenever the org or repo
    // has ever been renamed. AWS also requires the trust policy to condition
    // on `sub` (or `job_workflow_ref`) with something more specific than a
    // bare wildcard, so we match on `sub` using wildcards after the owner
    // and repo name to tolerate the optional ID suffix, rather than an exact
    // string match.
    //
    // The deploy job in deploy.yml declares `environment: production`,
    // which changes the sub claim's suffix from `:ref:refs/heads/main` to
    // `:environment:production` — GitHub Actions uses the environment name
    // in `sub` instead of the ref whenever a job targets an environment.
    // If the environment is ever removed from that job, this pattern must
    // change back to `:ref:refs/heads/main`.
    const githubSubPullRequest = `repo:${githubOwner}*/${githubRepoName}*:pull_request`;
    const githubSubMainPush = `repo:${githubOwner}*/${githubRepoName}*:environment:production`;

    // CDK bootstrap roles (created once per account/region by `cdk bootstrap`)
    // that GitHub Actions assumes in order to run `cdk diff` / `cdk deploy`.
    const cdkQualifier = 'hnb659fds'; // default CDK bootstrap qualifier
    const cdkDeployRoleArn = `arn:aws:iam::${this.account}:role/cdk-${cdkQualifier}-deploy-role-${this.account}-${this.region}`;
    const cdkFilePublishingRoleArn = `arn:aws:iam::${this.account}:role/cdk-${cdkQualifier}-file-publishing-role-${this.account}-${this.region}`;
    const cdkLookupRoleArn = `arn:aws:iam::${this.account}:role/cdk-${cdkQualifier}-lookup-role-${this.account}-${this.region}`;

    // Read-only role for the CDK Diff workflow (runs on pull_request from
    // this repo). Can only assume the lookup/deploy roles to read stack
    // state — no write access to the site bucket or CloudFront.
    const githubDiffRole = new iam.Role(this, 'GitHubActionsDiffRole', {
      roleName: `${githubRoleNamePrefix}-diff`,
      description: 'Read-only role assumed by GitHub Actions to run `cdk diff` on pull requests',
      assumedBy: new iam.WebIdentityPrincipal(githubOidcProvider.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        },
        StringLike: {
          'token.actions.githubusercontent.com:sub': githubSubPullRequest,
        },
      }),
      maxSessionDuration: cdk.Duration.hours(1),
    });

    githubDiffRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AssumeCdkBootstrapRoles',
      actions: ['sts:AssumeRole'],
      resources: [cdkDeployRoleArn, cdkLookupRoleArn],
    }));

    // Deploy role for the Deploy workflow (runs on push to main only).
    // Can assume the CDK bootstrap roles needed to deploy, plus write
    // directly to the site bucket and invalidate CloudFront (used by the
    // `aws s3 sync` / `aws cloudfront create-invalidation` steps).
    const githubDeployRole = new iam.Role(this, 'GitHubActionsDeployRole', {
      roleName: `${githubRoleNamePrefix}-deploy`,
      description: 'Role assumed by GitHub Actions to deploy the resume site on push to main',
      assumedBy: new iam.WebIdentityPrincipal(githubOidcProvider.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        },
        StringLike: {
          'token.actions.githubusercontent.com:sub': githubSubMainPush,
        },
      }),
      maxSessionDuration: cdk.Duration.hours(1),
    });

    githubDeployRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AssumeCdkBootstrapRoles',
      actions: ['sts:AssumeRole'],
      resources: [cdkDeployRoleArn, cdkFilePublishingRoleArn, cdkLookupRoleArn],
    }));

    siteBucket.grantReadWrite(githubDeployRole);

    githubDeployRole.addToPolicy(new iam.PolicyStatement({
      sid: 'InvalidateCloudFrontCache',
      actions: ['cloudfront:CreateInvalidation'],
      resources: [`arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`],
    }));

    // Narrowly-scoped role shared by the scheduled data-refresh workflows
    // (.github/workflows/dora-metrics.yml and security-scorecard.yml,
    // schedule + workflow_dispatch triggers only). Deliberately NOT the
    // deploy role: these workflows only ever need to overwrite their own
    // named S3 object (dora-metrics.json / security-scorecard.json) —
    // neither runs `cdk deploy` nor touches any other site file, so they
    // share one least-privilege role scoped to just those two object
    // keys, rather than reusing githubDeployRole's full bucket
    // read/write + CloudFront invalidation access. Both are written with
    // Cache-Control: no-cache (like HTML), so no CloudFront invalidation
    // permission is needed either — each object is always revalidated at
    // the edge.
    const githubSubScheduledOrDispatch = `repo:${githubOwner}*/${githubRepoName}*:ref:refs/heads/main`;

    const githubMetricsRole = new iam.Role(this, 'GitHubActionsMetricsRole', {
      roleName: `${githubRoleNamePrefix}-metrics`,
      description: 'Role assumed by GitHub Actions to publish scheduled data JSON (DORA metrics, security scorecard) to the site bucket',
      assumedBy: new iam.WebIdentityPrincipal(githubOidcProvider.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        },
        StringLike: {
          'token.actions.githubusercontent.com:sub': githubSubScheduledOrDispatch,
        },
      }),
      maxSessionDuration: cdk.Duration.hours(1),
    });

    githubMetricsRole.addToPolicy(new iam.PolicyStatement({
      sid: 'PutMetricsObjectsOnly',
      actions: ['s3:PutObject'],
      resources: [
        siteBucket.arnForObjects('dora-metrics.json'),
        siteBucket.arnForObjects('security-scorecard.json'),
      ],
    }));

    githubMetricsRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadStackOutputsForBucketName',
      actions: ['cloudformation:DescribeStacks'],
      resources: [this.stackId],
    }));

    // ----------------------------------------------------------------
    // Cost alarm — covers the whole account's AWS spend (site + chat
    // combined), not just one service. $10/month is generous headroom
    // above the realistic ~$1-2/month estimate, so it only fires on
    // genuine runaway cost rather than normal variance. Two
    // notifications: FORECASTED gives advance warning if this month is
    // on track to exceed the limit; ACTUAL confirms it actually has.
    // AWS::Budgets::Budget is an inherently global resource (not tied to
    // this stack's region).
    // ----------------------------------------------------------------
    const monthlyCostBudgetLimit = 10;

    new budgets.CfnBudget(this, 'MonthlyCostBudget', {
      budget: {
        budgetName: `${this.stackName}-monthly-cost-budget`,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: {
          amount: monthlyCostBudgetLimit,
          unit: 'USD',
        },
      },
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: 'FORECASTED',
            comparisonOperator: 'GREATER_THAN',
            threshold: 100,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [
            { subscriptionType: 'EMAIL', address: otpAdminEmail },
          ],
        },
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 100,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [
            { subscriptionType: 'EMAIL', address: otpAdminEmail },
          ],
        },
      ],
    });

    // ----------------------------------------------------------------
    // Stack outputs
    // ----------------------------------------------------------------
    new cdk.CfnOutput(this, 'BucketName', {
      value: siteBucket.bucketName,
      description: 'S3 bucket containing site content',
      exportName: `${this.stackName}-BucketName`,
    });

    new cdk.CfnOutput(this, 'DistributionId', {
      value: distribution.distributionId,
      description: 'CloudFront distribution ID (used for cache invalidation)',
      exportName: `${this.stackName}-DistributionId`,
    });

    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: distribution.distributionDomainName,
      description: 'CloudFront domain name for the résumé site',
      exportName: `${this.stackName}-DistributionDomainName`,
    });

    new cdk.CfnOutput(this, 'GitHubActionsDiffRoleArn', {
      value: githubDiffRole.roleArn,
      description: 'Set as the AWS_CDK_DIFF_ROLE_ARN secret in the GitHub repo',
      exportName: `${this.stackName}-GitHubActionsDiffRoleArn`,
    });

    new cdk.CfnOutput(this, 'GitHubActionsDeployRoleArn', {
      value: githubDeployRole.roleArn,
      description: 'Set as the AWS_DEPLOY_ROLE_ARN secret in the GitHub repo',
      exportName: `${this.stackName}-GitHubActionsDeployRoleArn`,
    });

    new cdk.CfnOutput(this, 'GitHubActionsMetricsRoleArn', {
      value: githubMetricsRole.roleArn,
      description: 'Set as the AWS_METRICS_ROLE_ARN secret in the GitHub repo',
      exportName: `${this.stackName}-GitHubActionsMetricsRoleArn`,
    });
  }
}
