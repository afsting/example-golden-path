#!/usr/bin/env node
/**
 * dora-metrics.mjs — Computes DORA metrics from this repo's own `deploy.yml`
 * run history via the GitHub REST API, and writes the result to
 * site/dora-metrics.json.
 *
 * Metrics computed (the four standard DORA metrics):
 *   - Deployment frequency: successful deploys per week/day over the window.
 *   - Lead time for changes: time from the triggering commit to the deploy
 *     run being kicked off (head_commit.timestamp -> run.created_at).
 *   - Change failure rate: % of completed deploy runs that failed.
 *   - Mean time to restore: average time between a failed deploy and the
 *     next successful one.
 *
 * Requires a `GITHUB_TOKEN`/`GH_TOKEN` env var with `actions: read` access
 * and `GITHUB_REPOSITORY` (owner/repo) — both are set automatically inside
 * GitHub Actions. Uses Node's built-in fetch (Node 18+).
 *
 * No external dependencies — intentionally dependency-free so this can run
 * as a small standalone step without an npm install.
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKFLOW_FILE = 'deploy.yml';
const OUTPUT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'site',
  'dora-metrics.json'
);

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
      'User-Agent': 'dora-metrics-script',
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${pathname} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function fetchAllRuns() {
  const runs = [];
  let page = 1;
  // Repo is low-volume; 100/page comfortably covers all runs in a page or two.
  for (;;) {
    const data = await githubApi(
      `/repos/${repoSlug}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=100&page=${page}`
    );
    runs.push(...data.workflow_runs);
    if (data.workflow_runs.length < 100) break;
    page += 1;
    if (page > 10) break; // safety cap
  }
  // Oldest first, so metrics can be computed chronologically.
  return runs
    .filter((r) => r.status === 'completed')
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

function minutesBetween(a, b) {
  return Math.max(0, (new Date(b) - new Date(a)) / 60000);
}

function average(nums) {
  if (nums.length === 0) return null;
  return nums.reduce((sum, n) => sum + n, 0) / nums.length;
}

function median(nums) {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function round(n, digits = 1) {
  if (n === null || n === undefined) return null;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function computeMetrics(runs) {
  const successful = runs.filter((r) => r.conclusion === 'success');
  const failed = runs.filter((r) => r.conclusion === 'failure');
  const total = runs.length;

  // --- Deployment frequency ---
  const periodDays =
    total > 0
      ? Math.max(1, minutesBetween(runs[0].created_at, runs[runs.length - 1].created_at) / 1440)
      : 0;
  const deploymentFrequency = {
    total_deploys: successful.length,
    period_days: round(periodDays, 1),
    per_week: total > 0 ? round((successful.length / periodDays) * 7, 2) : null,
    per_day: total > 0 ? round(successful.length / periodDays, 2) : null,
  };

  // --- Lead time for changes ---
  const leadTimes = successful
    .filter((r) => r.head_commit && r.head_commit.timestamp)
    .map((r) => minutesBetween(r.head_commit.timestamp, r.created_at));
  const leadTimeForChanges = {
    avg_minutes: round(average(leadTimes)),
    median_minutes: round(median(leadTimes)),
    sample_size: leadTimes.length,
  };

  // --- Change failure rate ---
  // Cancelled/skipped runs are neither a deploy nor a failed deploy, so
  // they're excluded from the denominator rather than diluting the rate.
  const attempted = successful.length + failed.length;
  const changeFailureRate = {
    percent: attempted > 0 ? round((failed.length / attempted) * 100, 1) : null,
    failed: failed.length,
    total: attempted,
  };

  // --- Mean time to restore ---
  const restoreTimes = [];
  for (let i = 0; i < runs.length; i += 1) {
    if (runs[i].conclusion !== 'failure') continue;
    const nextSuccess = runs.slice(i + 1).find((r) => r.conclusion === 'success');
    if (nextSuccess) {
      restoreTimes.push(minutesBetween(runs[i].created_at, nextSuccess.created_at));
    }
  }
  const meanTimeToRestore = {
    avg_minutes: round(average(restoreTimes)),
    sample_size: restoreTimes.length,
  };

  const recentRuns = runs
    .slice(-10)
    .reverse()
    .map((r) => ({
      sha: r.head_sha.slice(0, 7),
      created_at: r.created_at,
      conclusion: r.conclusion,
      duration_minutes: round(minutesBetween(r.created_at, r.updated_at)),
      html_url: r.html_url,
    }));

  return {
    generated_at: new Date().toISOString(),
    repo: repoSlug,
    workflow: WORKFLOW_FILE,
    totals: { total_runs: total, successful: successful.length, failed: failed.length },
    deployment_frequency: deploymentFrequency,
    lead_time_for_changes: leadTimeForChanges,
    change_failure_rate: changeFailureRate,
    mean_time_to_restore: meanTimeToRestore,
    recent_runs: recentRuns,
  };
}

async function main() {
  const runs = await fetchAllRuns();
  const metrics = computeMetrics(runs);
  await writeFile(OUTPUT_PATH, `${JSON.stringify(metrics, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${OUTPUT_PATH} (${runs.length} completed runs considered).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
