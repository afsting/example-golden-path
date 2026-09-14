# Raymond Page — Developer Experience Portfolio

## What This Is

A professional résumé site and, simultaneously, a small working demonstration
of the platform-engineering practices it describes: a golden-path static-site
deployment on AWS, all infrastructure defined as code, a real CI/CD pipeline
with no long-lived secrets, and a documented AI-assisted build process.

The résumé content is sourced from Raymond Page's actual experience. The
_way it was built_ is the artifact — see [**How This Was Built →**](site/how-it-was-built.html)
for the engineering write-up.

This repository is public for portfolio/demonstration purposes only. See
[LICENSE](LICENSE) — all rights reserved; no reuse, redistribution, or use
in AI training datasets is permitted without prior written permission.

---

## Architecture

```
GitHub → GitHub Actions (OIDC) → AWS
                                    ├── CDK deploy → CloudFormation
                                    ├── S3 sync   → Private S3 bucket
                                    └── CF invalidation → CloudFront (OAC)
                                                               └── HTTPS only
                                                                   └── Browser
```

| Layer | Detail |
|---|---|
| Static hosting | Amazon S3 (private bucket, all public access blocked) |
| CDN | Amazon CloudFront with Origin Access Control (OAC) |
| HTTPS | Enforced; HTTP redirected to HTTPS at the edge |
| IaC | AWS CDK v2 (TypeScript) |
| CI/CD | GitHub Actions; OIDC federation — no long-lived AWS keys |
| Content | `site/content.json` (data) rendered by `site/build.js` (template) |
| Domain | `resume.pages-enterprise.com` (custom domain via Route 53 + ACM) |

---

## Repository Layout

```
developer-experience-concepts/
├── .github/
│   └── workflows/
│       ├── deploy.yml          # Deploy on push to main
│       └── cdk-diff.yml        # CDK diff comment on PRs touching infra/
├── infra/                      # AWS CDK app (TypeScript)
│   ├── bin/resume-site.ts      # CDK entry point
│   ├── lib/resume-site-stack.ts# S3 + CloudFront stack definition
│   ├── test/                   # CDK unit tests (jest + assertions)
│   ├── cdk.json
│   ├── package.json
│   └── tsconfig.json
├── site/                       # Static site files
│   ├── index.html              # Résumé page
│   ├── how-it-was-built.html   # Engineering write-up
│   ├── 404.html                # Custom error page
│   ├── styles.css              # Design system (CSS custom properties)
│   ├── build.js                # Content renderer (reads content.json)
│   └── content.json            # ← Edit this to update résumé content
└── README.md                   # This file
```

---

## Local Development

No build step is required for the site itself — it is plain HTML/CSS/JS.

To preview locally:

```bash
# Any static file server works; for example:
cd site
npx serve .
# or
python3 -m http.server 8080
```

To work on the CDK infrastructure:

```bash
cd infra
npm install
npm run build       # Compile TypeScript
npm test            # Run CDK unit tests
npx cdk synth       # Synthesize CloudFormation template (dry run)
```

---

## How Deploys Work

Every push to `main` triggers the `deploy.yml` workflow:

1. **Install** CDK dependencies and build TypeScript.
2. **Assume AWS role** via GitHub OIDC — short-lived credentials, no stored keys.
3. **`cdk deploy`** — provisions or updates the CloudFormation stack.
4. **`aws s3 sync`** — uploads site files with correct `Cache-Control` headers:
   - HTML: `no-cache` (appears immediately after CloudFront invalidation)
   - CSS/JS: `max-age=31536000, immutable` (long cache; change filename to bust)
5. **CloudFront invalidation** — ensures updated HTML is served globally within seconds.

Pull requests that touch `infra/**` trigger a separate `cdk-diff.yml` workflow
that runs `cdk diff` and posts the proposed infrastructure changes as a PR comment,
making infra changes reviewable before merge.

---

## AWS Setup Prerequisites

Before the first deploy, one-time manual setup is required:

1. **GitHub OIDC Provider** — add `token.actions.githubusercontent.com` as an
   identity provider in your AWS account (one-time, account-level).
2. **IAM Role** — create a role trusted by the GitHub OIDC provider, scoped to
   this repository. The role needs permissions to deploy CloudFormation, read/write
   the S3 bucket, and create CloudFront invalidations.
   See [AWS documentation on GitHub OIDC](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_create_oidc.html).
3. **GitHub Secret** — add `AWS_DEPLOY_ROLE_ARN` as a repository secret containing
   the ARN of the IAM role created in step 2.
4. **CDK Bootstrap** — if deploying to a fresh account/region:
   ```bash
   cd infra && npx cdk bootstrap aws://ACCOUNT_ID/us-east-1
   ```
5. **Repo secrets required by every synth/diff/deploy** — `cdk deploy`
   fails fast (`requireEnv` in `infra/bin/resume-site.ts`) if any of
   these are missing:

   | Secret | Purpose |
   |---|---|
   | `AWS_DEPLOY_ROLE_ARN` | OIDC role assumed by `deploy.yml` |
   | `AWS_CDK_DIFF_ROLE_ARN` | OIDC role assumed by `cdk-diff.yml` |
   | `OTP_ADMIN_EMAIL` | Bootstrap admin allowlist entry for `/admin.html` |
   | `OTP_HMAC_SECRET` | Signs the OTP-gate session cookie — must stay stable across deploys |
   | `RESEND_API_KEY` | Sends the OTP login-code email — see **Email Delivery** below |

---

## Custom Domain

The site is served at `resume.pages-enterprise.com`:

- A public ACM certificate (`us-east-1`, DNS-validated) is provisioned
  directly in `infra/lib/resume-site-stack.ts`.
- Route 53 alias `A`/`AAAA` records point the subdomain at the CloudFront
  distribution, in the pre-existing `pages-enterprise.com` hosted zone.

---

## Email Delivery (Resend)

The site is invite-only (see `how-it-was-built.html`), and the OTP
login-code email is sent via [Resend](https://resend.com), not SES —
SES was used originally but was migrated off in September 2026 because
its sandbox mode requires every recipient to be individually verified;
the old SES identity and its DNS records were fully removed once
Resend had been proven working in production. Full rationale in
[**How This Was Built →**](site/how-it-was-built.html).

- **Sending domain**: `send.pages-enterprise.com`, verified at the
  domain level via DKIM/SPF/DMARC DNS records in the same
  `pages-enterprise.com` Route 53 hosted zone used for the custom
  domain above.
- **Managing it**: log into the [Resend dashboard](https://resend.com/login)
  to rotate the API key, check the sending domain's verification
  status, or look up delivery logs for a specific email. There's no
  AWS-side equivalent — it's a plain third-party HTTPS API, not an AWS
  service.
- **Rotating the API key**: generate a new one in the Resend dashboard,
  then `gh secret set RESEND_API_KEY` (or the GitHub web UI) — never
  paste the raw key into a chat/conversation. The next deploy picks it
  up automatically as a Lambda environment variable.

---

## Estimated Monthly AWS Cost

At résumé-traffic volumes (tens to low hundreds of requests/month):

| Service | Estimated cost |
|---|---|
| S3 | ~$0.00 (well under 1 GB, requests via CloudFront) |
| CloudFront | ~$0.00–$0.10 (within AWS free tier at this volume) |
| Route 53 | ~$0.50/month hosted zone + ~$12–15/year domain registration |
| **Total** | **< $1.50/month** (amortizing annual domain registration) |

---

## How This Was Built

See [**site/how-it-was-built.html**](site/how-it-was-built.html) for the full
engineering write-up: architecture decisions, AI-assisted scaffolding process,
CI/CD and security choices (OIDC, OAC), and the content-as-data pattern.

---

## Content Updates

To update the résumé, edit [`site/content.json`](site/content.json). Push to
`main` — the deploy pipeline will sync the updated file and invalidate CloudFront.
No HTML editing required.