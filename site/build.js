/**
 * build.js — Static site renderer for resume content.
 *
 * Reads content.json and populates the DOM.  This file is intentionally
 * vanilla JS (no build step required) so the site can be served directly
 * from S3/CloudFront without a bundler.
 *
 * Separation of content (content.json) from template (index.html + build.js)
 * mirrors the golden-path / "content as data" principle described in
 * how-it-was-built.html — updating the résumé means editing the JSON,
 * not touching HTML.
 */

(function () {
  'use strict';

  /** Safely escape text for innerHTML insertion */
  function esc(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderHeader(data) {
    const title = document.getElementById('site-title');
    if (title && data.title) title.textContent = data.title;
  }

  function renderSummary(data) {
    const el = document.getElementById('summary-text');
    if (el) el.textContent = data.summary || '';

    const bar = document.getElementById('contact-bar');
    if (bar) {
      const parts = [];
      if (data.email) {
        parts.push(`<a href="mailto:${esc(data.email)}" aria-label="Email Raymond Page">${esc(data.email)}</a>`);
      }
      if (data.linkedin) {
        parts.push(`<a href="${esc(data.linkedin)}" target="_blank" rel="noopener noreferrer" aria-label="LinkedIn profile">LinkedIn</a>`);
      }
      bar.innerHTML = parts.join('<span aria-hidden="true"> &middot; </span>');
    }

    const footerEmail = document.getElementById('footer-email');
    if (footerEmail && data.email) {
      footerEmail.href = `mailto:${esc(data.email)}`;
      footerEmail.textContent = data.email;
    }
  }

  function renderCompetencies(data) {
    const list = document.getElementById('competencies-list');
    if (!list || !Array.isArray(data.competencies)) return;
    list.innerHTML = data.competencies
      .map(c => `<li>${esc(c)}</li>`)
      .join('');
  }

  function renderHighlights(data) {
    const grid = document.getElementById('highlights-grid');
    if (!grid || !Array.isArray(data.highlights)) return;
    grid.innerHTML = data.highlights.map(h => `
      <div class="highlight-card">
        <h3>${esc(h.title)}</h3>
        <p>${esc(h.description)}</p>
      </div>
    `).join('');
  }

  function renderExperience(data) {
    const container = document.getElementById('experience-list');
    if (!container || !Array.isArray(data.experience)) return;

    container.innerHTML = data.experience.map(employer => {
      const rolesHtml = (employer.roles || []).map(role => {
        const dates = role.end
          ? `${esc(role.start)} – ${esc(role.end)}`
          : esc(role.start);
        const bullets = (role.bullets || []).map(b => `<li>${esc(b)}</li>`).join('');
        return `
          <div class="role-block">
            <div class="role-title">${esc(role.title)}</div>
            <div class="role-dates">${dates}</div>
            <ul>${bullets}</ul>
          </div>
        `;
      }).join('');

      return `
        <div class="employer-block">
          <span class="employer-name">${esc(employer.company)}</span>
          <span class="employer-location">${esc(employer.location)}</span>
          ${rolesHtml}
        </div>
      `;
    }).join('');
  }

  function renderEducation(data) {
    const container = document.getElementById('education-list');
    if (!container || !Array.isArray(data.education)) return;

    container.innerHTML = data.education.map(edu => `
      <div class="education-item">
        <h3>${esc(edu.degree)}${edu.field ? ' – ' + esc(edu.field) : ''}</h3>
        <p>${esc(edu.institution)}${edu.note ? ' &middot; ' + esc(edu.note) : ''}</p>
      </div>
    `).join('');
  }

  function render(data) {
    renderHeader(data);
    renderSummary(data);
    renderCompetencies(data);
    renderHighlights(data);
    renderExperience(data);
    renderEducation(data);
  }

  // Fetch content.json relative to this script
  fetch('content.json')
    .then(function (res) {
      if (!res.ok) throw new Error('Failed to load content: ' + res.status);
      return res.json();
    })
    .then(render)
    .catch(function (err) {
      console.error('Resume content could not be loaded.', err);
      // Degrade gracefully — static structure remains visible
    });
}());
