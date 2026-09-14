/**
 * catalog-render.js — Fetches this repo's own catalog-info.yaml straight
 * from GitHub (raw.githubusercontent.com) at page load and renders it
 * verbatim, so the "Golden-Path Demo" section shows a live artifact
 * rather than a pasted-in snapshot that can drift out of sync with the
 * real file.
 *
 * No YAML parsing — deliberately renders the raw text as-is. Parsing
 * would add a dependency for a static site with no build step, and the
 * point is just to prove the file is fetched live, not to reformat it.
 */

(function () {
  'use strict';

  var RAW_URL =
    'https://raw.githubusercontent.com/afsting/developer-experience-concepts/main/catalog-info.yaml';

  var el = document.getElementById('catalog-info-render');
  if (!el) return;

  fetch(RAW_URL)
    .then(function (res) {
      if (!res.ok) throw new Error('Failed to fetch catalog-info.yaml: ' + res.status);
      return res.text();
    })
    .then(function (text) {
      el.textContent = text;
    })
    .catch(function (err) {
      console.error('catalog-info.yaml could not be loaded.', err);
      el.textContent = 'Could not load catalog-info.yaml live — view it directly at github.com/afsting/developer-experience-concepts/blob/main/catalog-info.yaml';
    });
}());
