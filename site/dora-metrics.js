/**
 * dora-metrics.js — Renders site/dora-metrics.json as a scorecard.
 *
 * Same "content as data" pattern as build.js: this file is vanilla JS with
 * no build step, and the data file is produced by a separate scheduled
 * GitHub Actions workflow (.github/workflows/dora-metrics.yml) that pulls
 * this repo's own deploy.yml run history via the GitHub API.
 */

(function () {
  'use strict';

  function esc(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtMinutes(mins) {
    if (mins === null || mins === undefined) return '—';
    if (mins < 60) return `${mins} min`;
    const hours = mins / 60;
    if (hours < 24) return `${Math.round(hours * 10) / 10} hr`;
    return `${Math.round((hours / 24) * 10) / 10} days`;
  }

  function fmtPercent(pct) {
    if (pct === null || pct === undefined) return '—';
    return `${pct}%`;
  }

  function fmtPerWeek(n) {
    if (n === null || n === undefined) return '—';
    return `${n}/week`;
  }

  function renderMeta(data) {
    const el = document.getElementById('scorecard-meta');
    if (!el) return;
    const generated = new Date(data.generated_at).toLocaleString();
    el.innerHTML = `Source: <code>${esc(data.repo)}</code> &middot;
      workflow <code>${esc(data.workflow)}</code> &middot;
      ${data.totals.total_runs} completed runs analyzed &middot;
      last computed ${esc(generated)}`;
  }

  function renderMetricsGrid(data) {
    const grid = document.getElementById('metrics-grid');
    if (!grid) return;

    const cards = [
      {
        label: 'Deployment Frequency',
        value: fmtPerWeek(data.deployment_frequency.per_week),
        detail: `${data.deployment_frequency.total_deploys} successful deploys over ${data.deployment_frequency.period_days} days`,
      },
      {
        label: 'Lead Time for Changes',
        value: fmtMinutes(data.lead_time_for_changes.avg_minutes),
        detail: `average, n=${data.lead_time_for_changes.sample_size} (commit → deploy start)`,
      },
      {
        label: 'Change Failure Rate',
        value: fmtPercent(data.change_failure_rate.percent),
        detail: `${data.change_failure_rate.failed} of ${data.change_failure_rate.total} completed runs failed`,
      },
      {
        label: 'Mean Time to Restore',
        value: fmtMinutes(data.mean_time_to_restore.avg_minutes),
        detail: `average, n=${data.mean_time_to_restore.sample_size} (failure → next success)`,
      },
    ];

    grid.innerHTML = cards
      .map(
        (c) => `
      <div class="metric-card">
        <div class="metric-label">${esc(c.label)}</div>
        <div class="metric-value">${esc(c.value)}</div>
        <div class="metric-detail">${esc(c.detail)}</div>
      </div>
    `
      )
      .join('');
  }

  function renderRecentRuns(data) {
    const container = document.getElementById('recent-runs-table');
    if (!container || !Array.isArray(data.recent_runs)) return;

    if (data.recent_runs.length === 0) {
      container.innerHTML = '<p>No completed runs yet.</p>';
      return;
    }

    const rows = data.recent_runs
      .map((r) => {
        const when = new Date(r.created_at).toLocaleString();
        const status = r.conclusion === 'success' ? '✅ success' : `❌ ${esc(r.conclusion)}`;
        return `
        <tr>
          <td><code>${esc(r.sha)}</code></td>
          <td>${esc(when)}</td>
          <td>${status}</td>
          <td>${esc(r.duration_minutes)} min</td>
          <td><a href="${esc(r.html_url)}" target="_blank" rel="noopener noreferrer">view run</a></td>
        </tr>
      `;
      })
      .join('');

    container.innerHTML = `
      <table class="runs-table">
        <thead>
          <tr><th>Commit</th><th>Started</th><th>Result</th><th>Duration</th><th></th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  function render(data) {
    renderMeta(data);
    renderMetricsGrid(data);
    renderRecentRuns(data);
  }

  fetch('dora-metrics.json')
    .then(function (res) {
      if (!res.ok) throw new Error('Failed to load DORA metrics: ' + res.status);
      return res.json();
    })
    .then(render)
    .catch(function (err) {
      console.error('DORA metrics could not be loaded.', err);
      const meta = document.getElementById('scorecard-meta');
      if (meta) meta.textContent = 'Metrics data is not available yet.';
    });
}());
