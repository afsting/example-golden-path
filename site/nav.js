// Shared global (top-level) navigation, rendered identically into every
// page's `#global-nav` mount point (inside the header) so feature nav only
// needs to change in one place. Page-specific sub-navigation (in-page
// section jump links) is rendered as a fixed left-edge `.side-nav` and
// stays hardcoded in each page's own HTML, since it's unique to that page
// anyway.
(function () {
  'use strict';

  var GLOBAL_NAV = [
    { page: 'resume', href: 'index.html', label: 'Resume' },
    { page: 'dora-metrics', href: 'dora-metrics.html', label: 'DORA Metrics' },
    { page: 'security-scorecard', href: 'security-scorecard.html', label: 'Security Scorecard' },
    { page: '100-day-plan', href: '100-day-plan.html', label: '100-Day Plan' },
    { page: 'engineering-enablement', href: 'engineering-enablement.html', label: 'Engineering Enablement' },
    { page: 'how-it-was-built', href: 'how-it-was-built.html', label: 'How This Was Built' },
  ];

  var currentPage = document.body.getAttribute('data-page');

  function navItem(item) {
    var li = document.createElement('li');
    var a = document.createElement('a');
    a.href = item.href;
    a.textContent = item.label;
    if (item.page === currentPage) {
      a.setAttribute('aria-current', 'page');
    }
    li.appendChild(a);
    return li;
  }

  function renderGlobalNav() {
    var mount = document.getElementById('global-nav');
    if (!mount) return null;

    var ul = document.createElement('ul');
    GLOBAL_NAV.forEach(function (item) {
      ul.appendChild(navItem(item));
    });

    mount.appendChild(ul);
    return ul;
  }

  // Shows "Logged in as <email>" + a Log out button in the header's
  // upper-left corner, and appends the Admin nav link when the session
  // carries the admin claim. The session cookie is HttpOnly (unreadable
  // from JS), so this asks the server for the signed session's identity
  // rather than trusting anything stored client-side. Showing the link is
  // a UI convenience only, not a security boundary — the /admin API
  // re-checks the signed session cookie server-side regardless.
  function renderSessionBar(navList) {
    var globalNavMount = document.getElementById('global-nav');
    if (!globalNavMount || !globalNavMount.parentNode) return;

    var bar = document.createElement('div');
    bar.className = 'session-bar';
    globalNavMount.parentNode.insertBefore(bar, globalNavMount.parentNode.firstChild);

    fetch('/auth/session', { credentials: 'same-origin' })
      .then(function (response) { return response.json(); })
      .then(function (data) {
        if (!data || !data.authenticated) {
          bar.remove();
          return;
        }

        if (data.admin && navList) {
          navList.appendChild(navItem({ page: 'admin', href: 'admin.html', label: 'Admin' }));
        }

        var emailSpan = document.createElement('span');
        emailSpan.className = 'session-bar-email';
        emailSpan.textContent = 'Logged in as ' + data.email;

        var logoutBtn = document.createElement('button');
        logoutBtn.type = 'button';
        logoutBtn.className = 'session-bar-logout';
        logoutBtn.textContent = 'Log out';
        logoutBtn.addEventListener('click', function () {
          logoutBtn.disabled = true;
          fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' })
            .catch(function () { /* cookie clear is best-effort; still redirect */ })
            .then(function () {
              window.location.href = '/login.html';
            });
        });

        bar.appendChild(emailSpan);
        bar.appendChild(logoutBtn);
      })
      .catch(function () { bar.remove(); });
  }

  renderSessionBar(renderGlobalNav());
})();
