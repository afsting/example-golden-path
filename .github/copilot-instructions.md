# Copilot Instructions — developer-experience-concepts

## What this repo is

A résumé site for Raymond Page that doubles as a working demo of
platform-engineering practices: static site on AWS (S3 + CloudFront),
infra as code (CDK v2/TypeScript), and CI/CD via GitHub Actions using
OIDC federation (no long-lived AWS credentials). The narrative
("how it was built") is as much the point as the résumé content itself.

## Repository layout

```
infra/                      AWS CDK app (TypeScript)
  bin/resume-site.ts        CDK entry point
  lib/resume-site-stack.ts  S3 + CloudFront + IAM/OIDC stack (single stack: ResumeSiteStack)
  test/                     jest unit tests (aws-cdk-lib assertions)
site/                       Static site, no build tooling required to view
  content.json              ← résumé content lives here, edit this not the HTML
  build.js                  renders content.json into the HTML pages
  index.html, how-it-was-built.html, 404.html, styles.css
.github/workflows/
  deploy.yml                push to main → cdk deploy → s3 sync → CF invalidation
  cdk-diff.yml              PR touching infra/** → cdk diff posted as PR comment
```

## Infra conventions (infra/lib/resume-site-stack.ts)

- S3 bucket is **private**, `BlockPublicAccess.BLOCK_ALL`, `RemovalPolicy.RETAIN`.
  CloudFront reaches it via **Origin Access Control (OAC)**, not the legacy OAI.
- One CDK stack (`ResumeSiteStack`) holds site infra (S3/CloudFront) *and*
  the GitHub OIDC provider + IAM roles for CI/CD — keep it that way unless
  there's a strong reason to split.
- CDK bootstrap qualifier is `hnb659fds` (default). Account `315326805073`,
  region `us-east-1`.
- Custom domain (resume.pages-enterprise.com) is live, not commented out.
  Domain/hosted-zone, the GitHub OIDC provider, and the three GitHub
  Actions IAM role names are all overridable via `ResumeSiteStackProps`
  (defaults match the deployed values — see the class doc comment) so a
  second, independent copy of this stack can be deployed into the same
  AWS account without colliding with the original.

## Email delivery (Resend)

- The OTP login-code email (`infra/lambda/requestCode/index.ts`) sends via
  [Resend](https://resend.com)'s REST API (`POST https://api.resend.com/emails`,
  called with the runtime's built-in `fetch` — no SDK dependency), **not** SES.
  SES was used originally but was migrated off entirely on 2026-09-06/07 (#67,
  #68) because its sandbox mode requires per-recipient verification; the SES
  identity and its DNS records were removed on 2026-09-13 (#73) once Resend
  had been proven working in production. Do not reintroduce SES for this path.
- Sending domain is `send.pages-enterprise.com` — a subdomain kept deliberately
  separate from anything SES-related to avoid DNS record collisions. Verified
  via DKIM/SPF/DMARC DNS records CDK does **not** manage (added manually to the
  `pages-enterprise.com` Route 53 hosted zone, `Z09464661R0CYHRXA10JN` — see
  task.md for the exact records if you need to reproduce them).
- `RESEND_API_KEY` is a required repo secret, wired through as a plain Lambda
  env var on `RequestCodeFunction` only (see `resendApiKey` prop in
  `infra/lib/resume-site-stack.ts`) — same pattern as `OTP_HMAC_SECRET`, not
  Secrets Manager. The from-address (`RESEND_FROM_ADDRESS`,
  `noreply@send.pages-enterprise.com`) is a hardcoded plain-text constant in
  the stack, not a secret.
- Rotating the key or checking delivery status/logs happens in the Resend
  dashboard (resend.com) — there's no AWS-side equivalent to `aws sesv2`
  commands for this provider; it's a normal third-party HTTPS API.

## GitHub Actions OIDC — the one thing to get right

- `deploy.yml` and `cdk-diff.yml` use `aws-actions/configure-aws-credentials@v4`
  with `role-to-assume` from a repo secret (`AWS_DEPLOY_ROLE_ARN`,
  `AWS_CDK_DIFF_ROLE_ARN`) and `permissions: id-token: write`. No stored AWS keys.
- **Do not** write IAM trust-policy conditions that do exact-string-match the
  `sub` claim against `repo:{owner}/{repo}:...`. GitHub decorates `sub` with
  internal numeric owner/repo IDs whenever the org or repo has ever been
  renamed (e.g. `repo:owner@12345/repo@67890:pull_request`), which silently
  breaks exact matches. Use `StringLike` wildcards after the owner/repo name
  (see `githubSubPullRequest` / `githubSubMainPush` in the stack) instead.
  AWS also rejects trust policies whose `sub`/`job_workflow_ref` condition is
  a bare wildcard, so `repository`/`ref` claims alone are not a valid
  substitute — you need a scoped `sub` (or `job_workflow_ref`) condition.
- Verify actual OIDC claims via CloudTrail `lookup-events` on
  `AssumeRoleWithWebIdentity` if a trust policy mismatch is suspected —
  `userIdentity.principalId` shows the exact `sub` GitHub sent.
- A job's `sub` claim suffix depends on how it's triggered: plain
  `pull_request` → `:pull_request`; push to a branch → `:ref:refs/heads/<branch>`;
  **but** if the job sets `environment: <name>` (as `deploy.yml`'s `deploy`
  job does, `environment: production`), the suffix becomes
  `:environment:<name>` instead — the ref is not part of `sub` at all in
  that case. Check the actual CloudTrail event before assuming which form
  applies.

## `actions/github-script` steps — avoid template-literal injection

Never splice a step output directly into a `github-script` JS template
literal like `` `${{ steps.x.outputs.y }}` ``. If that output contains
backticks or `${...}` (which `cdk diff` output regularly does), it breaks
the script syntax and is also an injection risk. Pass the value through
`env:` on the step and read it via `process.env.VAR_NAME` instead.

## Branch protection on `main`

- `main` requires the `CDK Infrastructure Diff` status check (from
  `cdk-diff.yml`) to pass, blocks force-pushes/deletions, and
  `enforce_admins` is on — even the repo owner must go through a PR.
- Because that check is *required*, `cdk-diff.yml` intentionally has **no**
  `paths:` filter — it triggers on every PR and always reports a status,
  even for PRs that don't touch `infra/` (e.g. docs-only changes). It gates
  the actual `cdk diff` work internally via a git-diff-based step
  (`Check for infra changes`), not via the workflow trigger. If you add a
  `paths:` filter back, non-infra PRs will hang forever waiting on a status
  that never gets reported and can never be merged.
- Branch protection with required status checks / enforce-admins requires
  the repo to be **public** on GitHub Free, or GitHub Pro for a private
  repo. This repo is public partly for that reason; reuse/scraping
  concerns are addressed via an explicit `LICENSE` (all rights reserved)
  instead of going private.

## Local dev commands

```bash
cd infra
npm install
npm run build       # tsc
npm test            # jest unit tests — no env vars needed, stack is
                     # constructed with no props and falls back to
                     # placeholder defaults

# synth/diff/deploy construct the stack via bin/resume-site.ts, which calls
# requireEnv() and throws if any of these are unset:
export OTP_ADMIN_EMAIL=test@example.com
export OTP_HMAC_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
export RESEND_API_KEY=test   # real key only needed for an actual deploy

npx cdk synth         # dry-run CloudFormation synth
npx cdk diff --profile default
npx cdk deploy --profile default --require-approval never
```

Site has no build step — open `site/*.html` directly or serve with
`npx serve site` / `python3 -m http.server 8080`.

## Environment quirks worth knowing

- Windows PowerShell terminals in this workspace often don't pick up PATH
  updates from `winget install` (e.g. for `gh`) in new terminal sessions.
  Prefix commands with:
  ```powershell
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
  ```
- GitHub repo: `afsting/developer-experience-concepts`. AWS account
  `315326805073`, `us-east-1`, IAM user `af_sting`.
