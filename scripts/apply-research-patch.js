#!/usr/bin/env node
/**
 * scripts/apply-research-patch.js
 *
 * One-shot, idempotent patcher for the three files that are too large to hand
 * over in full (public/index.html 130 KB, public/js/auth.js 164 KB,
 * public/admin.html 434 KB).
 *
 * Run once from the project root:
 *     node scripts/apply-research-patch.js
 *
 * It makes exactly 8 insertions. Every insertion:
 *   - is skipped if its marker is already present (safe to re-run),
 *   - aborts the whole run if its anchor is missing or appears more than once,
 *   - writes a .bak copy of each file it touches on the first run.
 *
 * Nothing is deleted or rewritten — only inserted. Delete this script after
 * the changes are committed if you would rather not keep it around.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let applied = 0, skipped = 0;
const edits = [];   // queued so nothing is written until every anchor validates

/**
 * @param {string} file     path relative to the project root
 * @param {string} marker   unique string that exists only AFTER patching
 * @param {string} anchor   existing text to insert relative to (must be unique)
 * @param {'after'|'before'} where
 * @param {string} block    text to insert
 * @param {string} label    human-readable description
 */
function queue(file, marker, anchor, where, block, label) {
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) throw new Error(`${label}: file not found — ${file}`);

  const src = fs.readFileSync(full, 'utf8');

  if (src.includes(marker)) {
    console.log(`○ skip    ${label} (already applied)`);
    skipped++;
    return;
  }

  const hits = src.split(anchor).length - 1;
  if (hits !== 1) {
    throw new Error(
      `${label}: anchor matched ${hits} time(s) in ${file} — expected exactly 1.\n` +
      `  The file has diverged from the version this patch was written against.\n` +
      `  Apply this one by hand and re-run.`
    );
  }

  edits.push({ file, full, anchor, where, block, label });
}

function flush() {
  for (const e of edits) {
    const src = fs.readFileSync(e.full, 'utf8');
    const bak = e.full + '.bak';
    if (!fs.existsSync(bak)) fs.writeFileSync(bak, src);
    const out = e.where === 'after'
      ? src.replace(e.anchor, e.anchor + e.block)
      : src.replace(e.anchor, e.block + e.anchor);
    fs.writeFileSync(e.full, out);
    console.log(`✔ patch   ${e.label}`);
    applied++;
  }
}

// ══════════════════════════════════════════════════════════════════
// 1/8 — index.html: Spam / Junk folder notice on the Email OTP step
// ══════════════════════════════════════════════════════════════════
queue(
  'public/index.html',
  'Spam / Junk folder notice',
  `            <p class="text-slate-400 text-sm">We sent a <strong class="text-slate-600">6-digit code</strong> to<br/><span id="otp-email" class="text-blue-600 font-bold"></span></p>
          </div>`,
  'after',
  `

          <!-- ── Spam / Junk folder notice ── -->
          <div class="flex items-start gap-2 p-3 mb-4 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-xl text-xs text-amber-700 dark:text-amber-300 text-left">
            <i class="fa-solid fa-triangle-exclamation mt-0.5 flex-shrink-0"></i>
            <span>
              <strong>Can&rsquo;t find the email?</strong> Check your <strong>Spam</strong> or <strong>Junk</strong> folder &mdash;
              Gmail sometimes filters our verification emails. If you find it there, open it and tap
              <strong>&ldquo;Report not spam&rdquo;</strong> (or <strong>&ldquo;Not junk&rdquo;</strong>) so future PGA-DAMIS
              emails about your application arrive in your inbox.
            </span>
          </div>`,
  'index.html — OTP spam-folder notice'
);

// ══════════════════════════════════════════════════════════════════
// 2/8 — index.html: questionnaire container at the bottom of Step 5
// ══════════════════════════════════════════════════════════════════
queue(
  'public/index.html',
  'research-survey-container',
  `          <div class="bg-slate-50 dark:bg-slate-800/60 rounded-xl p-4 mb-5 space-y-3 border border-slate-100 dark:border-slate-700">`,
  'before',
  `          <!-- ── Student Residents Questionnaire (research instrument) ──
               Markup is generated at runtime by /js/research-survey.js from
               GET /api/research/questionnaire, so item wording lives in exactly
               one place (utils/researchSurvey.js). Must be completed before
               the application can be submitted. -->
          <div id="research-survey-container" class="mb-5">
            <div class="flex justify-center py-6"><span class="rs-spinner"></span></div>
          </div>

`,
  'index.html — questionnaire container (Step 5)'
);

// ══════════════════════════════════════════════════════════════════
// 3/8 — index.html: load the questionnaire front-end module
// ══════════════════════════════════════════════════════════════════
queue(
  'public/index.html',
  '/js/research-survey.js',
  `<script src="/js/auth.js"></script>`,
  'after',
  `
<script src="/js/research-survey.js"></script>`,
  'index.html — research-survey.js script tag'
);

// ══════════════════════════════════════════════════════════════════
// 4/8 — auth.js: block submit until the questionnaire is complete
// ══════════════════════════════════════════════════════════════════
queue(
  'public/js/auth.js',
  'ResearchSurvey.validate()',
  `  if (!$('chk-terms').checked) { showStepError(5, 'You must agree to the Terms & Conditions.'); return; }`,
  'after',
  `

  // ── Student Residents Questionnaire (research instrument) ──────────────
  // Every statement must be answered and consent given before the
  // application can be submitted. Guarded on window.ResearchSurvey so a
  // failure to load the module never hard-blocks a dormitory application.
  var rsCheck = window.ResearchSurvey ? window.ResearchSurvey.validate() : { ok: true };
  if (!rsCheck.ok) { showStepError(5, rsCheck.message); return; }`,
  'auth.js — questionnaire validation gate'
);

// ══════════════════════════════════════════════════════════════════
// 5/8 — auth.js: POST the questionnaire before the registration request
// ══════════════════════════════════════════════════════════════════
queue(
  'public/js/auth.js',
  'ResearchSurvey.submit()',
  `  var btn = $('btn-complete');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner mr-2"></span> Submitting application...';`,
  'after',
  `

  // Save the questionnaire BEFORE the registration request. The server derives
  // the respondent's email from req.session.pendingRegistration, and
  // complete-registration deletes that on success — so this has to go first.
  if (window.ResearchSurvey) {
    btn.innerHTML = '<span class="spinner mr-2"></span> Saving questionnaire...';
    var rsRes = await window.ResearchSurvey.submit();
    if (!rsRes.ok) {
      showStepError(5, rsRes.message || 'Could not save your questionnaire answers.');
      btn.disabled = false;
      btn.innerHTML = 'Submit Application <i class="fa-solid fa-paper-plane ml-1"></i>';
      return;
    }
    btn.innerHTML = '<span class="spinner mr-2"></span> Submitting application...';
  }`,
  'auth.js — questionnaire submit'
);

// ══════════════════════════════════════════════════════════════════
// 6/8 — admin.html: Research nav item under the Community section
// ══════════════════════════════════════════════════════════════════
queue(
  'public/admin.html',
  `id="nav-research"`,
  `    <div class="nav-item" id="nav-posts-all" onclick="showTab('posts-all')"><i class="fa-solid fa-newspaper w-4"></i>All Posts</div>`,
  'after',
  `
    <div class="nav-item" id="nav-research" onclick="showTab('research'); loadResearchTab();"><i class="fa-solid fa-flask w-4"></i>Research</div>`,
  'admin.html — Research nav item'
);

// ══════════════════════════════════════════════════════════════════
// 7/8 — admin.html: Research tab content
// ══════════════════════════════════════════════════════════════════
queue(
  'public/admin.html',
  `id="tab-research"`,
  `  <div id="tab-ai-log" class="tab-content">`,
  'before',
  `  <!-- ═══ RESEARCH — Student Residents Questionnaire ═══ -->
  <div id="tab-research" class="tab-content">
    <div class="flex items-center justify-between mb-6 flex-wrap gap-3">
      <div>
        <h1 class="font-display font-bold text-2xl text-slate-900 dark:text-slate-100">Research</h1>
        <p class="text-sm text-slate-400 mt-0.5">Student Residents Questionnaire &mdash; ISO/IEC 25010 system evaluation
          <span class="text-slate-300 dark:text-slate-600">&middot;</span>
          <span id="research-version" class="font-mono text-xs">&mdash;</span>
        </p>
      </div>
      <div class="flex items-center gap-3 flex-wrap">
        <!-- Anonymize toggle — defaults ON, matching the study's commitment
             that responses are anonymized during analysis. -->
        <div class="flex items-center gap-3 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-4 py-2">
          <div>
            <p class="text-sm font-semibold text-slate-700 dark:text-slate-200 flex items-center gap-1.5"><i class="fa-solid fa-user-secret text-brand-500"></i> Anonymize</p>
            <p class="text-xs text-slate-400" id="research-anon-desc">On &mdash; names and emails hidden (R1, R2 &hellip;)</p>
          </div>
          <button id="research-anon-toggle" onclick="toggleResearchAnonymize()" role="switch"
            class="relative w-12 h-6 rounded-full transition-colors duration-200 bg-brand-600 flex-shrink-0"
            title="Hide respondent identities">
            <span id="research-anon-thumb" class="absolute left-1 top-1 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200"></span>
          </button>
        </div>
        <button onclick="exportResearchExcel()" class="flex items-center gap-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 text-sm font-medium px-4 py-2 rounded-xl hover:bg-slate-50 transition-colors"><i class="fa-solid fa-file-excel text-xs text-green-600"></i>Excel</button>
        <button onclick="exportResearchPDF()" class="flex items-center gap-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 text-sm font-medium px-4 py-2 rounded-xl hover:bg-slate-50 transition-colors"><i class="fa-solid fa-file-pdf text-xs text-red-500"></i>PDF</button>
        <button onclick="loadResearchTab()" class="flex items-center gap-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 text-sm font-medium px-4 py-2 rounded-xl hover:bg-slate-50 transition-colors"><i class="fa-solid fa-rotate text-xs"></i>Refresh</button>
      </div>
    </div>

    <!-- Headline figures -->
    <div id="research-headline" class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6"></div>

    <!-- Per-characteristic summary (the Chapter 4 summary table) -->
    <div class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 overflow-hidden mb-6">
      <div class="px-5 py-4 border-b border-slate-100 dark:border-slate-800">
        <h2 class="font-semibold text-slate-800 dark:text-slate-100">Level of Acceptability by Quality Characteristic</h2>
        <p class="text-xs text-slate-400 mt-0.5">Weighted mean &Sigma;fx / N &middot; 4.21&ndash;5.00 Very Highly Acceptable &middot; 3.41&ndash;4.20 Highly Acceptable &middot; 2.61&ndash;3.40 Moderately Acceptable &middot; 1.81&ndash;2.60 Slightly Acceptable &middot; 1.00&ndash;1.80 Not Acceptable</p>
      </div>
      <div id="research-characteristics" class="overflow-x-auto"></div>
    </div>

    <!-- Per-item detail (the Chapter 4 item-analysis tables) -->
    <div class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 p-5 mb-6">
      <h2 class="font-semibold text-slate-800 dark:text-slate-100 mb-1">Item Analysis</h2>
      <p class="text-xs text-slate-400 mb-4">Frequency of each rating per statement, with the weighted mean (WM).</p>
      <div id="research-items"></div>
    </div>

    <!-- Individual responses -->
    <div class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 overflow-hidden mb-6">
      <div class="px-5 py-4 border-b border-slate-100 dark:border-slate-800">
        <h2 class="font-semibold text-slate-800 dark:text-slate-100">Individual Responses</h2>
        <p class="text-xs text-slate-400 mt-0.5">One row per respondent. Answers are kept even if the application is later rejected.</p>
      </div>
      <div id="research-responses" class="overflow-x-auto max-h-[520px]"></div>
    </div>

    <!-- Open-ended comments -->
    <div class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 p-5">
      <h2 class="font-semibold text-slate-800 dark:text-slate-100 mb-1">Comments &amp; Suggestions</h2>
      <p class="text-xs text-slate-400 mb-4">Open-ended feedback, newest first.</p>
      <div id="research-comments"></div>
    </div>
  </div>

`,
  'admin.html — Research tab content'
);

// ══════════════════════════════════════════════════════════════════
// 8/8 — admin.html: load the Research tab module
// ══════════════════════════════════════════════════════════════════
queue(
  'public/admin.html',
  '/js/admin-research.js',
  `<script src="/js/api.js"></script>`,
  'after',
  `
<script src="/js/admin-research.js"></script>`,
  'admin.html — admin-research.js script tag'
);

// ══════════════════════════════════════════════════════════════════

try {
  flush();
  console.log(`\nDone — ${applied} applied, ${skipped} already present.`);
  if (applied) console.log('Backups written alongside each patched file as *.bak');
  process.exit(0);
} catch (err) {
  console.error(`\n✖ Aborted — nothing was written.\n  ${err.message}`);
  process.exit(1);
}
