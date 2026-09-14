/**
 * engineering-enablement.js — Renders site/engineering-enablement.json.
 *
 * Same "content as data" pattern as build.js/dora-metrics.js: vanilla JS,
 * no build step, no framework.
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

  function renderFraming(data) {
    var el = document.getElementById('enablement-framing');
    if (el) el.textContent = data.framing;
  }

  function renderCaseStudy(data) {
    var el = document.getElementById('case-study');
    if (!el || !data.case_study) return;
    var cs = data.case_study;
    el.innerHTML =
      '<h3>' + esc(cs.name) + '</h3>' +
      '<p><strong>Problem:</strong> ' + esc(cs.problem) + '</p>' +
      '<p><strong>Approach:</strong> ' + esc(cs.approach) + '</p>' +
      '<p><strong>Outcome:</strong> ' + esc(cs.outcome) + '</p>';
  }

  function renderLearningPath(data) {
    var grid = document.getElementById('learning-path-grid');
    if (!grid || !Array.isArray(data.learning_path)) return;
    grid.innerHTML = data.learning_path.map(function (m) {
      return '<div class="highlight-card">' +
        '<h3>Module ' + esc(m.module) + ': ' + esc(m.title) + '</h3>' +
        '<p><em>' + esc(m.format) + '</em></p>' +
        (m.description ? '<p>' + esc(m.description) + '</p>' : '') +
        '</div>';
    }).join('');
  }

  function renderCadence(data) {
    var grid = document.getElementById('cadence-grid');
    if (!grid || !Array.isArray(data.cadence)) return;
    grid.innerHTML = data.cadence.map(function (c) {
      return '<div class="highlight-card">' +
        '<h3>' + esc(c.title) + '</h3>' +
        '<p>' + esc(c.description) + '</p>' +
        '</div>';
    }).join('');
  }

  function renderReinforcement(data) {
    var list = document.getElementById('reinforcement-list');
    if (!list || !Array.isArray(data.reinforcement)) return;
    list.innerHTML = data.reinforcement.map(function (item) {
      return '<li>' + esc(item) + '</li>';
    }).join('');
  }

  function render(data) {
    renderFraming(data);
    renderCaseStudy(data);
    renderLearningPath(data);
    renderCadence(data);
    renderReinforcement(data);
  }

  fetch('engineering-enablement.json')
    .then(function (res) {
      if (!res.ok) throw new Error('Failed to load enablement content: ' + res.status);
      return res.json();
    })
    .then(render)
    .catch(function (err) {
      console.error('Engineering enablement content could not be loaded.', err);
      var el = document.getElementById('enablement-framing');
      if (el) el.textContent = 'Content is not available right now.';
    });
}());
