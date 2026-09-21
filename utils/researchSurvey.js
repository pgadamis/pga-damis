/**
 * utils/researchSurvey.js — Student Residents Questionnaire (research instrument)
 *
 * Single source of truth for the ISO/IEC 25010 end-user evaluation instrument
 * described in Chapter 2 of the capstone manuscript. The questionnaire spec
 * below is consumed by BOTH the applicant-facing form (public/js/research-survey.js,
 * via GET /api/research/questionnaire) and the admin Research tab, so the wording
 * can never drift between what respondents answered and what gets reported.
 *
 * Design notes:
 *   - The table lives in the same SQLite file as everything else, but this module
 *     owns it end-to-end (DDL + queries) instead of growing utils/db.js further.
 *     It borrows the shared better-sqlite3 handle so there is still exactly one
 *     connection, one WAL, one transaction scope.
 *   - Responses are keyed by EMAIL, not user id. The survey is submitted during
 *     Step 5 of registration, before the users row is guaranteed to exist, and it
 *     must survive an application being rejected — a rejected applicant's ratings
 *     are still valid research data. Identity is resolved by LEFT JOIN at read time.
 *   - Nothing derived is persisted. Per-characteristic means, the overall weighted
 *     mean and the acceptability interpretation are all computed on read, so a
 *     change to the interpretation scale never leaves stale numbers in the DB.
 */

'use strict';

const { db, genId } = require('./db');
const log = require('./logger');

// ════════════════════════════════════════════════════════════════════
// INSTRUMENT SPEC
// ════════════════════════════════════════════════════════════════════

/**
 * Bump this whenever item wording changes. Stored on every row so a mid-study
 * revision is detectable during analysis instead of silently mixing instruments.
 */
const INSTRUMENT_VERSION = 'iso25010-student-resident-v1';

const RESPONDENT_TYPE = 'student_resident';

/** 5-point Likert scale (Chapter 2 — Data Gathering Instrument). */
const SCALE = [
  { value: 1, label: 'Strongly Disagree', short: 'SD' },
  { value: 2, label: 'Disagree',          short: 'D'  },
  { value: 3, label: 'Neutral',           short: 'N'  },
  { value: 4, label: 'Agree',             short: 'A'  },
  { value: 5, label: 'Strongly Agree',    short: 'SA' },
];

/** Weighted-mean interpretation ranges (Chapter 2 — Data Analysis Technique). */
const INTERPRETATION_SCALE = [
  { min: 4.21, max: 5.00, label: 'Very Highly Acceptable' },
  { min: 3.41, max: 4.20, label: 'Highly Acceptable'      },
  { min: 2.61, max: 3.40, label: 'Moderately Acceptable'  },
  { min: 1.81, max: 2.60, label: 'Slightly Acceptable'    },
  { min: 1.00, max: 1.80, label: 'Not Acceptable'         },
];

/**
 * Consent statement shown above the items. The manuscript's Ethical Concerns
 * section requires consent to be embedded in the instrument itself, with the
 * respondent proceeding to the items only after indicating consent.
 */
const CONSENT_STATEMENT =
  'This short questionnaire is part of an undergraduate capstone study evaluating ' +
  'PGA-DAMIS using the ISO/IEC 25010 Software Quality Model. Your answers are used ' +
  'for academic purposes only, are reported anonymously, and have NO effect on the ' +
  'outcome of your dormitory application. Participation is requested as part of the ' +
  'evaluation of this system, and your responses are handled in accordance with ' +
  'Republic Act No. 10173 (Data Privacy Act of 2012).';

const CONSENT_LABEL =
  'I have read and understood the statement above and I consent to my responses ' +
  'being used for this study.';

const COMMENT_PROMPT =
  'Comments, problems encountered, or suggestions for improving the system (optional)';

/**
 * Items are deliberately scoped to the part of the system the respondent has
 * actually used at this point — account creation, email verification, the
 * application form, and document upload. Asking an applicant to rate billing or
 * room assignment before they have ever seen those modules would produce
 * uninformed ratings and weaken the study's validity.
 */
const CHARACTERISTICS = [
  {
    code: 'FS',
    name: 'Functional Suitability',
    description: 'The system provides the functions needed to complete a dormitory application.',
    items: [
      { code: 'FS1', text: 'The online application form provided all the fields and requirements needed to complete my dormitory application.' },
      { code: 'FS2', text: 'The system correctly did what I expected it to do at every step of the application.' },
      { code: 'FS3', text: 'The document upload feature accepted and processed my required documents as intended.' },
    ],
  },
  {
    code: 'PE',
    name: 'Performance Efficiency',
    description: 'The system responds and completes tasks within a reasonable time.',
    items: [
      { code: 'PE1', text: 'The system responded quickly when I moved between the steps of the application.' },
      { code: 'PE2', text: 'Pages and file uploads finished loading within a reasonable amount of time.' },
      { code: 'PE3', text: 'The system ran smoothly without slowing down or freezing while I was using it.' },
    ],
  },
  {
    code: 'US',
    name: 'Usability',
    description: 'The system is easy to understand, learn and operate.',
    items: [
      { code: 'US1', text: 'The system was easy to learn and use without needing someone to assist me.' },
      { code: 'US2', text: 'The labels, instructions and error messages were clear and easy to understand.' },
      { code: 'US3', text: 'The layout and design made it easy to find what I needed.' },
    ],
  },
  {
    code: 'RE',
    name: 'Reliability',
    description: 'The system performs consistently and recovers from user errors.',
    items: [
      { code: 'RE1', text: 'The system worked consistently without crashing or losing the information I had already entered.' },
      { code: 'RE2', text: 'When I entered something incorrectly, the system told me and let me correct it without starting over.' },
      { code: 'RE3', text: 'I was able to finish my application without technical interruptions.' },
    ],
  },
  {
    code: 'SE',
    name: 'Security',
    description: 'The system protects personal data and restricts access to the rightful owner.',
    items: [
      { code: 'SE1', text: 'I am confident that my personal information and uploaded documents are kept private and protected.' },
      { code: 'SE2', text: 'The email verification (OTP) step gave me confidence that only I can use my account.' },
      { code: 'SE3', text: 'The system clearly informed me how my personal data would be used before I submitted it.' },
    ],
  },
  {
    code: 'PO',
    name: 'Portability',
    description: 'The system can be accessed and used across devices and browsers.',
    items: [
      { code: 'PO1', text: 'The system worked properly on the device I used to apply.' },
      { code: 'PO2', text: 'The system displayed correctly on my screen size without difficulty.' },
      { code: 'PO3', text: 'I was able to access the system using my usual web browser without installing anything.' },
    ],
  },
];

/** Flat list of every item code, in presentation order. */
const ITEM_CODES = CHARACTERISTICS.flatMap(ch => ch.items.map(it => it.code));

/** itemCode → { code, text, characteristic } lookup. */
const ITEM_INDEX = (() => {
  const map = new Map();
  for (const ch of CHARACTERISTICS) {
    for (const it of ch.items) {
      map.set(it.code, { code: it.code, text: it.text, characteristicCode: ch.code, characteristicName: ch.name });
    }
  }
  return map;
})();

// ════════════════════════════════════════════════════════════════════
// SCHEMA
// ════════════════════════════════════════════════════════════════════

db.prepare(`CREATE TABLE IF NOT EXISTS research_survey_responses (
  id                 TEXT PRIMARY KEY,
  email              TEXT NOT NULL UNIQUE,
  full_name          TEXT DEFAULT '',
  respondent_type    TEXT NOT NULL DEFAULT 'student_resident',
  instrument_version TEXT NOT NULL,
  answers            TEXT NOT NULL,
  comments           TEXT DEFAULT '',
  consent_given      INTEGER NOT NULL DEFAULT 0,
  user_agent         TEXT DEFAULT '',
  submitted_at       TEXT DEFAULT (datetime('now')),
  updated_at         TEXT DEFAULT (datetime('now'))
)`).run();

db.prepare(
  `CREATE INDEX IF NOT EXISTS idx_research_survey_submitted
   ON research_survey_responses(submitted_at)`
).run();

// ════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/** Round to 2 dp and return a Number (not a string) so the client can format it. */
function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Map a weighted mean onto the acceptability scale.
 * Returns '—' for an empty set so the admin UI never prints "Not Acceptable"
 * when the real answer is "nobody has responded yet".
 */
function interpret(mean) {
  if (mean === null || mean === undefined || Number.isNaN(mean)) return '—';
  for (const band of INTERPRETATION_SCALE) {
    if (mean >= band.min) return band.label;
  }
  return INTERPRETATION_SCALE[INTERPRETATION_SCALE.length - 1].label;
}

/** The payload the applicant-facing form renders from. */
function getQuestionnaire() {
  return {
    instrumentVersion: INSTRUMENT_VERSION,
    respondentType:    RESPONDENT_TYPE,
    title:             'Student Residents Questionnaire',
    subtitle:          'System evaluation based on the ISO/IEC 25010 Software Quality Model',
    consentStatement:  CONSENT_STATEMENT,
    consentLabel:      CONSENT_LABEL,
    commentPrompt:     COMMENT_PROMPT,
    scale:             SCALE,
    characteristics:   CHARACTERISTICS,
    itemCount:         ITEM_CODES.length,
  };
}

/**
 * Validate a raw answers object from the client.
 * Fails loudly with the specific offending item codes rather than a generic
 * "invalid input" — that message is surfaced in the browser console and the
 * server log, and a partial submit is the single most likely bug here.
 *
 * @returns {{ ok: boolean, error?: string, missing?: string[], answers?: Object }}
 */
function validateAnswers(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Answers must be an object keyed by item code.' };
  }

  const answers = {};
  const missing = [];
  const invalid = [];

  for (const code of ITEM_CODES) {
    const val = Number(raw[code]);
    if (!Number.isFinite(val)) { missing.push(code); continue; }
    if (!Number.isInteger(val) || val < 1 || val > 5) { invalid.push(code); continue; }
    answers[code] = val;
  }

  // Reject unknown keys outright — a stale cached form sending retired item
  // codes would otherwise pollute the dataset without anyone noticing.
  const unknown = Object.keys(raw).filter(k => !ITEM_INDEX.has(k));

  if (missing.length) {
    return { ok: false, error: `Please answer all ${ITEM_CODES.length} statements.`, missing };
  }
  if (invalid.length) {
    return { ok: false, error: `Invalid rating for: ${invalid.join(', ')}. Ratings must be 1–5.` };
  }
  if (unknown.length) {
    return { ok: false, error: `Unrecognized item code(s): ${unknown.slice(0, 5).join(', ')}. Please reload the page and try again.` };
  }

  return { ok: true, answers };
}

/** Per-characteristic + overall means for one respondent's answers object. */
function scoreOne(answers) {
  const byCharacteristic = {};
  let total = 0, count = 0;

  for (const ch of CHARACTERISTICS) {
    let sum = 0, n = 0;
    for (const it of ch.items) {
      const v = answers[it.code];
      if (Number.isFinite(v)) { sum += v; n++; }
    }
    byCharacteristic[ch.code] = n ? round2(sum / n) : null;
    total += sum;
    count += n;
  }

  const overall = count ? round2(total / count) : null;
  return { byCharacteristic, overall, interpretation: interpret(overall) };
}

// ════════════════════════════════════════════════════════════════════
// WRITES
// ════════════════════════════════════════════════════════════════════

/**
 * Insert or replace one respondent's submission.
 *
 * Upsert-on-email is intentional: if registration fails after the survey posts
 * (duplicate phone, upload timeout, browser refresh), the applicant retries and
 * overwrites their own row instead of creating a duplicate respondent.
 */
function saveResponse({ email, fullName = '', answers, comments = '', consentGiven, userAgent = '' }) {
  const mail = normalizeEmail(email);
  if (!mail) throw new Error('saveResponse: email is required.');
  if (!consentGiven) throw new Error('saveResponse: consent is required.');

  const check = validateAnswers(answers);
  if (!check.ok) throw new Error(`saveResponse: ${check.error}`);

  const id = genId();
  db.prepare(`
    INSERT INTO research_survey_responses
      (id, email, full_name, respondent_type, instrument_version,
       answers, comments, consent_given, user_agent)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(email) DO UPDATE SET
      full_name          = excluded.full_name,
      respondent_type    = excluded.respondent_type,
      instrument_version = excluded.instrument_version,
      answers            = excluded.answers,
      comments           = excluded.comments,
      consent_given      = excluded.consent_given,
      user_agent         = excluded.user_agent,
      updated_at         = datetime('now')
  `).run(
    id, mail,
    String(fullName || '').trim().slice(0, 120),
    RESPONDENT_TYPE,
    INSTRUMENT_VERSION,
    JSON.stringify(check.answers),
    String(comments || '').trim().slice(0, 1000),
    1,
    String(userAgent || '').slice(0, 255)
  );

  const score = scoreOne(check.answers);
  log.info(
    `[Research] Questionnaire saved — ${mail} · overall ${score.overall} (${score.interpretation}) · ` +
    `v=${INSTRUMENT_VERSION}`
  );
  return { id, email: mail, ...score };
}

function hasResponded(email) {
  const mail = normalizeEmail(email);
  if (!mail) return false;
  return !!db.prepare('SELECT 1 FROM research_survey_responses WHERE email = ?').get(mail);
}

// ════════════════════════════════════════════════════════════════════
// READS
// ════════════════════════════════════════════════════════════════════

function parseRow(row) {
  let answers = {};
  try {
    answers = JSON.parse(row.answers) || {};
  } catch (e) {
    // A corrupt blob should not take down the whole Research tab; surface it
    // as a flagged row so it can be found and dealt with.
    log.warn(`[Research] Unparseable answers blob on row ${row.id}: ${e.message}`);
  }
  return { answers, corrupt: !Object.keys(answers).length };
}

/**
 * All individual responses, newest first, joined to the users table so admin
 * can see whether the respondent's application was approved, rejected, or is
 * still pending.
 *
 * @param {{ anonymize?: boolean }} opts When anonymize is true, names and emails
 *   are replaced by a stable respondent number (R1, R2 …) — matching the
 *   manuscript's commitment that responses are anonymized during analysis.
 */
function getResponses({ anonymize = false } = {}) {
  // rowid is included and used as the tie-break below. Several applicants can
  // submit within the same second, and datetime('now') only has second
  // resolution — without the tie-break, respondent numbers would shuffle
  // between page loads. R1 must always refer to the same person.
  const rows = db.prepare(`
    SELECT r.rowid         AS row_seq,
           r.*,
           u.id            AS user_id,
           u.username      AS username,
           u.first_name    AS first_name,
           u.last_name     AS last_name,
           u.account_status AS account_status,
           u.year_level    AS year_level,
           u.course        AS course
      FROM research_survey_responses r
      LEFT JOIN users u ON lower(u.email) = r.email
     ORDER BY r.submitted_at DESC, r.rowid DESC
  `).all();

  // Respondent numbers are assigned in chronological (submission) order so R1
  // is the first person who answered, regardless of how the table is sorted.
  const chronological = [...rows].sort((a, b) =>
    String(a.submitted_at).localeCompare(String(b.submitted_at)) || (a.row_seq - b.row_seq));
  const respondentNo = new Map(chronological.map((r, i) => [r.id, i + 1]));

  return rows.map(row => {
    const { answers, corrupt } = parseRow(row);
    const score = scoreOne(answers);
    const n = respondentNo.get(row.id);
    const realName = [row.first_name, row.last_name].filter(Boolean).join(' ') || row.full_name || '';

    return {
      id:                 row.id,
      respondentNo:       n,
      respondentLabel:    `R${n}`,
      email:              anonymize ? '' : row.email,
      fullName:           anonymize ? `Respondent ${n}` : realName,
      username:           anonymize ? '' : (row.username || ''),
      userId:             anonymize ? '' : (row.user_id || ''),
      accountStatus:      row.account_status || 'not_found',
      yearLevel:          row.year_level || '',
      course:             row.course || '',
      respondentType:     row.respondent_type,
      instrumentVersion:  row.instrument_version,
      answers,
      corrupt,
      comments:           row.comments || '',
      consentGiven:       !!row.consent_given,
      submittedAt:        row.submitted_at,
      updatedAt:          row.updated_at,
      means:              score.byCharacteristic,
      overallMean:        score.overall,
      interpretation:     score.interpretation,
    };
  });
}

/**
 * Aggregate statistics ready to be pasted into Chapter 4:
 *   - per-item frequency distribution (f for each rating), weighted mean, interpretation
 *   - per-characteristic weighted mean and interpretation
 *   - overall weighted mean and interpretation
 *
 * The weighted mean here is Σfx / N exactly as defined in the manuscript:
 * each rating is a weight, each respondent contributes one frequency count.
 */
function getStats() {
  const rows = db.prepare('SELECT id, answers FROM research_survey_responses').all();
  const parsed = rows.map(r => parseRow(r).answers);
  const n = parsed.length;

  const itemStats = {};
  for (const code of ITEM_CODES) {
    const freq = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let sumFx = 0, responses = 0;

    for (const answers of parsed) {
      const v = answers[code];
      if (!Number.isInteger(v) || v < 1 || v > 5) continue;
      freq[v]++;
      sumFx += v;
      responses++;
    }

    const mean = responses ? round2(sumFx / responses) : null;
    const meta = ITEM_INDEX.get(code);
    itemStats[code] = {
      code,
      text:               meta.text,
      characteristicCode: meta.characteristicCode,
      frequency:          freq,
      responses,
      sumFx,
      mean,
      interpretation:     interpret(mean),
    };
  }

  const characteristicStats = CHARACTERISTICS.map(ch => {
    let sumFx = 0, responses = 0;
    for (const it of ch.items) {
      sumFx     += itemStats[it.code].sumFx;
      responses += itemStats[it.code].responses;
    }
    const mean = responses ? round2(sumFx / responses) : null;
    return {
      code:           ch.code,
      name:           ch.name,
      description:    ch.description,
      items:          ch.items.map(it => itemStats[it.code]),
      responses,
      mean,
      interpretation: interpret(mean),
    };
  });

  const grandSum = characteristicStats.reduce((a, c) => a + c.items.reduce((s, i) => s + i.sumFx, 0), 0);
  const grandN   = characteristicStats.reduce((a, c) => a + c.responses, 0);
  const overall  = grandN ? round2(grandSum / grandN) : null;

  return {
    instrumentVersion:   INSTRUMENT_VERSION,
    respondentCount:     n,
    itemCount:           ITEM_CODES.length,
    scale:               SCALE,
    interpretationScale: INTERPRETATION_SCALE,
    characteristics:     characteristicStats,
    overallMean:         overall,
    overallInterpretation: interpret(overall),
    // Comments are the qualitative half of the data — surfaced here so the
    // admin tab can show them without a second round trip.
    comments: db.prepare(`
      SELECT comments, submitted_at
        FROM research_survey_responses
       WHERE TRIM(COALESCE(comments,'')) <> ''
       ORDER BY submitted_at DESC
    `).all().map(r => ({ text: r.comments, submittedAt: r.submitted_at })),
  };
}

module.exports = {
  INSTRUMENT_VERSION,
  RESPONDENT_TYPE,
  SCALE,
  INTERPRETATION_SCALE,
  CHARACTERISTICS,
  ITEM_CODES,
  getQuestionnaire,
  validateAnswers,
  interpret,
  scoreOne,
  saveResponse,
  hasResponded,
  getResponses,
  getStats,
};
