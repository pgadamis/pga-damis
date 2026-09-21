/**
 * public/js/admin-research.js — Admin → Community → Research tab
 *
 * Renders the Student Residents Questionnaire results:
 *   1. Headline figures (respondent count, overall weighted mean, interpretation)
 *   2. Per-characteristic weighted means (the Chapter 4 summary table)
 *   3. Per-item frequency distribution + weighted mean (the Chapter 4 detail tables)
 *   4. Individual responses, with an anonymize toggle
 *   5. Open-ended comments
 *
 * Loaded as a separate script from admin.html so the 400 KB inline script does
 * not have to grow. It relies on these globals already defined there:
 *   escHtml(), toast(), setLoading(), exportToExcel(), exportToPDF(), fmtDateExact()
 */

'use strict';

(function () {

  var _stats      = null;
  var _responses  = [];
  var _anonymize  = true;   // default ON — the study reports responses anonymously
  var _loading    = false;

  function $id(id) { return document.getElementById(id); }

  function esc(s) {
    return (typeof escHtml === 'function')
      ? escHtml(s)
      : String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function notify(msg, type) {
    if (typeof toast === 'function') toast(msg, type || 'success');
    else console.log('[Research] ' + msg);
  }

  function when(d) {
    if (!d) return '—';
    if (typeof fmtDateExact === 'function') return fmtDateExact(d);
    return String(d);
  }

  function num(v, dash) {
    return (v === null || v === undefined || isNaN(v)) ? (dash || '—') : Number(v).toFixed(2);
  }

  /** Colour band matching the acceptability interpretation. */
  function badge(interpretation) {
    var map = {
      'Very Highly Acceptable': 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
      'Highly Acceptable':      'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
      'Moderately Acceptable':  'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
      'Slightly Acceptable':    'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
      'Not Acceptable':         'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
    };
    var cls = map[interpretation] || 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400';
    return '<span class="inline-block px-2 py-0.5 rounded-lg text-xs font-bold whitespace-nowrap ' + cls + '">' +
             esc(interpretation || '—') + '</span>';
  }

  function statusBadge(status) {
    var map = {
      approved:  'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
      pending:   'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
      rejected:  'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
      not_found: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
    };
    var label = status === 'not_found' ? 'no account' : (status || '—');
    var cls   = map[status] || map.not_found;
    return '<span class="inline-block px-2 py-0.5 rounded-lg text-xs font-semibold capitalize ' + cls + '">' +
             esc(label) + '</span>';
  }

  // ═══════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════

  function renderHeadline() {
    var box = $id('research-headline');
    if (!box || !_stats) return;

    var cards = [
      {
        label: 'Respondents',
        value: _stats.respondentCount,
        sub:   'student resident applicants',
        icon:  'fa-users',
        tone:  'from-brand-600 to-brand-700',
      },
      {
        label: 'Overall Weighted Mean',
        value: num(_stats.overallMean),
        sub:   _stats.overallInterpretation,
        icon:  'fa-square-root-variable',
        tone:  'from-purple-600 to-purple-700',
      },
      {
        label: 'Statements per Respondent',
        value: _stats.itemCount,
        sub:   _stats.characteristics.length + ' ISO/IEC 25010 characteristics',
        icon:  'fa-list-check',
        tone:  'from-slate-600 to-slate-700',
      },
      {
        label: 'With Comments',
        value: _stats.comments.length,
        sub:   'qualitative responses',
        icon:  'fa-comment-dots',
        tone:  'from-teal-600 to-teal-700',
      },
    ];

    box.innerHTML = cards.map(function (c) {
      return '' +
        '<div class="bg-gradient-to-br ' + c.tone + ' rounded-2xl p-5 text-white">' +
          '<div class="flex items-center justify-between mb-2">' +
            '<p class="text-xs font-semibold uppercase tracking-wider opacity-80">' + esc(c.label) + '</p>' +
            '<i class="fa-solid ' + c.icon + ' opacity-60"></i>' +
          '</div>' +
          '<p class="font-display font-bold text-3xl tabular-nums">' + esc(c.value) + '</p>' +
          '<p class="text-xs opacity-80 mt-0.5">' + esc(c.sub) + '</p>' +
        '</div>';
    }).join('');
  }

  function renderCharacteristics() {
    var box = $id('research-characteristics');
    if (!box || !_stats) return;

    if (!_stats.respondentCount) {
      box.innerHTML = '<div class="py-12 text-center text-sm text-slate-400">' +
        '<i class="fa-solid fa-clipboard-question text-3xl mb-3 block opacity-40"></i>' +
        'No questionnaire responses yet. Answers appear here as applicants submit Step 5 of the application.' +
        '</div>';
      return;
    }

    var rows = _stats.characteristics.map(function (ch, i) {
      return '' +
        '<tr class="border-t border-slate-100 dark:border-slate-800">' +
          '<td class="px-4 py-3 text-slate-400 tabular-nums">' + (i + 1) + '</td>' +
          '<td class="px-4 py-3">' +
            '<p class="font-semibold text-slate-700 dark:text-slate-200">' + esc(ch.name) + '</p>' +
            '<p class="text-xs text-slate-400">' + esc(ch.description) + '</p>' +
          '</td>' +
          '<td class="px-4 py-3 text-right font-bold tabular-nums text-slate-700 dark:text-slate-200">' + num(ch.mean) + '</td>' +
          '<td class="px-4 py-3">' + badge(ch.interpretation) + '</td>' +
        '</tr>';
    }).join('');

    box.innerHTML = '' +
      '<table class="w-full text-sm">' +
        '<thead><tr class="text-left text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wider">' +
          '<th class="px-4 py-3 font-semibold w-10">#</th>' +
          '<th class="px-4 py-3 font-semibold">ISO/IEC 25010 Characteristic</th>' +
          '<th class="px-4 py-3 font-semibold text-right">Weighted Mean</th>' +
          '<th class="px-4 py-3 font-semibold">Interpretation</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
        '<tfoot><tr class="border-t-2 border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60">' +
          '<td></td>' +
          '<td class="px-4 py-3 font-extrabold text-slate-700 dark:text-slate-200">Overall</td>' +
          '<td class="px-4 py-3 text-right font-extrabold tabular-nums text-slate-900 dark:text-slate-100">' + num(_stats.overallMean) + '</td>' +
          '<td class="px-4 py-3">' + badge(_stats.overallInterpretation) + '</td>' +
        '</tr></tfoot>' +
      '</table>';
  }

  function renderItems() {
    var box = $id('research-items');
    if (!box || !_stats) return;

    if (!_stats.respondentCount) { box.innerHTML = ''; return; }

    var html = _stats.characteristics.map(function (ch) {
      var rows = ch.items.map(function (it) {
        var f = it.frequency;
        return '' +
          '<tr class="border-t border-slate-100 dark:border-slate-800">' +
            '<td class="px-3 py-2.5 text-slate-700 dark:text-slate-300">' +
              '<span class="text-xs font-bold text-purple-500 mr-1.5">' + esc(it.code) + '</span>' + esc(it.text) +
            '</td>' +
            '<td class="px-2 py-2.5 text-center tabular-nums text-slate-500">' + f[5] + '</td>' +
            '<td class="px-2 py-2.5 text-center tabular-nums text-slate-500">' + f[4] + '</td>' +
            '<td class="px-2 py-2.5 text-center tabular-nums text-slate-500">' + f[3] + '</td>' +
            '<td class="px-2 py-2.5 text-center tabular-nums text-slate-500">' + f[2] + '</td>' +
            '<td class="px-2 py-2.5 text-center tabular-nums text-slate-500">' + f[1] + '</td>' +
            '<td class="px-3 py-2.5 text-right font-bold tabular-nums text-slate-700 dark:text-slate-200">' + num(it.mean) + '</td>' +
            '<td class="px-3 py-2.5">' + badge(it.interpretation) + '</td>' +
          '</tr>';
      }).join('');

      return '' +
        '<div class="mb-6">' +
          '<div class="flex items-center gap-2 mb-2">' +
            '<span class="px-2 py-0.5 rounded-lg bg-purple-100 dark:bg-purple-900/40 text-purple-600 dark:text-purple-300 text-xs font-extrabold">' + esc(ch.code) + '</span>' +
            '<h3 class="font-semibold text-slate-700 dark:text-slate-200 text-sm">' + esc(ch.name) + '</h3>' +
            '<span class="ml-auto text-xs text-slate-400">mean ' + num(ch.mean) + '</span>' +
          '</div>' +
          '<div class="overflow-x-auto rounded-xl border border-slate-100 dark:border-slate-800">' +
            '<table class="w-full text-sm min-w-[720px]">' +
              '<thead><tr class="text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wider bg-slate-50 dark:bg-slate-800/60">' +
                '<th class="px-3 py-2.5 font-semibold text-left">Statement</th>' +
                '<th class="px-2 py-2.5 font-semibold" title="Strongly Agree">5</th>' +
                '<th class="px-2 py-2.5 font-semibold" title="Agree">4</th>' +
                '<th class="px-2 py-2.5 font-semibold" title="Neutral">3</th>' +
                '<th class="px-2 py-2.5 font-semibold" title="Disagree">2</th>' +
                '<th class="px-2 py-2.5 font-semibold" title="Strongly Disagree">1</th>' +
                '<th class="px-3 py-2.5 font-semibold text-right">WM</th>' +
                '<th class="px-3 py-2.5 font-semibold text-left">Interpretation</th>' +
              '</tr></thead>' +
              '<tbody>' + rows + '</tbody>' +
            '</table>' +
          '</div>' +
        '</div>';
    }).join('');

    box.innerHTML = html;
  }

  function renderResponses() {
    var box = $id('research-responses');
    if (!box) return;

    if (!_responses.length) {
      box.innerHTML = '<div class="py-10 text-center text-sm text-slate-400">No individual responses yet.</div>';
      return;
    }

    var chCodes = (_stats ? _stats.characteristics : []).map(function (c) { return c.code; });

    var head = '' +
      '<tr class="text-left text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wider">' +
        '<th class="px-3 py-3 font-semibold">Respondent</th>' +
        '<th class="px-3 py-3 font-semibold">Application</th>' +
        chCodes.map(function (c) {
          return '<th class="px-2 py-3 font-semibold text-center" title="' + esc(c) + '">' + esc(c) + '</th>';
        }).join('') +
        '<th class="px-3 py-3 font-semibold text-right">Overall</th>' +
        '<th class="px-3 py-3 font-semibold">Interpretation</th>' +
        '<th class="px-3 py-3 font-semibold">Submitted</th>' +
      '</tr>';

    var rows = _responses.map(function (r) {
      var identity = _anonymize
        ? '<p class="font-semibold text-slate-700 dark:text-slate-200">' + esc(r.respondentLabel) + '</p>' +
          '<p class="text-xs text-slate-400">anonymized</p>'
        : '<p class="font-semibold text-slate-700 dark:text-slate-200">' + esc(r.fullName || '—') + '</p>' +
          '<p class="text-xs text-slate-400">' + esc(r.email) + '</p>';

      var context = [r.yearLevel, r.course].filter(Boolean).join(' · ');

      return '' +
        '<tr class="border-t border-slate-100 dark:border-slate-800 align-top">' +
          '<td class="px-3 py-3">' + identity + (r.corrupt ? '<p class="text-xs text-red-500 font-bold">⚠ unreadable answers</p>' : '') + '</td>' +
          '<td class="px-3 py-3">' + statusBadge(r.accountStatus) +
            (context ? '<p class="text-xs text-slate-400 mt-1">' + esc(context) + '</p>' : '') + '</td>' +
          chCodes.map(function (c) {
            return '<td class="px-2 py-3 text-center tabular-nums text-slate-500">' + num(r.means[c]) + '</td>';
          }).join('') +
          '<td class="px-3 py-3 text-right font-bold tabular-nums text-slate-700 dark:text-slate-200">' + num(r.overallMean) + '</td>' +
          '<td class="px-3 py-3">' + badge(r.interpretation) + '</td>' +
          '<td class="px-3 py-3 text-xs text-slate-400 whitespace-nowrap">' + esc(when(r.submittedAt)) + '</td>' +
        '</tr>';
    }).join('');

    box.innerHTML =
      '<table class="w-full text-sm min-w-[900px]">' +
        '<thead>' + head + '</thead><tbody>' + rows + '</tbody>' +
      '</table>';
  }

  function renderComments() {
    var box = $id('research-comments');
    if (!box || !_stats) return;

    if (!_stats.comments.length) {
      box.innerHTML = '<p class="text-sm text-slate-400 py-6 text-center">No written comments submitted yet.</p>';
      return;
    }

    box.innerHTML = _stats.comments.map(function (c) {
      return '' +
        '<div class="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-100 dark:border-slate-800 mb-2">' +
          '<p class="text-sm text-slate-600 dark:text-slate-300 leading-relaxed whitespace-pre-wrap">' + esc(c.text) + '</p>' +
          '<p class="text-xs text-slate-400 mt-1.5">' + esc(when(c.submittedAt)) + '</p>' +
        '</div>';
    }).join('');
  }

  function renderAnonToggle() {
    var btn   = $id('research-anon-toggle');
    var thumb = $id('research-anon-thumb');
    var desc  = $id('research-anon-desc');
    if (!btn || !thumb) return;

    btn.classList.toggle('bg-brand-600', _anonymize);
    btn.classList.toggle('bg-slate-200', !_anonymize);
    thumb.style.transform = _anonymize ? 'translateX(24px)' : 'translateX(0)';
    if (desc) {
      desc.textContent = _anonymize
        ? 'On — names and emails hidden (R1, R2 …)'
        : 'Off — identities visible';
    }
  }

  // ═══════════════════════════════════════════════════
  // LOAD
  // ═══════════════════════════════════════════════════

  async function loadResearchTab() {
    if (_loading) return;
    _loading = true;

    var chBox = $id('research-characteristics');
    if (chBox && typeof setLoading === 'function') setLoading(chBox);

    try {
      var results = await Promise.all([
        fetch('/api/admin/research/stats').then(function (r) { return r.json(); }),
        fetch('/api/admin/research/responses?anonymize=' + (_anonymize ? '1' : '0')).then(function (r) { return r.json(); }),
      ]);

      var statsRes = results[0], respRes = results[1];
      if (statsRes.error) throw new Error(statsRes.error);
      if (respRes.error)  throw new Error(respRes.error);

      _stats     = statsRes.stats;
      _responses = respRes.responses || [];

      console.log('[Research] Loaded — ' + _stats.respondentCount + ' respondent(s), overall mean ' +
                  _stats.overallMean + ' (' + _stats.overallInterpretation + '), instrument ' +
                  _stats.instrumentVersion);

      renderAnonToggle();
      renderHeadline();
      renderCharacteristics();
      renderItems();
      renderResponses();
      renderComments();

      var ver = $id('research-version');
      if (ver) ver.textContent = _stats.instrumentVersion;

    } catch (e) {
      console.error('[Research] Load failed:', e);
      notify('Could not load questionnaire results: ' + e.message, 'error');
      if (chBox) {
        chBox.innerHTML = '<div class="py-10 text-center text-sm text-red-500">' +
          '<i class="fa-solid fa-circle-exclamation mr-1"></i>Failed to load: ' + esc(e.message) + '</div>';
      }
    } finally {
      _loading = false;
    }
  }

  function toggleResearchAnonymize() {
    _anonymize = !_anonymize;
    renderAnonToggle();
    loadResearchTab();
  }

  // ═══════════════════════════════════════════════════
  // EXPORT
  // ═══════════════════════════════════════════════════

  /** Per-item table — the sheet that maps straight onto the Chapter 4 tables. */
  function researchItemRows() {
    if (!_stats) return [];
    var out = [];
    _stats.characteristics.forEach(function (ch) {
      ch.items.forEach(function (it) {
        out.push({
          'Characteristic': ch.name,
          'Code':           it.code,
          'Statement':      it.text,
          'SA (5)':         it.frequency[5],
          'A (4)':          it.frequency[4],
          'N (3)':          it.frequency[3],
          'D (2)':          it.frequency[2],
          'SD (1)':         it.frequency[1],
          'N':              it.responses,
          'Sum fx':         it.sumFx,
          'Weighted Mean':  it.mean,
          'Interpretation': it.interpretation,
        });
      });
      out.push({
        'Characteristic': ch.name,
        'Code':           '',
        'Statement':      'CHARACTERISTIC MEAN',
        'SA (5)': '', 'A (4)': '', 'N (3)': '', 'D (2)': '', 'SD (1)': '',
        'N':              ch.responses,
        'Sum fx':         '',
        'Weighted Mean':  ch.mean,
        'Interpretation': ch.interpretation,
      });
    });
    out.push({
      'Characteristic': 'OVERALL',
      'Code':           '',
      'Statement':      'OVERALL WEIGHTED MEAN',
      'SA (5)': '', 'A (4)': '', 'N (3)': '', 'D (2)': '', 'SD (1)': '',
      'N':              _stats.respondentCount,
      'Sum fx':         '',
      'Weighted Mean':  _stats.overallMean,
      'Interpretation': _stats.overallInterpretation,
    });
    return out;
  }

  function exportResearchExcel() {
    var rows = researchItemRows();
    if (!rows.length) { notify('No data to export', 'error'); return; }
    var headers = Object.keys(rows[0]);
    exportToExcel(rows, headers, 'DAMIS_Student_Residents_Questionnaire.xlsx', 'ISO25010 Results');
  }

  function exportResearchPDF() {
    if (!_stats || !_stats.respondentCount) { notify('No data to export', 'error'); return; }
    var rows = _stats.characteristics.map(function (ch) {
      return {
        characteristic: ch.name,
        mean:           num(ch.mean),
        interpretation: ch.interpretation,
      };
    });
    rows.push({ characteristic: 'OVERALL', mean: num(_stats.overallMean), interpretation: _stats.overallInterpretation });

    exportToPDF(
      rows,
      [
        { header: 'ISO/IEC 25010 Characteristic', dataKey: 'characteristic' },
        { header: 'Weighted Mean',                dataKey: 'mean' },
        { header: 'Interpretation',               dataKey: 'interpretation' },
      ],
      'DAMIS_Student_Residents_Questionnaire.pdf',
      'Level of Acceptability — Student Residents (n=' + _stats.respondentCount + ')'
    );
  }

  // Expose the handlers referenced from admin.html markup.
  window.loadResearchTab         = loadResearchTab;
  window.toggleResearchAnonymize = toggleResearchAnonymize;
  window.exportResearchExcel     = exportResearchExcel;
  window.exportResearchPDF       = exportResearchPDF;
})();
