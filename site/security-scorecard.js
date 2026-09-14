/**
 * security-scorecard.js — Renders site/security-scorecard.json.
 *
 * Same "content as data" pattern as dora-metrics.js: vanilla JS, no build
 * step. The data file is produced by a separate scheduled GitHub Actions
 * workflow (.github/workflows/security-scorecard.yml).
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

  function renderCards(containerId, cards) {
    const grid = document.getElementById(containerId);
    if (!grid) return;
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

  function renderMeta(data) {
    const el = document.getElementById('scorecard-meta');
    if (!el) return;
    const generated = new Date(data.generated_at).toLocaleString();
    el.innerHTML = `Source: <code>${esc(data.repo)}</code> &middot; last computed ${esc(generated)}`;
  }

  function renderCodeScanning(data) {
    const cs = data.code_scanning;
    if (!cs) {
      renderCards('code-scanning-grid', [
        { label: 'Open Alerts', value: '—', detail: 'No code scanning data available yet' },
      ]);
      return;
    }
    const last = cs.last_analysis;
    renderCards('code-scanning-grid', [
      { label: 'Open Alerts (error)', value: cs.open_alerts.error, detail: 'CodeQL rule severity: error' },
      { label: 'Open Alerts (warning)', value: cs.open_alerts.warning, detail: 'CodeQL rule severity: warning' },
      { label: 'Open Alerts (note)', value: cs.open_alerts.note, detail: 'CodeQL rule severity: note' },
      {
        label: 'Last Scan',
        value: last ? new Date(last.created_at).toLocaleDateString() : '—',
        detail: last ? `commit ${last.commit_sha}` : 'No completed analysis yet',
      },
    ]);
  }

  function renderDependabot(data) {
    const db = data.dependabot;
    if (!db) {
      renderCards('dependabot-grid', [
        { label: 'Dependabot PRs', value: '—', detail: 'No data available yet' },
      ]);
      return;
    }
    renderCards('dependabot-grid', [
      { label: 'PRs Opened (all time)', value: db.prs_opened_total, detail: 'Dependency-update PRs authored by dependabot[bot]' },
      { label: 'PRs Merged (last 90 days)', value: db.prs_merged_last_90_days, detail: 'Evidence Dependabot updates are actually being merged' },
    ]);
  }

  function renderNpmAudit(data) {
    const audit = data.npm_audit;
    if (!audit) {
      renderCards('npm-audit-grid', [
        { label: 'npm audit', value: '—', detail: 'No audit report available yet' },
      ]);
      return;
    }
    const v = audit.vulnerabilities;
    renderCards('npm-audit-grid', [
      { label: 'Critical', value: v.critical, detail: `Gate: --audit-level=${audit.gate_level}` },
      { label: 'High', value: v.high, detail: 'infra/ dependency tree' },
      { label: 'Moderate', value: v.moderate, detail: 'infra/ dependency tree' },
      { label: 'Low / Info', value: v.low + v.info, detail: 'infra/ dependency tree' },
      { label: 'CI Gate Status', value: audit.gate_passes ? '✅ passing' : '❌ failing', detail: `Would fail cdk-diff.yml/deploy.yml at --audit-level=${audit.gate_level}` },
    ]);
  }

  function render(data) {
    renderMeta(data);
    renderCodeScanning(data);
    renderDependabot(data);
    renderNpmAudit(data);
  }

  fetch('security-scorecard.json')
    .then(function (res) {
      if (!res.ok) throw new Error('Failed to load security scorecard: ' + res.status);
      return res.json();
    })
    .then(render)
    .catch(function (err) {
      console.error('Security scorecard could not be loaded.', err);
      const meta = document.getElementById('scorecard-meta');
      if (meta) meta.textContent = 'Scorecard data is not available yet.';
    });
}());
