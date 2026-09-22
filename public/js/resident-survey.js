/**
 * public/js/resident-survey.js — Student Residents Questionnaire (feed delivery)
 *
 * Replaces the old Step 5 mid-registration placement (see utils/researchSurvey.js
 * for the reasoning). This module:
 *   1. On feed load, asks the server whether this resident has already
 *      answered (GET /api/research/survey/status). If so, it does nothing —
 *      ever, on any device.
 *   2. If not answered, and not currently snoozed (a local, per-browser
 *      timestamp — "Later" hides the card for a few days), renders a small
 *      dismissible card into #resident-survey-card.
 *   3. "Later" snoozes. "Take the survey" opens a modal with the full
 *      instrument, fetched from /api/research/questionnaire so wording is
 *      never duplicated. Only a successful submission removes the card
 *      permanently (server-checked, not just client state).
 *
 * Contract used by feed.html:
 *   ResidentSurvey.init()  -> call once, after the resident's session is
 *                             confirmed (i.e. after GET /api/auth/me resolves).
 *                             Safe to call from an unauthenticated context too —
 *                             it no-ops if the status check 401s.
 */

'use strict';

window.ResidentSurvey = (function () {

  var CARD_ID       = 'resident-survey-card';
  var MODAL_ID       = 'resident-survey-modal';
  var SNOOZE_KEY      = 'damis_rsv_snooze_until';
  var SNOOZE_DAYS     = 3;

  var spec       = null;
  var loadFailed = false;
  var submitted  = false;

  function el(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function toast(msg, type) {
    if (typeof window.showToast === 'function') { window.showToast(msg, type); return; }
    console.log('[ResidentSurvey] ' + msg);
  }

  // ═══════════════════════════════════════════════════
  // STYLES (self-contained — feed.html doesn't load auth.css, which is
  // where the old .rs-* instrument styles lived)
  // ═══════════════════════════════════════════════════

  function injectStyles() {
    if (el('rsv-styles')) return;
    var style = document.createElement('style');
    style.id = 'rsv-styles';
    style.textContent = '' +
      '.rsv-card{display:flex;align-items:center;gap:12px;background:#fff;border:1px solid #ede9fe;border-radius:16px;padding:14px 16px;margin-bottom:16px;box-shadow:0 1px 2px rgba(0,0,0,.03)}' +
      'html.dark .rsv-card{background:#0f172a;border-color:#312e81}' +
      '.rsv-card-icon{width:36px;height:36px;border-radius:10px;background:#f3e8ff;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:#9333ea;font-size:15px}' +
      'html.dark .rsv-card-icon{background:rgba(147,51,234,.18)}' +
      '.rsv-card-title{font-weight:800;font-size:13px;color:#334155}' +
      'html.dark .rsv-card-title{color:#e2e8f0}' +
      '.rsv-card-sub{font-size:12px;color:#94a3b8}' +
      '.rsv-btn{font-size:12px;font-weight:700;padding:7px 14px;border-radius:10px;border:none;cursor:pointer;white-space:nowrap}' +
      '.rsv-btn-primary{background:#9333ea;color:#fff}' +
      '.rsv-btn-primary:hover{background:#7e22ce}' +
      '.rsv-btn-ghost{background:transparent;color:#94a3b8}' +
      '.rsv-btn-ghost:hover{color:#64748b}' +
      '.rsv-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);backdrop-filter:blur(2px);z-index:80;display:flex;align-items:flex-end;justify-content:center}' +
      '@media(min-width:640px){.rsv-modal-overlay{align-items:center}}' +
      '.rsv-modal{background:#fff;width:100%;max-width:560px;max-height:88vh;overflow-y:auto;border-radius:20px 20px 0 0;padding:20px}' +
      '@media(min-width:640px){.rsv-modal{border-radius:20px;padding:24px}}' +
      'html.dark .rsv-modal{background:#0f172a;color:#e2e8f0}' +
      '.rsv-consent{background:#f5f3ff;border:1px solid #ddd6fe;border-radius:12px;padding:12px;margin-bottom:12px}' +
      'html.dark .rsv-consent{background:#1e1b4b;border-color:#4338ca}' +
      '.rsv-consent.rsv-missing{border-color:#f43f5e;box-shadow:0 0 0 2px rgba(244,63,94,.15)}' +
      '.rsv-section{margin-bottom:16px}' +
      '.rsv-section-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}' +
      '.rsv-section-code{width:28px;height:28px;border-radius:8px;background:#f1f5f9;color:#64748b;font-size:11px;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0}' +
      'html.dark .rsv-section-code{background:#1e293b;color:#94a3b8}' +
      '.rsv-section-title{font-size:13px;font-weight:800;color:#334155}' +
      'html.dark .rsv-section-title{color:#e2e8f0}' +
      '.rsv-section-desc{font-size:11px;color:#94a3b8}' +
      '.rsv-item{padding:8px 0;border-top:1px solid #f1f5f9}' +
      'html.dark .rsv-item{border-color:#1e293b}' +
      '.rsv-item.rsv-missing{background:rgba(244,63,94,.06);border-radius:8px;padding:8px}' +
      '.rsv-item-text{font-size:12.5px;color:#475569;margin-bottom:6px;line-height:1.4}' +
      'html.dark .rsv-item-text{color:#cbd5e1}' +
      '.rsv-opts{display:grid;grid-template-columns:repeat(5,1fr);gap:6px}' +
      '.rsv-opt{display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 0;border-radius:8px;background:#f8fafc;cursor:pointer;border:1.5px solid transparent}' +
      'html.dark .rsv-opt{background:#1e293b}' +
      '.rsv-opt input:checked ~ .rsv-opt-num,.rsv-opt-selected .rsv-opt-num{color:#9333ea}' +
      '.rsv-opt-selected{border-color:#9333ea;background:#f5f3ff}' +
      'html.dark .rsv-opt-selected{background:rgba(147,51,234,.15)}' +
      '.rsv-opt-num{font-size:12px;font-weight:800;color:#64748b}' +
      '.rsv-opt-lbl{font-size:9px;color:#94a3b8}' +
      '.rsv-progress-bar{height:6px;border-radius:99px;background:#e2e8f0;overflow:hidden;margin-top:14px}' +
      'html.dark .rsv-progress-bar{background:#1e293b}' +
      '.rsv-progress-fill{height:100%;background:#9333ea;transition:width .2s}';
    document.head.appendChild(style);
  }

  // ═══════════════════════════════════════════════════
  // CARD
  // ═══════════════════════════════════════════════════

  function snoozedUntil() {
    var v = parseInt(localStorage.getItem(SNOOZE_KEY) || '0', 10);
    return Number.isFinite(v) ? v : 0;
  }

  function snooze() {
    localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_DAYS * 86400000));
    hideCard();
  }

  function hideCard() {
    var card = el(CARD_ID);
    if (card) card.innerHTML = '';
  }

  function renderCard() {
    var card = el(CARD_ID);
    if (!card) return;
    card.innerHTML = '' +
      '<div class="rsv-card">' +
        '<div class="rsv-card-icon"><i class="fa-solid fa-clipboard-question"></i></div>' +
        '<div class="flex-1 min-w-0">' +
          '<div class="rsv-card-title">Quick survey — help us improve PGA-DAMIS</div>' +
          '<div class="rsv-card-sub">18 short statements, about 2 minutes. For an undergraduate capstone study.</div>' +
        '</div>' +
        '<button type="button" class="rsv-btn rsv-btn-primary" onclick="ResidentSurvey.open()">Start</button>' +
        '<button type="button" class="rsv-btn rsv-btn-ghost" onclick="ResidentSurvey.snoozeLater()" title="Remind me later">Later</button>' +
      '</div>';
  }

  // ═══════════════════════════════════════════════════
  // MODAL / INSTRUMENT
  // ═══════════════════════════════════════════════════

  function allItemCodes() {
    if (!spec) return [];
    return spec.characteristics.reduce(function (acc, ch) {
      return acc.concat(ch.items.map(function (it) { return it.code; }));
    }, []);
  }

  function collectAnswers() {
    var out = {};
    allItemCodes().forEach(function (code) {
      var checked = document.querySelector('input[name="rsv-' + code + '"]:checked');
      if (checked) out[code] = parseInt(checked.value, 10);
    });
    return out;
  }

  function consentGiven() {
    var c = el('rsv-consent');
    return !!(c && c.checked);
  }

  function updateProgress() {
    if (!spec) return;
    var total    = spec.itemCount;
    var answered = Object.keys(collectAnswers()).length;
    var bar  = el('rsv-bar');
    var cnt  = el('rsv-count');
    var hint = el('rsv-hint');
    if (bar) bar.style.width = (total ? (answered / total * 100) : 0) + '%';
    if (cnt) cnt.textContent = answered + ' / ' + total;
    if (hint) {
      if (!consentGiven()) {
        hint.textContent = 'Tick the consent box above to begin.';
      } else if (answered < total) {
        hint.textContent = (total - answered) + ' statement' + (total - answered === 1 ? '' : 's') + ' left.';
      } else {
        hint.textContent = 'All statements answered — thank you!';
      }
    }
  }

  function renderScaleLegend() {
    var cells = spec.scale.map(function (s) {
      return '<div style="text-align:center"><div style="font-weight:800;font-size:11px;color:#64748b">' + s.value + '</div>' +
        '<div style="font-size:9px;color:#94a3b8">' + esc(s.short) + '</div></div>';
    }).join('');
    return '<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:4px;margin:10px 0;padding:8px;background:#f8fafc;border-radius:10px">' + cells + '</div>';
  }

  function renderItem(item, n) {
    var opts = spec.scale.map(function (s) {
      return '<label class="rsv-opt" onclick="ResidentSurvey._onAnswer(\'' + item.code + '\')">' +
        '<input type="radio" name="rsv-' + item.code + '" value="' + s.value + '" class="sr-only" style="position:absolute;opacity:0"/>' +
        '<span class="rsv-opt-num">' + s.value + '</span><span class="rsv-opt-lbl">' + esc(s.short) + '</span>' +
        '</label>';
    }).join('');
    return '<div class="rsv-item" id="rsv-item-' + item.code + '" data-item="' + item.code + '">' +
      '<p class="rsv-item-text"><span style="color:#cbd5e1;font-weight:800;margin-right:4px">' + n + '.</span>' + esc(item.text) + '</p>' +
      '<div class="rsv-opts">' + opts + '</div></div>';
  }

  function renderModalBody() {
    if (loadFailed || !spec) {
      return '<div style="padding:16px;text-align:center;font-size:13px;color:#f43f5e">' +
        'Could not load the questionnaire. <button type="button" onclick="ResidentSurvey._reload()" style="text-decoration:underline;font-weight:700">Try again</button>' +
        '</div>';
    }
    var n = 0;
    var sections = spec.characteristics.map(function (ch) {
      var items = ch.items.map(function (it) { n++; return renderItem(it, n); }).join('');
      return '<div class="rsv-section"><div class="rsv-section-head">' +
        '<div class="rsv-section-code">' + esc(ch.code) + '</div>' +
        '<div><div class="rsv-section-title">' + esc(ch.name) + '</div><div class="rsv-section-desc">' + esc(ch.description) + '</div></div>' +
        '</div>' + items + '</div>';
    }).join('');

    return '' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">' +
        '<div><div style="font-weight:800;font-size:14px">' + esc(spec.title) + '</div>' +
        '<div style="font-size:11px;color:#94a3b8">' + esc(spec.subtitle) + '</div></div>' +
        '<button type="button" onclick="ResidentSurvey.close()" style="color:#94a3b8;font-size:16px;padding:4px"><i class="fa-solid fa-xmark"></i></button>' +
      '</div>' +
      '<div class="rsv-consent" id="rsv-consent-box">' +
        '<p style="font-size:11px;color:#64748b;line-height:1.5;margin-bottom:8px">' + esc(spec.consentStatement) + '</p>' +
        '<label style="display:flex;gap:8px;align-items:flex-start;cursor:pointer">' +
          '<input id="rsv-consent" type="checkbox" style="margin-top:2px" onchange="ResidentSurvey._onConsent()"/>' +
          '<span style="font-size:11px;font-weight:700;color:#475569">' + esc(spec.consentLabel) + '</span>' +
        '</label>' +
      '</div>' +
      '<div id="rsv-body" style="display:none">' +
        renderScaleLegend() + sections +
        '<label style="display:block;font-size:11px;font-weight:700;color:#475569;margin-bottom:4px">' + esc(spec.commentPrompt) + '</label>' +
        '<textarea id="rsv-comments" rows="3" maxlength="1000" placeholder="Optional — tell us what worked well or what was confusing." ' +
          'style="width:100%;padding:8px 10px;border-radius:10px;border:1px solid #e2e8f0;font-size:12px;resize:vertical"></textarea>' +
      '</div>' +
      '<div style="margin-top:12px">' +
        '<div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:4px">' +
          '<span style="color:#94a3b8;font-weight:700">Progress</span><span id="rsv-count" style="font-weight:800">0 / ' + spec.itemCount + '</span>' +
        '</div>' +
        '<div class="rsv-progress-bar"><div id="rsv-bar" class="rsv-progress-fill" style="width:0%"></div></div>' +
        '<p id="rsv-hint" style="font-size:11px;color:#94a3b8;margin-top:6px">Tick the consent box above to begin.</p>' +
        '<button type="button" id="rsv-submit-btn" onclick="ResidentSurvey.submit()" class="rsv-btn rsv-btn-primary" style="width:100%;padding:10px;margin-top:10px;font-size:13px">Submit</button>' +
      '</div>';
  }

  function renderModal() {
    var host = el(MODAL_ID);
    if (!host) return;
    host.innerHTML = '<div class="rsv-modal-overlay" id="rsv-overlay"><div class="rsv-modal">' + renderModalBody() + '</div></div>';
    var overlay = el('rsv-overlay');
    if (overlay) overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    updateProgress();
  }

  async function ensureSpec() {
    if (spec || loadFailed) return;
    try {
      var res  = await fetch('/api/research/questionnaire');
      var data = await res.json();
      if (!res.ok || !data.questionnaire) throw new Error(data.error || 'HTTP ' + res.status);
      spec = data.questionnaire;
    } catch (e) {
      loadFailed = true;
      console.error('[ResidentSurvey] Could not load questionnaire:', e.message);
    }
  }

  async function open() {
    injectStyles();
    if (!el(MODAL_ID)) return;
    await ensureSpec();
    renderModal();
    document.body.style.overflow = 'hidden';
  }

  function close() {
    var host = el(MODAL_ID);
    if (host) host.innerHTML = '';
    document.body.style.overflow = '';
  }

  async function reload() {
    loadFailed = false;
    spec = null;
    await ensureSpec();
    renderModal();
  }

  function _onAnswer(code) {
    var item = el('rsv-item-' + code);
    if (item) item.classList.remove('rsv-missing');
    var opts = item ? item.querySelectorAll('.rsv-opt') : [];
    for (var i = 0; i < opts.length; i++) {
      opts[i].classList.toggle('rsv-opt-selected', opts[i].querySelector('input').checked);
    }
    updateProgress();
  }

  function _onConsent() {
    var box  = el('rsv-consent-box');
    var body = el('rsv-body');
    if (box) box.classList.remove('rsv-missing');
    if (body) body.style.display = consentGiven() ? 'block' : 'none';
    updateProgress();
  }

  async function submit() {
    if (!spec) return;

    if (!consentGiven()) {
      var box = el('rsv-consent-box');
      if (box) { box.classList.add('rsv-missing'); box.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
      toast('Please consent to the questionnaire before submitting.', 'error');
      return;
    }

    var answers = collectAnswers();
    var missing = allItemCodes().filter(function (c) { return !answers[c]; });
    if (missing.length) {
      missing.forEach(function (c) { var n = el('rsv-item-' + c); if (n) n.classList.add('rsv-missing'); });
      var first = el('rsv-item-' + missing[0]);
      if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
      toast('Please answer all ' + spec.itemCount + ' statements — ' + missing.length + ' left.', 'error');
      return;
    }

    var btn = el('rsv-submit-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; }

    try {
      var res = await fetch('/api/research/survey', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          answers:      answers,
          comments:     (el('rsv-comments') || {}).value || '',
          consentGiven: true,
        }),
      });
      var data = await res.json().catch(function () { return {}; });

      if (!res.ok) {
        toast(data.error || 'Could not save your answers. Please try again.', 'error');
        if (btn) { btn.disabled = false; btn.textContent = 'Submit'; }
        return;
      }

      submitted = true;
      localStorage.removeItem(SNOOZE_KEY);
      hideCard();
      close();
      toast('Thanks for helping evaluate PGA-DAMIS! 🎉', 'success');
    } catch (e) {
      console.error('[ResidentSurvey] Submit network error:', e);
      toast('Network error while saving your answers. Please try again.', 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Submit'; }
    }
  }

  // ═══════════════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════════════

  async function init() {
    if (!el(CARD_ID)) return; // page doesn't offer a slot — no-op

    try {
      var res  = await fetch('/api/research/survey/status');
      var data = await res.json();
      if (!res.ok) return; // not logged in, etc. — stay silent

      if (data.answered) {
        localStorage.removeItem(SNOOZE_KEY); // no reason to keep this around
        return;
      }

      if (Date.now() < snoozedUntil()) return; // still snoozed

      injectStyles();
      renderCard();
    } catch (e) {
      console.error('[ResidentSurvey] Status check failed:', e.message);
    }
  }

  return {
    init: init,
    open: open,
    close: close,
    submit: submit,
    snoozeLater: snooze,
    _onAnswer: _onAnswer,
    _onConsent: _onConsent,
    _reload: reload,
  };
})();
