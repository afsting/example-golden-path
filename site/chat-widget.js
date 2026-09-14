/**
 * chat-widget.js — sitewide, page-aware AI assistant applet.
 *
 * Vanilla JS, no framework/bundler (matches the rest of site/). Injects a
 * floating button + panel into every page that includes this script. Sends
 * `document.body.dataset.page` with each message so the backend can answer
 * grounded in whichever page the visitor is currently on (see
 * infra/lambda/chat/index.ts). Persists the conversation in sessionStorage
 * across page navigations, since this is a classic multi-page site (full
 * reloads between pages, not an SPA) — without that, the transcript would
 * reset on every click.
 */
(function () {
  'use strict';

  var PAGE_INFO = {
    resume: {
      name: 'the Résumé page',
      questions: [
        "What's Raymond's experience with developer experience and platform engineering?",
        'What technologies does he specialize in?',
        'Tell me about his leadership experience.',
      ],
    },
    'dora-metrics': {
      name: 'the DORA Metrics page',
      questions: [
        'What do these DORA metrics mean?',
        "What counts as a 'high performer' by DORA benchmarks?",
        'How is this data kept up to date?',
      ],
    },
    'security-scorecard': {
      name: 'the Security Scorecard page',
      questions: [
        'What security practices does this site demonstrate?',
        'How often is this scorecard updated?',
        'What would Raymond bring to a DevSecOps program?',
      ],
    },
    '100-day-plan': {
      name: 'the 100-Day Plan page',
      questions: [
        "What would Raymond focus on in his first 30 days?",
        'How does this plan address people leadership?',
        "What's his approach to stakeholder relationships?",
      ],
    },
    'engineering-enablement': {
      name: 'the Engineering Enablement page',
      questions: [
        'How does this program actually get adopted, not just launched?',
        "What's the office-hours/coaching cadence for?",
        'How does this map to the Community of Practice work?',
      ],
    },
    'how-it-was-built': {
      name: 'the How This Was Built page',
      questions: [
        'What was AI-assisted vs. human-reviewed in building this?',
        'Why was this architecture chosen?',
        "What does this demonstrate about Raymond's engineering practices?",
      ],
    },
  };

  var STORAGE_KEY = 'chatWidgetState';
  var SEEN_KEY = 'chatWidgetOpened';

  // Persisted across sessions (not sessionStorage) — once a visitor has
  // ever opened the widget, they know it's there; the attention glint
  // shouldn't come back on a later visit.
  function hasBeenOpened() {
    try {
      return window.localStorage.getItem(SEEN_KEY) === 'true';
    } catch (e) {
      return false;
    }
  }

  function markOpened() {
    try {
      window.localStorage.setItem(SEEN_KEY, 'true');
    } catch (e) {
      // localStorage unavailable — the glint will just replay next visit,
      // which is a harmless degradation.
    }
  }
  var currentPage = document.body.getAttribute('data-page') || '';
  var pageInfo = PAGE_INFO[currentPage] || { name: 'this site', questions: [] };

  function loadState() {
    try {
      var raw = window.sessionStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : { page: null, messages: [] };
    } catch (e) {
      return { page: null, messages: [] };
    }
  }

  function saveState(state) {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      // sessionStorage unavailable (private browsing, etc.) — degrade to
      // an in-memory-only conversation for this page load.
    }
  }

  var state = loadState();
  var pageChanged = state.page !== null && state.page !== currentPage;
  state.page = currentPage;

  // ---- DOM construction ----

  var toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'chat-widget-toggle';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', 'chat-widget-panel');
  toggle.textContent = 'Ask AI';
  if (!hasBeenOpened()) {
    toggle.classList.add('attention');
  }

  var panel = document.createElement('div');
  panel.className = 'chat-widget-panel';
  panel.id = 'chat-widget-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'AI assistant');
  panel.hidden = true;

  panel.innerHTML = [
    '<div class="chat-widget-header">',
    '<span>AI Assistant</span>',
    '<button type="button" class="chat-widget-close" aria-label="Close">&times;</button>',
    '</div>',
    '<p class="chat-widget-disclosure">I\'m an AI assistant, not Raymond himself — I answer from this site\'s published data.</p>',
    '<div class="chat-widget-messages" aria-live="polite"></div>',
    '<div class="chat-widget-chips"></div>',
    '<form class="chat-widget-form">',
    '<input type="text" class="chat-widget-input" placeholder="Ask a question…" aria-label="Your question" autocomplete="off" />',
    '<button type="submit" class="chat-widget-send">Send</button>',
    '</form>',
  ].join('');

  document.body.appendChild(toggle);
  document.body.appendChild(panel);

  var closeBtn = panel.querySelector('.chat-widget-close');
  var messagesEl = panel.querySelector('.chat-widget-messages');
  var chipsEl = panel.querySelector('.chat-widget-chips');
  var form = panel.querySelector('.chat-widget-form');
  var input = panel.querySelector('.chat-widget-input');

  function esc(str) {
    var div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  // Small hand-rolled markdown-to-HTML renderer for assistant replies —
  // the model (reasonably) formats answers with **bold**, lists, etc.,
  // and without this they render as literal asterisks/hashes. No external
  // markdown library (matches the site's dependency-free convention).
  // Safety: text is HTML-escaped via esc() FIRST, so it can no longer
  // contain a live `<`/`>`/`&` — every regex below only ever wraps that
  // already-escaped text in a small fixed set of hardcoded-safe tags
  // (strong/em/code/ul/ol/li/br), never anything from the model's own
  // output, so this stays just as safe against injection as plain
  // textContent would have been.
  function inlineMarkdown(s) {
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__(.+?)__/g, '<strong>$1</strong>');
    s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
    s = s.replace(/`(.+?)`/g, '<code>$1</code>');
    // [text](url) -- url is already HTML-escaped by esc(), and href values
    // can't execute script the way innerHTML content could.
    s = s.replace(/\[(.+?)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return s;
  }

  function renderMarkdown(text) {
    var lines = esc(text).split('\n');
    var html = '';
    var listTag = null; // 'ul' | 'ol' | null

    function closeList() {
      if (listTag) {
        html += '</' + listTag + '>';
        listTag = null;
      }
    }

    lines.forEach(function (rawLine) {
      var line = rawLine.trim();
      var bullet = /^[-*]\s+(.*)/.exec(line);
      var numbered = /^\d+\.\s+(.*)/.exec(line);
      var heading = /^#{1,6}\s+(.*)/.exec(line);

      if (bullet) {
        if (listTag !== 'ul') { closeList(); html += '<ul>'; listTag = 'ul'; }
        html += '<li>' + inlineMarkdown(bullet[1]) + '</li>';
        return;
      }
      if (numbered) {
        if (listTag !== 'ol') { closeList(); html += '<ol>'; listTag = 'ol'; }
        html += '<li>' + inlineMarkdown(numbered[1]) + '</li>';
        return;
      }
      closeList();

      if (heading) {
        html += '<strong class="chat-widget-heading">' + inlineMarkdown(heading[1]) + '</strong><br>';
      } else if (line === '') {
        html += '<br>';
      } else {
        html += inlineMarkdown(line) + '<br>';
      }
    });
    closeList();

    return html.replace(/(<br>\s*)+$/, '');
  }

  function appendMessage(role, text) {
    var msg = document.createElement('div');
    msg.className = 'chat-widget-msg chat-widget-msg-' + role;
    msg.innerHTML = role === 'assistant' ? renderMarkdown(text) : esc(text);
    messagesEl.appendChild(msg);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function appendNote(text) {
    var note = document.createElement('div');
    note.className = 'chat-widget-note';
    note.textContent = text;
    messagesEl.appendChild(note);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function renderChips() {
    chipsEl.innerHTML = '';
    if (state.messages.length > 0 || pageInfo.questions.length === 0) return;
    pageInfo.questions.forEach(function (q) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chat-widget-chip';
      chip.textContent = q;
      chip.addEventListener('click', function () {
        sendMessage(q);
      });
      chipsEl.appendChild(chip);
    });
  }

  function renderInitial() {
    messagesEl.innerHTML = '';
    if (state.messages.length === 0) {
      appendNote('I can see you\'re looking at ' + pageInfo.name + ' — ask me anything.');
    } else {
      state.messages.forEach(function (m) {
        appendMessage(m.role, m.text);
      });
      if (pageChanged) {
        appendNote('You\'re now viewing ' + pageInfo.name + '.');
      }
    }
    renderChips();
  }

  var sending = false;

  function sendMessage(text) {
    text = text.trim();
    if (!text || sending) return;

    appendMessage('user', text);
    state.messages.push({ role: 'user', text: text });
    chipsEl.innerHTML = '';
    saveState(state);

    sending = true;
    input.value = '';
    input.disabled = true;

    var thinking = document.createElement('div');
    thinking.className = 'chat-widget-msg chat-widget-msg-assistant chat-widget-thinking';
    thinking.textContent = 'Thinking…';
    messagesEl.appendChild(thinking);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    // Send the full conversation (state.messages already has the current
    // user turn pushed above), not just this one message -- otherwise the
    // assistant answers every turn in isolation with no memory of earlier
    // ones, which is especially jarring after a page refresh restores the
    // visible transcript but the model itself has no idea it happened.
    fetch('/api/chat', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: state.messages, page: currentPage }),
    })
      .then(function (res) {
        return res.json().then(function (data) {
          return { ok: res.ok, status: res.status, data: data };
        });
      })
      .then(function (result) {
        thinking.remove();
        var reply = result.data && (result.data.reply || result.data.message);
        if (!reply) reply = 'Sorry, something went wrong. Please try again.';
        appendMessage('assistant', reply);
        state.messages.push({ role: 'assistant', text: reply });
        saveState(state);
      })
      .catch(function () {
        thinking.remove();
        var errText = 'The assistant is unavailable right now. Please try again shortly.';
        appendMessage('assistant', errText);
        state.messages.push({ role: 'assistant', text: errText });
        saveState(state);
      })
      .finally(function () {
        sending = false;
        input.disabled = false;
        input.focus();
      });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    sendMessage(input.value);
  });

  function openPanel() {
    panel.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    toggle.classList.remove('attention');
    markOpened();
    input.focus();
    // The initial history replay (renderInitial, called at load time while
    // the panel is still hidden) sets scrollTop right after each message,
    // but a `display: none` element always reports scrollHeight as 0 — so
    // that scroll is a no-op, and reopening a panel with restored history
    // lands at the top instead of the most recent message. Re-apply it now
    // that the panel actually has a rendered, measurable height.
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function closePanel() {
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    toggle.focus();
  }

  toggle.addEventListener('click', function () {
    if (panel.hidden) {
      openPanel();
    } else {
      closePanel();
    }
  });
  closeBtn.addEventListener('click', closePanel);
  panel.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closePanel();
  });

  renderInitial();
  if (pageChanged) saveState(state);
}());
