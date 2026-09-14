#!/usr/bin/env node
/**
 * security-scorecard.mjs — Computes a "security scorecard" for this repo
 * from three live sources and writes site/security-scorecard.json:
 *
 *   - CodeQL code scanning: open alert counts (by rule severity) and the
 *     most recent analysis run, via the GitHub REST API.
 *   - Dependabot: how many dependency-update PRs this repo has actually
 *     had opened/merged (a proxy for "Dependabot is active and being
 *     merged", since the Dependabot *alerts* API requires permissions
 *     beyond what the default GITHUB_TOKEN can be granted).
 *   - npm audit: current vulnerability counts by severity for infra/'s
 *     dependency tree, read from a JSON report the calling workflow
 *     produces with `npm audit --json` (this script does not shell out
 *     itself — keeps it dependency-free and side-effect-free).
 *
 * Requires GH_TOKEN/GITHUB_TOKEN with `security-events: read` (for code
 * scanning) and GITHUB_REPOSITORY (owner/repo) — both set automatically
 * inside GitHub Actions. Uses Node's built-in fetch (Node 18+).
 */

import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUTPUT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'site',
  'security-scorecard.json'
);

const AUDIT_REPORT_PATH =
  process.env.NPM_AUDIT_REPORT_PATH ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'audit-report.json');

// Supplied by security-scorecard.yml so it stays in step with the
// --audit-level the cdk-diff.yml / deploy.yml gates actually enforce.
const NPM_AUDIT_GATE_LEVEL = process.env.NPM_AUDIT_GATE_LEVEL || 'high';

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const repoSlug = process.env.GITHUB_REPOSITORY || 'afsting/developer-experience-concepts';

if (!token) {
  console.error('Missing GH_TOKEN/GITHUB_TOKEN env var — required to call the GitHub API.');
  process.exit(1);
}

async function githubApi(pathname) {
  const res = await fetch(`https://api.github.com${pathname}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'security-scorecard-script',
    },
  });
  if (res.status === 404) return null; // e.g. code scanning not enabled / no analyses yet.
  if (!res.ok) {
    throw new Error(`GitHub API ${pathname} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function fetchCodeScanning() {
  const alerts = (await githubApi(`/repos/${repoSlug}/code-scanning/alerts?state=open&per_page=100&tool_name=CodeQL`)) || [];
  const bySeverity = { error: 0, warning: 0, note: 0 };
  for (const alert of alerts) {
    const severity = alert.rule?.severity;
    if (severity && severity in bySeverity) bySeverity[severity] += 1;
  }

  const analyses = await githubApi(`/repos/${repoSlug}/code-scanning/analyses?tool_name=CodeQL&per_page=1`);
  const latest = Array.isArray(analyses) && analyses.length > 0 ? analyses[0] : null;

  return {
    open_alerts: { ...bySeverity, total: alerts.length },
    last_analysis: latest
      ? {
          created_at: latest.created_at,
          commit_sha: latest.commit_sha?.slice(0, 7) ?? null,
          html_url: latest.url ? latest.url.replace('api.github.com/repos', 'github.com').replace('/code-scanning/analyses/', '/security/code-scanning/') : null,
        }
      : null,
  };
}

async function fetchDependabotActivity() {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const totalQuery = `repo:${repoSlug} type:pr author:app/dependabot`;
  const mergedQuery = `repo:${repoSlug} type:pr is:merged author:app/dependabot merged:>=${ninetyDaysAgo}`;

  const [totalResult, mergedResult] = await Promise.all([
    githubApi(`/search/issues?q=${encodeURIComponent(totalQuery)}&per_page=1`),
    githubApi(`/search/issues?q=${encodeURIComponent(mergedQuery)}&per_page=1`),
  ]);

  return {
    prs_opened_total: totalResult?.total_count ?? 0,
    prs_merged_last_90_days: mergedResult?.total_count ?? 0,
  };
}

async function readNpmAudit() {
  let raw;
  try {
    raw = await readFile(AUDIT_REPORT_PATH, 'utf8');
  } catch (err) {
    console.warn(`No npm audit report found at ${AUDIT_REPORT_PATH}; skipping. (${err.message})`);
    return null;
  }
  const report = JSON.parse(raw);
  const vulnerabilities = report.metadata?.vulnerabilities || {};
  const severityOrder = ['critical', 'high', 'moderate', 'low', 'info'];
  const gateIndex = severityOrder.indexOf(NPM_AUDIT_GATE_LEVEL);
  const gatePasses = severityOrder
    .slice(0, gateIndex + 1)
    .every((sev) => !vulnerabilities[sev]);

  return {
    gate_level: NPM_AUDIT_GATE_LEVEL,
    vulnerabilities: {
      info: vulnerabilities.info || 0,
      low: vulnerabilities.low || 0,
      moderate: vulnerabilities.moderate || 0,
      high: vulnerabilities.high || 0,
      critical: vulnerabilities.critical || 0,
    },
    gate_passes: gatePasses,
  };
}

async function main() {
  const [codeScanning, dependabot, npmAudit] = await Promise.all([
    fetchCodeScanning(),
    fetchDependabotActivity(),
    readNpmAudit(),
  ]);

  const scorecard = {
    generated_at: new Date().toISOString(),
    repo: repoSlug,
    code_scanning: codeScanning,
    dependabot,
    npm_audit: npmAudit,
  };

  await writeFile(OUTPUT_PATH, `${JSON.stringify(scorecard, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
