/**
 * routes/research.js — Student Residents Questionnaire API
 *
 * Public:
 *   GET  /api/research/questionnaire     instrument spec for the Step 5 form
 *   POST /api/research/survey            submit answers (OTP-verified session or logged-in user)
 *
 * Admin:
 *   GET  /api/admin/research/stats       aggregate weighted means + interpretations
 *   GET  /api/admin/research/responses   individual responses (optionally anonymized)
 *
 * Why the submit route is session-gated rather than open:
 *   The questionnaire is answered during registration Step 5, before an account
 *   exists, so there is no logged-in user to authenticate. Instead we require the
 *   same proof the registration endpoint requires — a session whose
 *   pendingRegistration has already cleared email OTP verification. That makes the
 *   email in the row server-derived and not client-supplied, so the dataset cannot
 *   be stuffed with responses for arbitrary addresses.
 */

'use strict';

const express = require('express');
const router  = express.Router();

const log = require('../utils/logger');
const { db } = require('../utils/db');
const {
  getQuestionnaire,
  validateAnswers,
  saveResponse,
  hasResponded,
  getResponses,
  getStats,
} = require('../utils/researchSurvey');

/**
 * Same contract as requireAdmin in routes/admin.js, duplicated rather than
 * exported-and-shared to keep this router self-contained. If that dev-bypass
 * behaviour is ever changed, change it in both places.
 */
function requireAdmin(req, res, next) {
  const IS_DEV = process.env.NODE_ENV !== 'production';

  if (!IS_DEV) {
    if (!req.isAuthenticated || !req.isAuthenticated())
      return res.status(401).json({ error: 'Not authenticated.' });
    if (req.user.role !== 'admin' && req.user.role !== 'superadmin')
      return res.status(403).json({ error: 'Admin access required.' });
    return next();
  }

  if (!req.user) {
    const admin = db.prepare(
      "SELECT id, username, role, email, first_name FROM users WHERE role='admin' AND account_status='approved' LIMIT 1"
    ).get();
    if (admin) {
      req.user = { id: admin.id, username: admin.username, role: admin.role, email: admin.email, firstName: admin.first_name };
      log.bypass(`unauthenticated → injected @${admin.username} for ${req.method} ${req.path}`);
    } else {
      log.warn('requireAdmin dev: no admin in DB');
      return res.status(503).json({ error: 'No admin account seeded yet.' });
    }
  }
  return next();
}

function send500(res, err, label = '') {
  const msg = err?.message || String(err);
  res._errMsg = label ? `${label}: ${msg}` : msg;
  res.status(500).json({ error: 'Server error. Please try again.' });
}

// ════════════════════════════════════════════════════════════════════
// PUBLIC
// ════════════════════════════════════════════════════════════════════

/**
 * GET /api/research/questionnaire
 * Unauthenticated on purpose — the registration page that renders this form is
 * itself unauthenticated. The payload is static instrument text, no user data.
 */
router.get('/api/research/questionnaire', (req, res) => {
  try {
    return res.json({ success: true, questionnaire: getQuestionnaire() });
  } catch (err) {
    return send500(res, err, 'research/questionnaire');
  }
});

/**
 * POST /api/research/survey
 * Body: { answers: { FS1: 1..5, … }, comments?: string, consentGiven: boolean, fullName?: string }
 */
router.post('/api/research/survey', (req, res) => {
  try {
    // ── Resolve the respondent's email server-side ──────────────────────
    const pending = req.session?.pendingRegistration;
    let email = '';
    let source = '';

    if (req.user?.email) {
      email  = req.user.email;
      source = 'session-user';
    } else if (pending?.emailVerified && pending.email) {
      email  = pending.email;
      source = 'pending-registration';
    }

    if (!email) {
      return res.status(401).json({
        error: 'Your email is not verified for this session. Please complete the email OTP step first.',
      });
    }

    const { answers, comments, consentGiven, fullName } = req.body || {};

    if (!consentGiven) {
      return res.status(400).json({ error: 'Please give your consent before submitting the questionnaire.' });
    }

    const check = validateAnswers(answers);
    if (!check.ok) {
      log.warn(`[Research] Rejected submission from ${email} — ${check.error}${check.missing ? ` (missing: ${check.missing.join(', ')})` : ''}`);
      return res.status(400).json({ error: check.error, missing: check.missing || [] });
    }

    const saved = saveResponse({
      email,
      fullName,
      answers:      check.answers,
      comments,
      consentGiven: true,
      userAgent:    req.headers['user-agent'] || '',
    });

    log.info(`[Research] Submission accepted via ${source} — ${email}`);

    return res.json({
      success:        true,
      overallMean:    saved.overallMean ?? saved.overall,
      interpretation: saved.interpretation,
    });
  } catch (err) {
    return send500(res, err, 'research/survey');
  }
});

/**
 * GET /api/research/survey/status
 * Lets the Step 5 form skip re-prompting if this session already submitted
 * (e.g. the applicant hit Back then Submit again).
 */
router.get('/api/research/survey/status', (req, res) => {
  try {
    const email = req.user?.email
      || (req.session?.pendingRegistration?.emailVerified ? req.session.pendingRegistration.email : '');
    if (!email) return res.json({ success: true, answered: false });
    return res.json({ success: true, answered: hasResponded(email) });
  } catch (err) {
    return send500(res, err, 'research/survey/status');
  }
});

// ════════════════════════════════════════════════════════════════════
// ADMIN
// ════════════════════════════════════════════════════════════════════

router.get('/api/admin/research/stats', requireAdmin, (req, res) => {
  try {
    return res.json({ success: true, stats: getStats() });
  } catch (err) {
    return send500(res, err, 'admin/research/stats');
  }
});

router.get('/api/admin/research/responses', requireAdmin, (req, res) => {
  try {
    const anonymize = req.query.anonymize === '1' || req.query.anonymize === 'true';
    const responses = getResponses({ anonymize });
    return res.json({
      success: true,
      anonymized: anonymize,
      count: responses.length,
      responses,
    });
  } catch (err) {
    return send500(res, err, 'admin/research/responses');
  }
});

module.exports = router;
