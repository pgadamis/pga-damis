/**
 * public/js/research-survey.js — Student Residents Questionnaire (Step 5)
 *
 * Renders the ISO/IEC 25010 end-user evaluation instrument into
 * #research-survey-container inside registration Step 5, validates that every
 * statement is answered, and POSTs the answers to /api/research/survey.
 *
 * Contract used by auth.js -> completeRegistration():
 *   ResearchSurvey.validate()  -> { ok: boolean, message?: string }
 *                                 (scrolls to + highlights the first gap on failure)
 *   ResearchSurvey.submit()    -> Promise<{ ok: boolean, message?: string }>
 *   ResearchSurvey.isReady()   -> boolean  (questionnaire fetched and rendered)
 *
 * The questionnaire text is NOT duplicated here — it is fetched from
 * /api/research/questionnaire so utils/researchSurvey.js stays the single
 * source of truth for item wording, scale and version.
 */

'use strict';

window.ResearchSurvey = (function () {

  var CONTAINER_ID = 'research-survey-container';

  var spec        = null;   // questionnaire payload from the server
  var loadFailed  = false;
  var submitted   = false;  // already accepted by the server in this page session

  function el(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ═══════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════

  function renderScaleLegend() {
    var cells = spec.scale.map(function (s) {
      return '<div class="flex flex-col items-center leading-tight">' +
               '<span class="font-extrabold text-slate-600 dark:text-slate-200">' + s.value + '</span>' +
               '<span class="text-[10px] text-slate-400">' + esc(s.short) + '</span>' +
             '</div>';
    }).join('');

    return '' +
      '<div class="rs-legend sticky top-0 z-10 -mx-1 px-3 py-2 mb-3 rounded-xl bg-slate-100/95 dark:bg-slate-800/95 backdrop-blur border border-slate-200 dark:border-slate-700">' +
        '<div class="flex items-center justify-between gap-3">' +
          '<p class="text-[10px] font-bold uppercase tracking-wider text-slate-400 flex-shrink-0">Rating</p>' +
          '<div class="grid grid-cols-5 gap-1 flex-1 max-w-[220px] text-xs text-center">' + cells + '</div>' +
        '</div>' +
        '<p class="text-[10px] text-slate-400 mt-1 text-right">1 = Strongly Disagree &nbsp;·&nbsp; 5 = Strongly Agree</p>' +
      '</div>';
  }

  function renderItem(item, number) {
    var opts = spec.scale.map(function (s) {
      return '' +
        '<label class="rs-opt" title="' + esc(s.label) + '">' +
          '<input type="radio" name="rs-' + item.code + '" value="' + s.value + '" class="sr-only" ' +
                 'onchange="ResearchSurvey._onAnswer(\'' + item.code + '\')"/>' +
          '<span class="rs-opt-num">' + s.value + '</span>' +
          '<span class="rs-opt-lbl">' + esc(s.short) + '</span>' +
        '</label>';
    }).join('');

    return '' +
      '<div class="rs-item" id="rs-item-' + item.code + '" data-item="' + item.code + '">' +
        '<p class="rs-item-text">' +
          '<span class="text-slate-400 font-bold mr-1">' + number + '.</span>' + esc(item.text) +
        '</p>' +
        '<div class="rs-opts grid grid-cols-5 gap-1.5">' + opts + '</div>' +
      '</div>';
  }

  function render() {
    var box = el(CONTAINER_ID);
    if (!box) return;

    if (loadFailed || !spec) {
      box.innerHTML = '' +
        '<div class="p-4 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-xs text-amber-700 dark:text-amber-300 flex items-start gap-2">' +
          '<i class="fa-solid fa-triangle-exclamation mt-0.5 flex-shrink-0"></i>' +
          '<span><strong>Questionnaire could not be loaded.</strong> Please check your connection and ' +
          '<button type="button" onclick="ResearchSurvey.reload()" class="underline font-bold">try again</button>. ' +
          'You need to answer it before submitting your application.</span>' +
        '</div>';
      return;
    }

    var itemNo = 0;
    var sections = spec.characteristics.map(function (ch) {
      var items = ch.items.map(function (it) {
        itemNo++;
        return renderItem(it, itemNo);
      }).join('');

      return '' +
        '<div class="rs-section">' +
          '<div class="rs-section-head">' +
            '<span class="rs-section-code">' + esc(ch.code) + '</span>' +
            '<div class="min-w-0">' +
              '<p class="rs-section-title">' + esc(ch.name) + '</p>' +
              '<p class="rs-section-desc">' + esc(ch.description) + '</p>' +
            '</div>' +
          '</div>' +
          items +
        '</div>';
    }).join('');

    box.innerHTML = '' +
      '<div class="rs-wrap">' +

        // ── Header ──
        '<div class="flex items-start gap-2 mb-3">' +
          '<div class="w-7 h-7 rounded-lg bg-purple-100 dark:bg-purple-900/40 flex items-center justify-center flex-shrink-0">' +
            '<i class="fa-solid fa-clipboard-question text-purple-500 text-sm"></i>' +
          '</div>' +
          '<div class="min-w-0">' +
            '<p class="text-sm font-extrabold text-slate-600 dark:text-slate-200 uppercase tracking-wider">' + esc(spec.title) + ' <span class="text-red-400">*</span></p>' +
            '<p class="text-xs text-slate-400">' + esc(spec.subtitle) + '</p>' +
          '</div>' +
        '</div>' +

        // ── Consent ──
        '<div class="rs-consent">' +
          '<p class="text-xs text-slate-500 dark:text-slate-400 leading-relaxed mb-2">' + esc(spec.consentStatement) + '</p>' +
          '<label class="flex items-start gap-2.5 cursor-pointer">' +
            '<input id="rs-consent" type="checkbox" class="mt-0.5 w-4 h-4 accent-purple-600 flex-shrink-0" onchange="ResearchSurvey._onConsent()"/>' +
            '<span class="text-xs font-semibold text-slate-600 dark:text-slate-300 leading-relaxed">' + esc(spec.consentLabel) + '</span>' +
          '</label>' +
        '</div>' +

        // ── Items (hidden until consent, per the study's ethics requirement) ──
        '<div id="rs-body" class="hidden">' +
          renderScaleLegend() +
          sections +

          '<div class="mt-3">' +
            '<label class="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5" for="rs-comments">' +
              esc(spec.commentPrompt) +
            '</label>' +
            '<textarea id="rs-comments" rows="3" maxlength="1000" placeholder="Optional — tell us what worked well or what was confusing."' +
              ' class="form-input w-full px-3 py-2.5 rounded-xl border border-slate-200 dark:border-slate-600 bg-slate-50 dark:bg-slate-800 text-sm text-slate-700 dark:text-slate-100 placeholder:text-slate-300 resize-y"></textarea>' +
          '</div>' +
        '</div>' +

        // ── Progress ──
        '<div class="rs-progress">' +
          '<div class="flex items-center justify-between text-xs mb-1.5">' +
            '<span class="font-semibold text-slate-500 dark:text-slate-400">Questionnaire progress</span>' +
            '<span id="rs-count" class="font-extrabold text-slate-600 dark:text-slate-200 tabular-nums">0 / ' + spec.itemCount + '</span>' +
          '</div>' +
          '<div class="h-1.5 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">' +
            '<div id="rs-bar" class="h-full rounded-full bg-purple-500 transition-all" style="width:0%"></div>' +
          '</div>' +
          '<p id="rs-hint" class="text-xs text-slate-400 mt-1.5">Tick the consent box above to begin.</p>' +
        '</div>' +

      '</div>';

    updateProgress();
  }

  // ═══════════════════════════════════════════════════
  // STATE / PROGRESS
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
      var checked = document.querySelector('input[name="rs-' + code + '"]:checked');
      if (checked) out[code] = parseInt(checked.value, 10);
    });
    return out;
  }

  function consentGiven() {
    var c = el('rs-consent');
    return !!(c && c.checked);
  }

  function updateProgress() {
    if (!spec) return;
    var total    = spec.itemCount;
    var answered = Object.keys(collectAnswers()).length;

    var countEl = el('rs-count');
    var barEl   = el('rs-bar');
    var hintEl  = el('rs-hint');

    if (countEl) countEl.textContent = answered + ' / ' + total;
    if (barEl)   barEl.style.width = (total ? (answered / total * 100) : 0) + '%';

    if (hintEl) {
      if (!consentGiven()) {
        hintEl.textContent = 'Tick the consent box above to begin.';
        hintEl.className = 'text-xs text-slate-400 mt-1.5';
      } else if (answered < total) {
        hintEl.textContent = (total - answered) + ' statement' + (total - answered === 1 ? '' : 's') + ' left to answer.';
        hintEl.className = 'text-xs text-slate-400 mt-1.5';
      } else {
        hintEl.textContent = 'All statements answered — thank you!';
        hintEl.className = 'text-xs text-green-500 font-semibold mt-1.5';
      }
    }
  }

  function clearHighlights() {
    var nodes = document.querySelectorAll('.rs-item.rs-missing');
    for (var i = 0; i < nodes.length; i++) nodes[i].classList.remove('rs-missing');
    var consent = el('rs-consent-box');
    if (consent) consent.classList.remove('rs-missing');
  }

  // ═══════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════

  function isReady() { return !!spec; }

  /** @returns {{ ok: boolean, message?: string }} */
  function validate() {
    clearHighlights();

    if (!spec) {
      return { ok: false, message: 'The Student Residents Questionnaire could not be loaded. Please reload the page and try again.' };
    }
    if (submitted) return { ok: true };

    if (!consentGiven()) {
      var box = document.querySelector('.rs-consent');
      if (box) {
        box.classList.add('rs-missing');
        box.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return { ok: false, message: 'Please read and consent to the Student Residents Questionnaire before submitting.' };
    }

    var answers = collectAnswers();
    var missing = allItemCodes().filter(function (c) { return !answers[c]; });

    if (missing.length) {
      missing.forEach(function (c) {
        var node = el('rs-item-' + c);
        if (node) node.classList.add('rs-missing');
      });
      var first = el('rs-item-' + missing[0]);
      if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return {
        ok: false,
        message: 'Please answer all ' + spec.itemCount + ' statements in the Student Residents Questionnaire — ' +
                 missing.length + ' still unanswered.',
      };
    }

    return { ok: true };
  }

  /**
   * POST the answers. Called by completeRegistration() BEFORE the registration
   * request, because the server derives the respondent's email from the
   * pendingRegistration session, which registration clears on success.
   *
   * @returns {Promise<{ ok: boolean, message?: string }>}
   */
  async function submit() {
    if (submitted) return { ok: true };

    var check = validate();
    if (!check.ok) return check;

    var nameParts = ['reg-fname', 'reg-mname', 'reg-lname'].map(function (id) {
      var n = el(id);
      return n ? n.value.trim() : '';
    }).filter(Boolean);

    var payload = {
      answers:      collectAnswers(),
      comments:     (el('rs-comments') || {}).value || '',
      consentGiven: true,
      fullName:     nameParts.join(' '),
    };

    console.log('[Research] Submitting questionnaire — ' +
      Object.keys(payload.answers).length + '/' + spec.itemCount + ' items, ' +
      'comments=' + (payload.comments ? payload.comments.length + ' chars' : 'none'));

    try {
      var res  = await fetch('/api/research/survey', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      });
      var data = await res.json().catch(function () { return {}; });

      if (!res.ok) {
        console.error('[Research] Submission failed (' + res.status + '):', data.error || '(no error body)');
        return { ok: false, message: data.error || 'Could not save your questionnaire answers. Please try again.' };
      }

      submitted = true;
      console.log('[Research] Questionnaire saved ✅ overall mean=' + data.overallMean + ' (' + data.interpretation + ')');
      return { ok: true };

    } catch (e) {
      console.error('[Research] Submission network error:', e);
      return { ok: false, message: 'Network error while saving your questionnaire answers. Please check your connection and try again.' };
    }
  }

  // ── Internal event handlers (referenced from generated markup) ──────
  function _onAnswer(code) {
    var node = el('rs-item-' + code);
    if (node) node.classList.remove('rs-missing');
    updateProgress();
  }

  function _onConsent() {
    var body = el('rs-body');
    var box  = document.querySelector('.rs-consent');
    if (box) box.classList.remove('rs-missing');
    if (body) body.classList.toggle('hidden', !consentGiven());
    updateProgress();
  }

  // ═══════════════════════════════════════════════════
  // LOAD
  // ═══════════════════════════════════════════════════

  async function load() {
    try {
      var res  = await fetch('/api/research/questionnaire');
      var data = await res.json();
      if (!res.ok || !data.questionnaire) throw new Error(data.error || 'HTTP ' + res.status);
      spec       = data.questionnaire;
      loadFailed = false;
      console.log('[Research] Questionnaire loaded — ' + spec.itemCount + ' items, version ' + spec.instrumentVersion);
    } catch (e) {
      loadFailed = true;
      console.error('[Research] Could not load questionnaire:', e.message);
    }
    render();
  }

  function reload() {
    loadFailed = false;
    var box = el(CONTAINER_ID);
    if (box) box.innerHTML = '<div class="flex justify-center py-6"><span class="rs-spinner"></span></div>';
    load();
  }

  // Render eagerly at page load. The container lives inside #step-5, which is
  // hidden until the applicant gets there, so there is no visual cost and the
  // form is guaranteed to be ready the moment Step 5 appears.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load);
  } else {
    load();
  }

  return {
    isReady: isReady,
    validate: validate,
    submit: submit,
    reload: reload,
    _onAnswer: _onAnswer,
    _onConsent: _onConsent,
  };
})();
