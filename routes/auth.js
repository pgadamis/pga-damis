/**
 * routes/auth.js  (updated for SQLite db)
 *
 * Everything is identical to v2 except:
 *   - Import from ../utils/db instead of ../utils/userStore
 *   - createUser() call replaces users.push()
 */

const express  = require('express');
const passport = require('passport');
const bcrypt   = require('bcryptjs');
const router   = express.Router();
const log      = require('../utils/logger');
const geminiPool = require('../utils/geminiPool');

const { generateOTP, sendOTPEmail, sendWelcomeEmail, sendPasswordResetEmail, sendAccountPendingEmail, sendAccountApprovedEmail, sendAccountRejectedEmail, sendContactEmail } = require('../utils/emailService');
const { rejectDisposableEmail } = require('../utils/disposableEmailCheck');
const { uploadIdDocs } = require('../middleware/upload');
const {
  findUserByEmail, findUserById, findUserByUsername, findUserByPhone,
  createUser, submitIdVerification,
  getPendingAccounts, approveAccount, rejectAccount,
  saveOTP, verifyOTP, saveResetOTP, verifyResetOTP, consumeResetOTP,
  recordFailedLogin, checkLoginLock, clearLoginAttempts,
} = require('../utils/db');

// ─── helpers ────────────────────────────────────────
function validatePassword(p) {
  const e = [];
  if (!p || p.length < 8)        e.push('At least 8 characters');
  if (!/[A-Z]/.test(p))          e.push('One uppercase letter');
  if (!/[a-z]/.test(p))          e.push('One lowercase letter');
  if (!/[0-9]/.test(p))          e.push('One number');
  if (!/[^A-Za-z0-9]/.test(p))  e.push('One special character');
  if (/\s/.test(p))              e.push('No spaces allowed');
  return e;
}
function getAge(dob) {
  const b = new Date(dob), n = new Date();
  let a = n.getFullYear() - b.getFullYear();
  if (n.getMonth() < b.getMonth() || (n.getMonth() === b.getMonth() && n.getDate() < b.getDate())) a--;
  return a;
}

// ════════════════════════════════════════════════════
// POST /api/auth/send-otp
// ════════════════════════════════════════════════════
// NOTE: rejectDisposableEmail middleware disabled for testing — re-enable in production:
// router.post('/api/auth/send-otp', rejectDisposableEmail, async (req, res) => {
router.post('/api/auth/send-otp', async (req, res) => {
  try {
    const { email, password, confirmPassword, isGoogleSignup } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
      return res.status(400).json({ error: 'Please enter a valid email address.' });

    const existing = findUserByEmail(email.trim());
    if (existing) {
      return res.status(409).json({
        error: existing.authProvider === 'google'
          ? 'This email is already registered via Google Sign-In. Please use the Google button to log in.'
          : 'This email already has an account. Please log in instead.',
      });
    }

    if (!isGoogleSignup) {
      const passErrors = validatePassword(password);
      if (passErrors.length > 0)
        return res.status(400).json({ error: 'Password requirements not met.', details: passErrors });
      if (password !== confirmPassword)
        return res.status(400).json({ error: 'Passwords do not match.' });

      // ── BUG FIX: If a user started Google OAuth but refreshed and is now
      // registering with a normal email/password, purge the leftover Google
      // session so it doesn't contaminate the new local account.
      delete req.session.pendingGoogle;
    }

    const pg        = req.session.pendingGoogle;
    const firstName = pg?.firstName || req.body.firstName || 'there';
    const otp       = generateOTP();
    saveOTP(email.trim(), otp, firstName);
    const result    = await sendOTPEmail(email.trim(), otp, firstName);
    if (!result.success)
      return res.status(500).json({ error: 'Failed to send verification email. Please try again.' });

    req.session.pendingRegistration = {
      email:          email.trim(),
      password:       isGoogleSignup ? null : password,
      isGoogleSignup: !!isGoogleSignup,
      emailVerified:  false,
    };
    const response = { success: true, message: `Verification code sent to ${email.trim()}` };
    if (result.previewUrl) response.previewUrl = result.previewUrl;
    return res.json(response);
  } catch (err) {
    console.error('send-otp error:', err);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ════════════════════════════════════════════════════
// POST /api/auth/resend-otp
// ════════════════════════════════════════════════════
// NOTE: rejectDisposableEmail middleware disabled for testing — re-enable in production
router.post('/api/auth/resend-otp', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required.' });
    const pending = req.session.pendingRegistration;
    if (!pending || pending.email !== email.trim())
      return res.status(400).json({ error: 'Session expired. Please start registration again.' });
    const pg        = req.session.pendingGoogle;
    const firstName = pg?.firstName || 'there';
    const otp       = generateOTP();
    saveOTP(email.trim(), otp, firstName);
    const result    = await sendOTPEmail(email.trim(), otp, firstName);
    if (!result.success) return res.status(500).json({ error: 'Failed to resend. Please try again.' });
    const response = { success: true, message: 'New code sent!' };
    if (result.previewUrl) response.previewUrl = result.previewUrl;
    return res.json(response);
  } catch (err) {
    return res.status(500).json({ error: 'Server error.' });
  }
});

// ════════════════════════════════════════════════════
// POST /api/auth/verify-otp
// ════════════════════════════════════════════════════
router.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ error: 'Email and code are required.' });
    const result = verifyOTP(email.trim(), otp.trim());
    if (!result.valid) return res.status(400).json({ error: result.reason });
    const pending = req.session.pendingRegistration;
    if (!pending || pending.email !== email.trim())
      return res.status(400).json({ error: 'Session expired. Please register again.' });
    pending.emailVerified = true;
    req.session.pendingRegistration = pending;
    return res.json({ success: true, message: 'Email verified! Continue to fill in your profile.' });
  } catch (err) {
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ════════════════════════════════════════════════════
// POST /api/auth/complete-registration
// Accepts multipart/form-data (fields + optional id_front file)
// ════════════════════════════════════════════════════
router.post('/api/auth/complete-registration', ...uploadIdDocs, async (req, res) => {
  try {
    const pending = req.session.pendingRegistration;
    if (!pending || !pending.emailVerified)
      return res.status(400).json({ error: 'Email not verified. Please complete Step 2 first.' });

    const {
      firstName, middleName, lastName, suffix, username, birthday, sex, phone, bio,
      location, idType,
      // DAMIS new fields
      civilStatus, presentAddress, permanentAddress,
      schoolName, course, yearLevel, schoolAddress, specialization,
      fatherInfo, motherInfo, guardianInfo, monthlyIncome,
      avatarFaceX, avatarFaceY,
    } = req.body;
    if (!firstName?.trim()) return res.status(400).json({ error: 'First name is required.' });
    if (!lastName?.trim())  return res.status(400).json({ error: 'Last name is required.' });
    // username validation removed — username field removed from registration form
    if (!birthday)          return res.status(400).json({ error: 'Date of birth is required.' });
    if (getAge(birthday) < 13) return res.status(400).json({ error: 'You must be at least 13 years old.' });
    if (!sex)               return res.status(400).json({ error: 'Sex is required.' });

    if (!phone?.trim()) return res.status(400).json({ error: 'Phone number is required.' });
    const phoneClean = phone.trim().replace(/\D/g, '');
    if (!/^(9\d{9}|09\d{9})$/.test(phoneClean))
      return res.status(400).json({ error: 'Invalid phone number. Enter 10 digits after +63.' });
    const phoneFormatted = '+63' + (phoneClean.length === 11 ? phoneClean.slice(1) : phoneClean);

    // ⚠️ TESTING MODE: phone uniqueness check disabled — duplicate phones get an auto-suffix
    // so registration never blocks during testing. Re-enable the PRODUCTION block below when done.
    let phoneForDb = phoneFormatted;
    if (findUserByPhone(phoneFormatted)) {
      const suffix = Date.now().toString().slice(-5); // 5-digit ms suffix → always unique
      phoneForDb = phoneFormatted.slice(0, -5) + suffix;
      log.warn(`[TEST] phone ${phoneFormatted} already in DB — using surrogate ${phoneForDb} for this test account.`);
    }
    // ── PRODUCTION: uncomment to enforce phone uniqueness (and remove block above) ──
    // if (findUserByPhone(phoneFormatted))
    //   return res.status(409).json({ error: 'This phone number is already registered to another account.' });
    // Username uniqueness check removed
    if (findUserByEmail(pending.email))
      return res.status(409).json({ error: 'This email was just registered by someone else.' });

    const pg             = req.session.pendingGoogle;
    const hashedPassword = pending.password ? await bcrypt.hash(pending.password, 12) : null;

    const newUser = createUser({
      googleId:         pg?.googleId || null,
      email:            pending.email,
      password:         hashedPassword,
      firstName:        firstName.trim(),
      middleName:       middleName?.trim() || '',
      lastName:         lastName.trim(),
      suffix:           suffix || '',
      username:         (username?.trim() || (firstName.trim().toLowerCase().replace(/[^a-z0-9]/g,'') + Math.floor(Math.random()*9000+1000))),
      birthday,
      sex,
      civilStatus:      civilStatus?.trim()      || '',
      phone:            phoneForDb,
      bio:              bio?.trim()              || '',
      location:         presentAddress?.trim()   || location?.trim() || '',
      presentAddress:   presentAddress?.trim()   || '',
      permanentAddress: permanentAddress?.trim() || '',
      schoolName:       schoolName?.trim()       || 'Aurora State College of Technology',
      course:           course?.trim()           || '',
      yearLevel:        yearLevel?.trim()        || '',
      schoolAddress:    schoolAddress?.trim()    || 'Zabali, Baler, Aurora',
      specialization:   specialization?.trim()  || '',
      fatherInfo:       fatherInfo              || '',
      motherInfo:       motherInfo              || '',
      guardianInfo:     guardianInfo            || '',
      monthlyIncome:    monthlyIncome?.trim()    || '',
      avatar:           req.idDocUrls?.avatar    || pg?.avatar || '',
      avatarFaceX:      parseInt(avatarFaceX, 10) || 50,
      avatarFaceY:      parseInt(avatarFaceY, 10) || 50,
      emailVerified:    true,
      idVerified:       false,
      authProvider:     pg ? 'google' : 'local',
    });

    log.divider('NEW REGISTRATION');
    log.reg(`${firstName.trim()} ${lastName.trim()} — @${newUser.username} — ${pending.email}`);
    log.dump('User details', {
      id:               newUser.id,
      name:             `${firstName.trim()} ${middleName?.trim() || ''} ${lastName.trim()} ${suffix || ''}`.trim(),
      username:         `@${newUser.username}`,
      email:            pending.email,
      phone:            phoneForDb,
      birthday,
      sex,
      civilStatus:      civilStatus || '(not set)',
      presentAddress:   presentAddress || '(not set)',
      permanentAddress: permanentAddress || '(same as present)',
      yearLevel:        yearLevel || '(not set)',
      course:           course || '(not set)',
      specialization:   specialization || '(none)',
      monthlyIncome:    monthlyIncome || '(not set)',
      guardianInfo:     guardianInfo ? '(provided — both parents marked deceased)' : '(none)',
      authProvider:     pg ? 'google' : 'local',
    });

    // ── Submit ID verification if files were uploaded ──
    const idUrls = req.idDocUrls || {};
    log.dump('Uploaded files', {
      avatar:           idUrls.avatar           ? `✔ ${String(idUrls.avatar).slice(0, 55)}…`           : '✖ missing',
      id_front:         idUrls.id_front         ? `✔ ${String(idUrls.id_front).slice(0, 55)}…`         : '✖ missing',
      selfie:           idUrls.selfie           ? `✔ ${String(idUrls.selfie).slice(0, 55)}…`           : '✖ missing',
      cert_residency:   idUrls.cert_residency   ? `✔ ${String(idUrls.cert_residency).slice(0, 55)}…`   : '✖ missing',
      cert_low_income:  idUrls.cert_low_income  ? `✔ ${String(idUrls.cert_low_income).slice(0, 55)}…`  : '✖ missing',
      cert_enrollment:  idUrls.cert_enrollment  ? `✔ ${String(idUrls.cert_enrollment).slice(0, 55)}…`  : '✖ missing',
    });
    if (idUrls.id_front || idUrls.cert_residency || idUrls.cert_low_income || idUrls.cert_enrollment || idUrls.selfie || idUrls.avatar) {
      try {
        submitIdVerification({
          userId:             newUser.id,
          idFrontUrl:         idUrls.id_front        || '',
          idBackUrl:          idUrls.id_back          || '',
          selfieUrl:          idUrls.selfie           || idUrls.avatar || '',
          idType:             'school_id',
          certResidencyUrl:   idUrls.cert_residency   || '',
          certLowIncomeUrl:   idUrls.cert_low_income  || '',
          certEnrollmentUrl:  idUrls.cert_enrollment  || '',
        });
        log.upload(`Documents stored for @${newUser.username}: school_id=${!!idUrls.id_front}, residency=${!!idUrls.cert_residency}, low_income=${!!idUrls.cert_low_income}, enrollment=${!!idUrls.cert_enrollment}`);
      } catch (idErr) {
        log.error(`ID verification insert failed (non-fatal): ${idErr.message}`);
      }
    } else {
      log.warn(`No documents received for @${newUser.username} — account saved without files. Check frontend FormData.`);
    }

    delete req.session.pendingRegistration;
    delete req.session.pendingGoogle;
    log.success(`Account created and pending approval: @${newUser.username} (${newUser.email})`);
    log.divider();

    // Account is pending approval — do NOT log them in yet
    sendAccountPendingEmail(newUser.email, newUser.firstName).catch(console.error);

    // Notify admin panel in real-time
    const io = req.app.get('io');
    if (io) {
      io.to('admins').emit('new-registration', {
        userId:    newUser.id,
        username:  newUser.username,
        firstName: newUser.firstName,
        lastName:  newUser.lastName,
        email:     newUser.email,
        createdAt: new Date().toISOString(),
      });
    }

    return res.json({
      success: true,
      pending: true,
      message: 'Registration submitted! An admin will review and approve your account shortly.',
    });
  } catch (err) {
    // ── Structured error diagnostics ──────────────────────────────────────
    const isUniquePhone = err.code === 'SQLITE_CONSTRAINT_UNIQUE' && err.message?.includes('users.phone');
    const isUniqueEmail = err.code === 'SQLITE_CONSTRAINT_UNIQUE' && err.message?.includes('users.email');
    const isUniqueUser  = err.code === 'SQLITE_CONSTRAINT_UNIQUE' && err.message?.includes('users.username');

    log.error('complete-registration failed');
    log.dump('Error details', {
      type:       err.constructor?.name || 'Error',
      code:       err.code             || '—',
      message:    err.message          || '—',
      phone_dup:  isUniquePhone,
      email_dup:  isUniqueEmail,
      user_dup:   isUniqueUser,
    });
    if (process.env.NODE_ENV === 'development') {
      // Print the first 6 stack frames for faster pinpointing
      const frames = (err.stack || '').split('\n').slice(1, 7).join('\n');
      log.error('Stack (dev):\n' + frames);
    }

    if (isUniquePhone) {
      return res.status(409).json({
        error: 'This phone number is already registered to another account.',
        field: 'phone',
        // dev hint surfaced to browser console
        _dev: process.env.NODE_ENV === 'development'
          ? 'SQLITE UNIQUE constraint on users.phone — use a different number or clear the DB.'
          : undefined,
      });
    }
    if (isUniqueEmail) {
      return res.status(409).json({ error: 'This email was just registered by someone else.', field: 'email' });
    }
    if (isUniqueUser) {
      return res.status(409).json({ error: 'Username already taken. Please choose another.', field: 'username' });
    }

    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ════════════════════════════════════════════════════
// POST /api/auth/login
// ════════════════════════════════════════════════════
router.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
    const lockStatus = checkLoginLock(email.trim());
    if (lockStatus.locked)
      return res.status(429).json({ error: `Account temporarily locked. Try again in ${lockStatus.minsLeft} minute${lockStatus.minsLeft !== 1 ? 's' : ''}.` });

    const user = findUserByEmail(email.trim());
    if (!user) {
      recordFailedLogin(email.trim());
      const remaining = checkLoginLock(email.trim());
      const hint = (!remaining.locked && remaining.attemptsLeft <= 3) ? ` (${remaining.attemptsLeft} attempt${remaining.attemptsLeft !== 1 ? 's' : ''} left)` : '';
      log.warn(`Login FAIL [no user]: ${email.trim()} — email not found in DB`);
      return res.status(401).json({ error: 'Invalid email or password.' + hint });
    }
    if (user.authProvider === 'google') {
      log.warn(`Login FAIL [google account]: ${email.trim()} — must use Google Sign-In`);
      return res.status(400).json({ error: 'This account uses Google Sign-In. Please use the Google button.' });
    }

    if (!user.password) {
      log.warn(`Login FAIL [no password]: @${user.username} (${email.trim()}) — account has no password set`);
      return res.status(401).json({
        error: 'Your account has no password set. Please use "Forgot Password" to create one.',
        code: 'NO_PASSWORD',
      });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      recordFailedLogin(email.trim());
      const remaining = checkLoginLock(email.trim());
      log.warn(`Login FAIL [wrong password]: @${user.username} (${email.trim()}) — ${remaining.attemptsLeft} attempts left`);
      if (remaining.locked) return res.status(429).json({ error: 'Too many failed attempts. Account locked for 15 minutes.' });
      const hint = remaining.attemptsLeft <= 3 ? ` (${remaining.attemptsLeft} attempt${remaining.attemptsLeft !== 1 ? 's' : ''} left before lockout)` : '';
      return res.status(401).json({ error: 'Invalid email or password.' + hint });
    }

    if (!user.isActive) {
      log.warn(`Login FAIL [banned]: @${user.username} (${email.trim()}) — is_active=0`);
      return res.status(403).json({ error: 'Your account has been suspended. Please contact support.' });
    }

    if (user.accountStatus === 'pending') {
      log.warn(`Login FAIL [pending]: @${user.username} (${email.trim()}) — account_status=pending`);
      return res.status(403).json({
        error: 'Your account is pending admin approval. You will receive an email once approved.',
        code: 'ACCOUNT_PENDING',
      });
    }
    if (user.accountStatus === 'rejected') {
      log.warn(`Login FAIL [rejected]: @${user.username} (${email.trim()}) — account_status=rejected`);
      return res.status(403).json({
        error: 'Your account registration was not approved. Please contact support.',
        code: 'ACCOUNT_REJECTED',
      });
    }

    clearLoginAttempts(email.trim());
    log.auth(`Login OK: @${user.username} (${email.trim()}) role=${user.role}`);
    req.login(user, (err) => {
      if (err) {
        log.error(`Login session error for @${user.username}: ${err.message}`);
        return res.status(500).json({ error: 'Login error. Please try again.' });
      }
      return res.json({
        success: true,
        message: `Welcome back, ${user.firstName}!`,
        user: { id: user.id, firstName: user.firstName, email: user.email, role: user.role, idVerified: user.idVerified },
      });
    });
  } catch (err) {
    log.error(`Login route unhandled error: ${err.message}`);
    return res.status(500).json({ error: 'Server error.' });
  }
});

// ════════════════════════════════════════════════════
// LOGOUT
// ════════════════════════════════════════════════════
router.get('/api/auth/logout', (req, res) => {
  req.logout((err) => {
    if (err) return res.status(500).json({ error: 'Logout failed.' });
    req.session.destroy(() => res.json({ success: true }));
  });
});

// ════════════════════════════════════════════════════
// CHECK USERNAME / PHONE
// ════════════════════════════════════════════════════
router.get('/api/auth/check-username', (req, res) => {
  const { username } = req.query;
  if (!username || !/^[a-zA-Z0-9_.]{3,20}$/.test(username))
    return res.status(400).json({ available: false, error: 'Invalid username format.' });
  return res.json({ available: !findUserByUsername(username), username });
});

router.get('/api/auth/check-phone', (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ available: false, error: 'Phone is required.' });
  const raw = phone.replace(/\D/g, '');
  let tenDigits;
  if (raw.length === 10 && raw[0] === '9')      tenDigits = raw;
  else if (raw.length === 11 && raw[0] === '0') tenDigits = raw.slice(1);
  else if (raw.length === 12 && raw.startsWith('63')) tenDigits = raw.slice(2);
  else return res.status(400).json({ available: false, error: 'Invalid phone format.' });
  return res.json({ available: !findUserByPhone('+63' + tenDigits) });
});

// ════════════════════════════════════════════════════
// ME / PENDING GOOGLE
// ════════════════════════════════════════════════════
router.get('/api/auth/me', (req, res) => {
  if (!req.isAuthenticated()) return res.json({ loggedIn: false });
  const u = req.user;
  return res.json({
    loggedIn: true,
    user: {
      id: u.id, firstName: u.firstName, lastName: u.lastName, email: u.email,
      username: u.username, avatar: u.avatar || null, idVerified: u.idVerified, authProvider: u.authProvider,
      role: u.role || 'user',
    }
  });
});

// ── Support AI chat — no login required ──────────────────────────────
// ── Contact admin without account (used by support chat escalation) ──
router.post('/api/auth/contact-admin', async (req, res) => {
  try {
    const { name, email, message } = req.body;
    if (!message?.trim() || message.trim().length < 5)
      return res.status(400).json({ error: 'Message is too short.' });
    if (message.trim().length > 2000)
      return res.status(400).json({ error: 'Message is too long (max 2000 chars).' });
    // Basic email format check if provided
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
      return res.status(400).json({ error: 'Invalid email address.' });

    // Send to the configured admin inbox, not back to the submitter
    const toEmail = process.env.ADMIN_EMAIL || process.env.EMAIL_USER || process.env.SENDGRID_FROM;
    const subject = `Support message from ${name?.trim() || 'Anonymous'}`;
    const result = await sendContactEmail(
      toEmail,
      name?.trim()  || 'Anonymous',
      email?.trim() || null,
      subject,
      message.trim()
    );
    if (!result.success)
      return res.status(500).json({ error: 'Failed to send message. Please email us directly.' });

    log.info(`Contact form submitted by ${name || 'anonymous'} (${email || 'no email'})`);
    return res.json({ success: true });
  } catch (err) {
    log.error(`contact-admin error: ${err.message}`);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ── AI support chat usage tracker (in-memory, resets daily) ─────────
// Dynamic daily limit based on pool size (each key = 20 RPD)
// Recalculated each time so it updates when keys are added
function getAiDailyLimit() {
  return Math.max(20, geminiPool.getStatus().keyCount * geminiPool.getStatus().rpdLimit);
}
const AI_DAILY_LIMIT = 20; // kept for in-memory counter cap (single key baseline)
let aiUsage = { count: 0, date: new Date().toDateString() };

function getAiUsage() {
  const today = new Date().toDateString();
  if (aiUsage.date !== today) { aiUsage = { count: 0, date: today }; } // reset at midnight
  return aiUsage;
}

// GET /api/auth/support-status — returns current daily AI usage (public, no auth needed)
router.get('/api/auth/support-status', (req, res) => {
  const ps = geminiPool.getStatus();
  const totalLimit = ps.keyCount * ps.rpdLimit;
  const totalUsed  = ps.keys ? ps.keys.reduce((a,k)=>a+k.rpdUsed, 0) : getAiUsage().count;
  res.json({
    used:    totalUsed,
    limit:   totalLimit || AI_DAILY_LIMIT,
    remaining: Math.max(0, (totalLimit || AI_DAILY_LIMIT) - totalUsed),
    keys:    ps.keyCount,
    availableKeys: ps.availableKeys,
  });
});

router.post('/api/auth/support-chat', async (req, res) => {
  try {
    const { message, history = [] } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'Message is required.' });
    if (message.trim().length > 1000) return res.status(400).json({ error: 'Message too long.' });

    const hasGithub     = !!process.env.GITHUB_TOKEN;
    const hasGemini     = geminiPool.getStatus().configured;

    if (!hasGemini && !hasGithub) {
      return res.json({
        reply: "I'm PGA-DAMIS Support. Our AI assistant isn't configured yet. " +
               "Please email us at **" + (process.env.ADMIN_EMAIL || process.env.EMAIL_USER || 'support@pgadamis.local') + "** and we'll get back to you shortly.",
        escalate: true,
      });
    }

    // ── Check daily quota via pool (covers all keys) ────────────────
    if (hasGemini) {
      const poolStatus = geminiPool.getStatus();
      if (poolStatus.availableKeys === 0 && poolStatus.keyCount > 0) {
        const secsUntilReset = poolStatus.secsUntilReset;
        const h = Math.floor(secsUntilReset / 3600);
        const m = Math.floor((secsUntilReset % 3600) / 60);
        const resetStr = h > 0 ? `${h}h ${m}m` : `${m} min`;
        const totalLimit = poolStatus.keyCount * poolStatus.rpdLimit;
        log.aiError(`Support chat: all ${poolStatus.keyCount} Gemini key(s) exhausted. Resets in ${resetStr}.`);
        return res.json({
          reply: `⚠️ The AI support chat has reached its **daily limit (${totalLimit} messages across ${poolStatus.keyCount} key${poolStatus.keyCount>1?'s':''})**. It resets in **${resetStr}**. For urgent help, email **${process.env.ADMIN_EMAIL || process.env.EMAIL_USER || 'support@pgadamis.local'}**.`,
          escalate: true,
          dailyLimitReached: true,
          used: totalLimit,
          limit: totalLimit,
          resetsInSecs: secsUntilReset,
        });
      }
    }

    const adminEmail   = process.env.ADMIN_EMAIL || process.env.EMAIL_USER || 'support@pgadamis.local';
    const appName      = process.env.APP_NAME || 'PGA-DAMIS';
    const systemPrompt = `You are the ${appName} Support Assistant, a friendly helpful AI for a Filipino social community platform.`
      + ` The admin support email is: ${adminEmail}.`
      + ' You help users with: registration (OTP, ID upload, pending approval, rejected accounts),'
      + ' login problems (forgot password, locked accounts, Google sign-in),'
      + ' account questions (profile, posts, notifications, messages),'
      + ' and general platform guidance.'
      + ' Rules:'
      + ' — Keep replies SHORT (1-3 sentences max) to save tokens.'
      + ' — For registration issues: remind users approval is manual and to check email.'
      + ' — For login issues: suggest the Forgot Password link on the login page.'
      + ' — For suspended/rejected accounts or issues you cannot resolve: say ESCALATE and give the admin email.'
      + ' — NEVER reveal, guess, or hint at any passwords or credentials.'
      + ' — Do NOT invent features that do not exist.'
      + ` — Respond in English by default; match the user language if they write in Filipino/Tagalog.`;

    // Build message history (cap at last 10 turns)
    const safeHistory = (history || []).slice(-6).map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content).slice(0, 300),
    }));
    safeHistory.push({ role: 'user', content: message.trim().slice(0, 300) });

    let reply = '';

    // ── Try Gemini pool (auto-rotates through all configured keys) ──────
    let activeGeminiKey = hasGemini ? geminiPool.getKey() : null;
    if (activeGeminiKey) {
      const geminiContents = safeHistory.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));
      const geminiBody = {
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: geminiContents,
        generationConfig: { maxOutputTokens: 400, temperature: 0.3 },
      };
      let rotated = false;
      while (activeGeminiKey) {
        const geminiUrl = geminiPool.buildUrl(activeGeminiKey);
        const geminiResp = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': activeGeminiKey },
          body: JSON.stringify(geminiBody),
        });
        if (geminiResp.ok) {
          geminiPool.trackRequest(activeGeminiKey);
          const geminiData = await geminiResp.json();
          reply = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
          // Update in-memory counter for /support-status display
          const u = getAiUsage(); u.count = Math.min(u.count + 1, AI_DAILY_LIMIT);
          break;
        }
        const errBody = await geminiResp.text().catch(() => '(no body)');
        let errDetail = errBody; try { errDetail = JSON.stringify(JSON.parse(errBody),null,2); } catch(_){}
        log.aiError(`Support chat Gemini key …${activeGeminiKey.slice(-6)} — HTTP ${geminiResp.status}\n${errDetail.slice(0,300)}`);
        if (geminiResp.status === 429) {
          const isRPD = geminiPool.markExhausted(activeGeminiKey, errBody);
          if (isRPD) {
            const nextKey = geminiPool.getKey();
            if (nextKey) {
              log.info(`Support chat rotating to key …${nextKey.slice(-6)}`);
              activeGeminiKey = nextKey;
              rotated = true;
              continue;
            }
            // All keys exhausted — return daily limit message
            const ps = geminiPool.getStatus();
            const secsUntilReset = ps.secsUntilReset;
            const h = Math.floor(secsUntilReset/3600), m = Math.floor((secsUntilReset%3600)/60);
            const resetStr = h>0?`${h}h ${m}m`:`${m} min`;
            const totalLimit = ps.keyCount * ps.rpdLimit;
            getAiUsage().count = AI_DAILY_LIMIT;
            return res.json({
              reply: `⚠️ The AI support chat has reached its **daily limit (${totalLimit} messages across ${ps.keyCount} key${ps.keyCount>1?'s':''})**. It resets in **${resetStr}**. For urgent help, email **${process.env.ADMIN_EMAIL || process.env.EMAIL_USER || 'support@pgadamis.local'}**.`,
              escalate: true, dailyLimitReached: true,
              used: totalLimit, limit: totalLimit, resetsInSecs: secsUntilReset,
            });
          } else {
            const retryAfter = parseInt(geminiResp.headers.get('Retry-After')||'30',10)||30;
            const timeStr = retryAfter<90?`${retryAfter} seconds`:`${Math.ceil(retryAfter/60)} min`;
            return res.json({ reply:`⏳ Too many requests. Please wait **${timeStr}** before sending again.`, escalate:false, retryAfter });
          }
        }
        throw new Error(`Gemini API error: ${geminiResp.status}`);
      }
    } else {
      // ── Fall back to DeepSeek-V3 via GitHub Models ──────────────────────
      const githubToken = process.env.GITHUB_TOKEN;
      if (!githubToken) throw new Error('No fallback AI configured. Add GITHUB_TOKEN to .env');
      log.info('Gemini unavailable — using DeepSeek-V3 (GitHub Models) for support chat.');
      const dsMessages = [{ role: 'system', content: systemPrompt }, ...safeHistory];
      const response = await fetch('https://models.github.ai/inference/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${githubToken.trim()}` },
        body: JSON.stringify({
          model: 'deepseek/DeepSeek-V3-0324',
          max_tokens: 400,
          temperature: 0.3,
          messages: dsMessages,
        }),
      });
      if (!response.ok) {
        const errBody = await response.text().catch(() => '(no body)');
        let errDetail = errBody;
        try { errDetail = JSON.stringify(JSON.parse(errBody), null, 2); } catch (_) {}
        log.aiError(`Support chat DeepSeek/GitHub — HTTP ${response.status}\n${errDetail.slice(0, 400)}`);
        throw new Error(`DeepSeek API error: ${response.status}`);
      }
      const data = await response.json();
      reply = data.choices?.[0]?.message?.content || '';
    }

    if (!reply) reply = 'Sorry, I could not process that. Please try again.';
    const escalate = reply.toUpperCase().includes('ESCALATE') || reply.toLowerCase().includes('email our admin');

    const ps2 = geminiPool.getStatus();
    const totalLimit2 = ps2.keyCount * ps2.rpdLimit || AI_DAILY_LIMIT;
    const totalUsed2  = ps2.keys ? ps2.keys.reduce((a,k)=>a+k.rpdUsed, 0) : getAiUsage().count;
    log.ai(`Support chat [${totalUsed2}/${totalLimit2}] — ${message.trim().slice(0, 50)} → ${reply.slice(0, 50)}`);
    return res.json({ reply, escalate, used: totalUsed2, limit: totalLimit2 });
  } catch (err) {
    log.aiError(`Support chat exception: ${err.message}`);
    return res.json({
      reply: "I'm having trouble right now. Please email us at **" + (process.env.ADMIN_EMAIL || process.env.EMAIL_USER || 'support@pgadamis.local') + "** and we'll help you shortly.",
      escalate: true,
    });
  }
});

// ── Support: return the first admin user ID so the UI can open a DM ──
router.get('/api/auth/support-admin', (req, res) => {
  const { db } = require('../utils/db');
  const admin = db.prepare(
    "SELECT id, first_name, last_name, username, avatar FROM users WHERE role IN ('admin','superadmin') AND is_active=1 ORDER BY created_at ASC LIMIT 1"
  ).get();
  if (!admin) return res.status(404).json({ error: 'No admin available.' });
  return res.json({
    id:        admin.id,
    firstName: admin.first_name,
    lastName:  admin.last_name,
    username:  admin.username,
    avatar:    admin.avatar || '',
  });
});

router.get('/api/auth/pending-google', (req, res) => {
  const pg = req.session.pendingGoogle;
  if (pg) return res.json({ pending: true, email: pg.email, firstName: pg.firstName, avatar: pg.avatar });
  return res.json({ pending: false });
});

// ════════════════════════════════════════════════════
// GOOGLE OAUTH
// ════════════════════════════════════════════════════
router.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

router.get('/auth/google/callback',
  (req, res, next) => {
    passport.authenticate('google', { session: false }, (err, user, info) => {
      if (err) return res.redirect('/?error=google_failed');
      if (user) {
        req.login(user, (e) => {
          if (e) return res.redirect('/?error=google_failed');
          return res.redirect('/feed.html');
        });
        return;
      }
      if (info?.message === 'pending_signup')  return res.redirect('/?google=pending_signup');
      if (info?.message === 'account_pending')  return res.redirect('/?error=google_pending');
      if (info?.message === 'account_rejected') return res.redirect('/?error=google_rejected');
      if (info?.message === 'account_suspended') return res.redirect('/?error=google_suspended');
      if (info?.message?.startsWith('email_taken:')) {
        const email = encodeURIComponent(info.message.split(':')[1]);
        return res.redirect(`/?error=google_email_taken&email=${email}`);
      }
      return res.redirect('/?error=google_failed');
    })(req, res, next);
  }
);

// ════════════════════════════════════════════════════
// PASSWORD RESET
// ════════════════════════════════════════════════════
router.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email?.trim()) return res.status(400).json({ error: 'Email address is required.' });
    const user = findUserByEmail(email.trim());
    if (!user) return res.json({ success: true, message: 'If that email exists, a reset code was sent.' });
    if (user.authProvider === 'google') return res.status(400).json({ error: 'This account uses Google Sign-In. No password to reset.' });
    const otp    = generateOTP();
    saveResetOTP(email.trim(), otp);
    const result = await sendPasswordResetEmail(email.trim(), otp, user.firstName);
    if (!result.success) return res.status(500).json({ error: 'Failed to send reset email. Please try again.' });
    return res.json({ success: true, message: 'Reset code sent.' });
  } catch (err) {
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

router.post('/api/auth/verify-reset-otp', (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ error: 'Email and code are required.' });
  const result = verifyResetOTP(email.trim(), otp.trim());
  if (!result.valid) return res.status(400).json({ error: result.reason });
  return res.json({ success: true });
});

router.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and new password are required.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    const consumed = consumeResetOTP(email.trim());
    if (!consumed) return res.status(400).json({ error: 'Reset session expired. Please start over.' });
    const user = findUserByEmail(email.trim());
    if (!user) return res.status(404).json({ error: 'Account not found.' });
    const { updateUser } = require('../utils/db');
    updateUser(user.id, { password: await bcrypt.hash(password, 12) });
    console.log('🔑 Password reset for:', email);
    return res.json({ success: true, message: 'Password updated successfully.' });
  } catch (err) {
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ── DOCX → PDF conversion (used by the registration document preview) ─────────
// Accepts a DOCX file upload and returns a PDF so the browser can show an
// accurate print-preview with formatting intact.  No auth required because this
// is called during account creation before the user has a session.
//
// POST /api/auth/convert-docx-to-pdf   multipart: 'file' field (DOCX)
// Returns: application/pdf stream, or JSON error on failure.
{
  const multer = require('multer');
  const os     = require('os');
  const fs     = require('fs');
  const path   = require('path');
  const { execFile } = require('child_process');

  const docxUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, cb) => {
      const ok = file.originalname.toLowerCase().endsWith('.docx') ||
                 file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      cb(ok ? null : new Error('Only .docx files are accepted'), ok);
    },
  }).single('file');

  router.post('/api/auth/convert-docx-to-pdf', (req, res) => {
    docxUpload(req, res, async (err) => {
      if (err) {
        log.warn('[docx-convert] Upload error:', err.message);
        return res.status(400).json({ error: err.message });
      }
      if (!req.file) {
        return res.status(400).json({ error: 'No DOCX file received.' });
      }

      // Write the uploaded buffer to a temp file so LibreOffice can read it
      const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'damis-docx-'));
      const inPath  = path.join(tmpDir, 'input.docx');
      const outPath = path.join(tmpDir, 'input.pdf');

      try {
        fs.writeFileSync(inPath, req.file.buffer);

        await new Promise((resolve, reject) => {
          // --headless --convert-to pdf --outdir <dir> <file>
          // LibreOffice names the output <basename>.pdf in the same outdir.
          execFile(
            'libreoffice',
            ['--headless', '--convert-to', 'pdf', '--outdir', tmpDir, inPath],
            { timeout: 30_000 },
            (convErr, _stdout, stderr) => {
              if (convErr) {
                log.warn('[docx-convert] LibreOffice error:', stderr || convErr.message);
                return reject(new Error('Conversion failed — LibreOffice error'));
              }
              resolve();
            }
          );
        });

        if (!fs.existsSync(outPath)) {
          throw new Error('PDF not generated — unexpected LibreOffice output');
        }

        const pdfBuf = fs.readFileSync(outPath);
        log.info(`[docx-convert] Converted ${req.file.originalname} → PDF (${pdfBuf.length} bytes)`);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline; filename="preview.pdf"');
        res.setHeader('Content-Length', pdfBuf.length);
        return res.send(pdfBuf);
      } catch (convErr) {
        log.warn('[docx-convert]', convErr.message);
        return res.status(500).json({ error: convErr.message });
      } finally {
        // Clean up temp files regardless of outcome
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
      }
    });
  });
}

module.exports = router;
