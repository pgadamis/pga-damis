/**
 * routes/admin.js — Admin API (v2 — Full Moderation Edition)
 */
const express = require('express');
const router  = express.Router();
const log      = require('../utils/logger');
const geminiPool = require('../utils/geminiPool');
const {
  db, findUserById,
  getPendingPosts, moderatePost, markPostAiReviewed,
  logAiModerationAction, getAiModerationLog,
  getPendingVerifications, getAllVerifications, reviewVerification, setVerificationAiResult,
  getAdminLogs, logAdminAction,
  banUser, unbanUser,
  getPendingAccounts, approveAccount, rejectAccount,
  archiveRejectedRegistration, getRejectedRegistrations, deleteRejectedRegistration,
  getFullUserProfile,
  findUserByEmail, findUserByUsername, findUserByPhone,
  createUser,
  createNotification,
  getDormRooms, assignBed, unassignBed,
  getDormBilling, generateMonthlyBills, generateBillForUser, markBillPaid, markBillUnpaid, waiveBill, setBillComment,
  clearBillReceipt,
  getSetting, setSetting,
  getAllUserReports, updateReportStatus, getReportCountByUser,
  getReputationScore,
  createMaintenanceRequest, getMaintenanceRequests, updateMaintenanceRequest, getMaintenanceStats,
  upsertUtilityBill, getUtilityBills, getUtilityTrend,
  nextAdmissionNo, semesterRollover,
  // DB Archives (full snapshots)
  createDbArchive, getDbArchives, getDbArchiveById, deleteDbArchiveById,
} = require('../utils/db');
const { sendAccountApprovedEmail, sendAccountRejectedEmail } = require('../utils/emailService');
const { multerUpload, toCloudinary, resizeImage, hasCloudinary } = require('../middleware/upload');

// Dedicated multer for .db backup file uploads — no image filter, memory storage only
const multer = require('multer');
const backupUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB max backup size
});

// trackAiRequest / markAiRateLimited are now handled by geminiPool
function trackAiRequest(key) { if(key) geminiPool.trackRequest(key); }
function markAiRateLimited(status, errBody, key) {
  const isRPD = key ? geminiPool.markExhausted(key, errBody) : false;
  if (!isRPD) log.aiError(`Admin AI — rate limit (non-RPD): ${errBody.slice(0,100)}`);
  return isRPD;
}

// Stash the error message on res so the request logger can display it inline with the 500 line.
// Use instead of res.status(500).json({error}) directly.
function send500(res, err, label = '') {
  const msg = err?.message || String(err);
  res._errMsg = label ? `${label}: ${msg}` : msg;
  res.status(500).json({ error: msg });
}

function requireAdmin(req, res, next) {
  const IS_DEV = process.env.NODE_ENV !== 'production';

  // ── Production: always enforce auth + role ───────────────────────────
  if (!IS_DEV) {
    if (!req.isAuthenticated || !req.isAuthenticated())
      return res.status(401).json({ error: 'Not authenticated.' });
    if (req.user.role !== 'admin' && req.user.role !== 'superadmin')
      return res.status(403).json({ error: 'Admin access required.' });
    return next();
  }

  // ── Development only: inject first admin when no session exists ──────
  // Allows multi-tab testing (admin panel + resident portal simultaneously)
  // without constantly switching accounts. Safe because NODE_ENV=production
  // takes the branch above and never reaches this.
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

// Notify a post author and emit socket event for AI moderation decisions
function notifyPostModeration(req, postUserId, postId, status, reason = '') {
  const io = req.app.get('io');
  if (status === 'approved') {
    createNotification({
      userId: postUserId, type: 'post_approved', actorId: req.user.id,
      targetId: postId,
      message: '✅ Your post has been reviewed and approved by AI moderation. It is now visible to everyone!',
    });
    if (io) {
      io.to(`user:${postUserId}`).emit('post_approved', { postId });
      io.to(`user:${postUserId}`).emit('new-notification', { userId: postUserId });
    }
  } else if (status === 'rejected') {
    createNotification({
      userId: postUserId, type: 'post_rejected', actorId: req.user.id,
      targetId: postId,
      message: reason
        ? `❌ Your post was removed by AI moderation: "${reason}"`
        : '❌ Your post was removed by AI moderation for violating community guidelines.',
    });
    if (io) {
      io.to(`user:${postUserId}`).emit('post_rejected', { postId, reason });
      io.to(`user:${postUserId}`).emit('new-notification', { userId: postUserId });
    }
  }
}

// ── Unified AI caller: Gemini pool (auto-rotates keys) → Anthropic fallback ──
async function callAI(systemPrompt, userContent, { retries = 1 } = {}) {
  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userContent }] }],
    generationConfig: { maxOutputTokens: 600, temperature: 0.2 },
  };

  // ── Try each available Gemini key in order ──────────────────────────
  let geminiKey = geminiPool.getKey();
  while (geminiKey) {
    const url = geminiPool.buildUrl(geminiKey);
    let resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
      body: JSON.stringify(body),
    });
    // Auto-retry once on 503
    if (!resp.ok && resp.status === 503 && retries > 0) {
      log.warn(`Gemini 503 on key …${geminiKey.slice(-6)} — retrying in 3s…`);
      await new Promise(r => setTimeout(r, 3000));
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
        body: JSON.stringify(body),
      });
    }
    if (resp.ok) {
      geminiPool.trackRequest(geminiKey);
      const data = await resp.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      try { return JSON.parse(text.replace(/```json|```/g, '').trim()); }
      catch { return { raw: text }; }
    }
    const errBody = await resp.text().catch(() => '');
    log.aiError(`Gemini API ${resp.status} on key …${geminiKey.slice(-6)} — ${errBody.slice(0, 200)}`);
    if (resp.status === 429) {
      const isRPD = geminiPool.markExhausted(geminiKey, errBody);
      if (isRPD) {
        // Try next key
        geminiKey = geminiPool.getKey();
        if (geminiKey) {
          log.info(`Rotating to next Gemini key …${geminiKey.slice(-6)}`);
          continue;
        }
      }
    }
    // Non-429 error or all keys exhausted
    const err = new Error(`Gemini API error: ${resp.status}`);
    err.status = resp.status;
    throw err;
  }

  // ── Fall back to DeepSeek-V3 via GitHub Models if all Gemini keys exhausted ──
  const githubToken = process.env.GITHUB_TOKEN;
  if (githubToken) {
    log.info('All Gemini keys exhausted — falling back to DeepSeek-V3 (GitHub Models).');
    const response = await fetch('https://models.github.ai/inference/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${githubToken.trim()}` },
      body: JSON.stringify({
        model: 'deepseek/DeepSeek-V3-0324',
        max_tokens: 600,
        temperature: 0.3,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContent }],
      }),
    });
    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      log.aiError(`DeepSeek/GitHub API ${response.status} — ${errBody.slice(0, 300)}`);
      throw new Error(`DeepSeek API error: ${response.status}`);
    }
    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || '';
    try { return JSON.parse(text.replace(/```json|```/g, '').trim()); }
    catch { return { raw: text }; }
  }

  throw new Error('All AI keys exhausted. Set additional GEMINI_API_KEY_2, _3 etc. or add GITHUB_TOKEN for DeepSeek fallback.');
}

// Keep old name as alias so existing callClaude() calls still work
const callClaude = callAI;

// ── Stats ──────────────────────────────────────────────
router.get('/api/admin/stats', requireAdmin, (req, res) => {
  // All counts scoped to approved accounts only — rejected/pending are not active users
  const totalUsers    = db.prepare("SELECT COUNT(*) as c FROM users WHERE account_status = 'approved'").get().c;
  const totalPosts    = db.prepare('SELECT COUNT(*) as c FROM posts').get().c;
  const pendingPosts  = db.prepare("SELECT COUNT(*) as c FROM posts WHERE status = 'pending'").get().c;
  const rejectedPosts = db.prepare("SELECT COUNT(*) as c FROM posts WHERE status = 'rejected'").get().c;
  const verifiedUsers = db.prepare("SELECT COUNT(*) as c FROM users WHERE id_verified = 1 AND account_status = 'approved'").get().c;
  const googleUsers   = db.prepare("SELECT COUNT(*) as c FROM users WHERE auth_provider = 'google' AND account_status = 'approved'").get().c;
  const totalComments = db.prepare('SELECT COUNT(*) as c FROM comments').get().c;
  const totalLikes    = db.prepare('SELECT COUNT(*) as c FROM likes').get().c;
  const totalFollows  = db.prepare('SELECT COUNT(*) as c FROM follows').get().c;
  const bannedUsers   = db.prepare("SELECT COUNT(*) as c FROM users WHERE is_active = 0 AND account_status = 'approved'").get().c;
  const pendingVerif     = db.prepare("SELECT COUNT(*) as c FROM id_verification_requests WHERE status = 'pending'").get().c;
  const pendingAccounts  = db.prepare("SELECT COUNT(*) as c FROM users WHERE account_status = 'pending'").get().c;
  // All approved non-admin residents (including those not yet assigned a bed)
  const totalResidents   = db.prepare("SELECT COUNT(*) as c FROM users WHERE account_status='approved' AND role='user' AND is_active=1").get().c;
  const assignedResidents= db.prepare("SELECT COUNT(*) as c FROM bed_assignments ba JOIN users u ON u.id=ba.user_id WHERE u.account_status='approved'").get().c;
  const unassignedResidents = totalResidents - assignedResidents;
  res.json({ totalUsers, totalPosts, pendingPosts, rejectedPosts, verifiedUsers,
             googleUsers, totalComments, totalLikes, totalFollows, bannedUsers,
             pendingVerif, pendingAccounts,
             totalResidents, assignedResidents, unassignedResidents });
});

// ── Users ──────────────────────────────────────────────
router.get('/api/admin/users', requireAdmin, (req, res) => {
  // Only show approved accounts — pending belongs in Registrations tab, rejected are not users
  // NOTE: sex, course, year_level are required by the dormitory assignment gender-filter on the client.
  const rows = db.prepare(`
    SELECT u.id, u.first_name, u.middle_name, u.last_name, u.username, u.email, u.auth_provider,
      u.id_verified, u.is_active, u.role, u.avatar, u.created_at, u.account_status,
      u.sex, u.course, u.year_level,
      u.present_address, u.permanent_address,
      dr.room_number, ba.bed_number
    FROM users u
    LEFT JOIN bed_assignments ba ON ba.user_id = u.id
    LEFT JOIN dorm_rooms dr ON dr.id = ba.room_id
    WHERE u.account_status = 'approved'
    ORDER BY u.created_at DESC`).all();
  const users = rows.map(r => ({
    id: r.id, firstName: r.first_name, middleName: r.middle_name || '',
    lastName: r.last_name, username: r.username,
    email: r.email, authProvider: r.auth_provider, idVerified: !!r.id_verified,
    isActive: !!r.is_active, role: r.role, avatar: r.avatar, createdAt: r.created_at,
    accountStatus: r.account_status,
    sex: r.sex || '',            // Required for dormitory gender-room matching
    course: r.course || '',
    yearLevel: r.year_level || '',
    presentAddress:   r.present_address   || '',
    permanentAddress: r.permanent_address || '',
    roomNumber: r.room_number || '',   // Bed assignment (null if unassigned)
    bedNumber:  r.bed_number  || '',
  }));
  res.json({ users });
});

router.put('/api/admin/users/:id/verify', requireAdmin, (req, res) => {
  if (!findUserById(req.params.id)) return res.status(404).json({ error: 'User not found.' });
  db.prepare("UPDATE users SET id_verified = 1, updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  logAdminAction(req.user.id, 'user_verified', 'user', req.params.id);
  res.json({ success: true });
});

router.put('/api/admin/users/:id/role', requireAdmin, (req, res) => {
  const { role } = req.body;
  if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: 'Invalid role.' });
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Cannot change your own role.' });
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);
  logAdminAction(req.user.id, `role_changed_to_${role}`, 'user', req.params.id);
  res.json({ success: true });
});

router.put('/api/admin/users/:id/ban', requireAdmin, (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Cannot ban yourself.' });
  banUser(req.params.id, req.user.id);
  res.json({ success: true });
});

router.put('/api/admin/users/:id/unban', requireAdmin, (req, res) => {
  unbanUser(req.params.id, req.user.id);
  res.json({ success: true });
});

router.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const targetId = req.params.id;
  // Safety: never delete yourself (even in bypass mode, check by id)
  if (req.user && targetId === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself.' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  // ── Archive before hard-delete ──────────────────────────
  try {
    const idDocs = db.prepare('SELECT * FROM id_verification_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(targetId);
    db.prepare(`
      INSERT OR REPLACE INTO deleted_users
        (id, original_id, first_name, middle_name, last_name, suffix, username, email, phone,
         birthday, sex, civil_status, bio, location, avatar, auth_provider, role,
         present_address, permanent_address, school_name, course, year_level, school_address,
         father_info, mother_info, monthly_income,
         id_front_url, id_back_url, selfie_url,
         cert_residency_url, cert_low_income_url, cert_enrollment_url,
         original_created_at, deleted_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      require('crypto').randomUUID(), targetId,
      user.first_name, user.middle_name||'', user.last_name, user.suffix||'',
      user.username, user.email, user.phone||'',
      user.birthday||'', user.sex||'', user.civil_status||'', user.bio||'', user.location||'',
      user.avatar||'', user.auth_provider||'local', user.role||'user',
      user.present_address||'', user.permanent_address||'',
      user.school_name||'', user.course||'', user.year_level||'', user.school_address||'',
      user.father_info||'', user.mother_info||'', user.monthly_income||'',
      idDocs?.id_front_url||'', idDocs?.id_back_url||'', idDocs?.selfie_url||'',
      idDocs?.cert_residency_url||'', idDocs?.cert_low_income_url||'', idDocs?.cert_enrollment_url||'',
      user.created_at||'', req.user?.id || 'system'
    );
  } catch(archiveErr) {
    log.warn(`Archive before delete failed (non-fatal): ${archiveErr.message}`);
  }

  // ── Clear FK-constrained rows that lack ON DELETE CASCADE ──
  db.prepare('DELETE FROM bed_assignments WHERE user_id = ?').run(targetId);
  db.prepare('DELETE FROM dorm_billing    WHERE user_id = ?').run(targetId);

  // ── Hard delete (all other FK tables have ON DELETE CASCADE) ──
  logAdminAction(req.user?.id || 'system', 'user_deleted', 'user', targetId, `@${user.username} (${user.email})`);
  db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
  log.admin(`🗑 DELETED user @${user.username} (${user.email}) — by @${req.user?.username || 'system'}`);
  res.json({ success: true });
});

// ── Deleted Users Archive ─────────────────────────────
router.get('/api/admin/users/deleted', requireAdmin, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT d.*, a.username as deleted_by_username
      FROM deleted_users d
      LEFT JOIN users a ON a.id = d.deleted_by
      ORDER BY d.deleted_at DESC
      LIMIT 200
    `).all();
    res.json({ users: rows });
  } catch(e) { send500(res, e); }
});

router.post('/api/admin/users/deleted/:id/restore', requireAdmin, (req, res) => {
  try {
    const rec = db.prepare('SELECT * FROM deleted_users WHERE id = ?').get(req.params.id);
    if (!rec) return res.status(404).json({ error: 'Archived user not found.' });

    if (findUserByEmail(rec.email))    return res.status(409).json({ error: `Email ${rec.email} is already registered.` });
    if (findUserByUsername(rec.username)) return res.status(409).json({ error: `Username @${rec.username} is already taken.` });

    const restored = createUser({
      email: rec.email, firstName: rec.first_name, middleName: rec.middle_name,
      lastName: rec.last_name, suffix: rec.suffix, username: rec.username,
      birthday: rec.birthday, sex: rec.sex, civilStatus: rec.civil_status,
      phone: rec.phone, bio: rec.bio, location: rec.location, avatar: rec.avatar,
      authProvider: rec.auth_provider, role: rec.role,
      presentAddress: rec.present_address, permanentAddress: rec.permanent_address,
      schoolName: rec.school_name, course: rec.course, yearLevel: rec.year_level,
      schoolAddress: rec.school_address, fatherInfo: rec.father_info,
      motherInfo: rec.mother_info, monthlyIncome: rec.monthly_income,
      emailVerified: true, idVerified: false, accountStatus: 'pending',
    });

    if (rec.id_front_url || rec.selfie_url) {
      const { submitIdVerification } = require('../utils/db');
      try {
        submitIdVerification({
          userId: restored.id,
          idFrontUrl: rec.id_front_url||'', idBackUrl: rec.id_back_url||'',
          selfieUrl: rec.selfie_url||'', idType: 'school_id',
          certResidencyUrl: rec.cert_residency_url||'',
          certLowIncomeUrl: rec.cert_low_income_url||'',
          certEnrollmentUrl: rec.cert_enrollment_url||'',
        });
      } catch(e) { log.error(`Doc re-attach on restore failed: ${e.message}`); }
    }

    db.prepare('DELETE FROM deleted_users WHERE id = ?').run(req.params.id);
    logAdminAction(req.user?.id, 'deleted_user_restored', 'user', restored.id, `Restored @${restored.username} from deleted archive`);
    log.admin(`♻ RESTORED deleted user @${restored.username} — by @${req.user?.username}`);
    res.json({ success: true, userId: restored.id });
  } catch(e) { send500(res, e); }
});

router.delete('/api/admin/users/deleted/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM deleted_users WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── Post Moderation ────────────────────────────────────
router.get('/api/admin/posts/pending', requireAdmin, (req, res) => {
  const posts = getPendingPosts({ page: parseInt(req.query.page) || 1, limit: 20 });
  res.json({ posts });
});

router.get('/api/admin/posts/all', requireAdmin, (req, res) => {
  const limit  = parseInt(req.query.limit) || 20;
  const offset = (parseInt(req.query.page || 1) - 1) * limit;
  const rows = db.prepare(`
    SELECT p.*, u.first_name, u.last_name, u.username, u.avatar,
      (SELECT COUNT(*) FROM likes WHERE target_id=p.id AND target_type='post') AS like_count,
      (SELECT COUNT(*) FROM comments WHERE post_id=p.id) AS comment_count
    FROM posts p JOIN users u ON p.user_id=u.id
    ORDER BY p.created_at DESC LIMIT ? OFFSET ?`).all(limit, offset);
  const posts = rows.map(r => ({
    id: r.id, content: r.content, imageUrl: r.image_url, privacy: r.privacy,
    status: r.status || 'approved', createdAt: r.created_at,
    likeCount: r.like_count, commentCount: r.comment_count,
    author: { firstName: r.first_name, lastName: r.last_name, username: r.username, avatar: r.avatar },
  }));
  res.json({ posts });
});

router.put('/api/admin/posts/:id/approve', requireAdmin, (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  moderatePost(req.params.id, 'approved', req.user.id);
  // Notify the post author
  createNotification({
    userId: post.user_id, type: 'post_approved', actorId: req.user.id,
    targetId: post.id, message: 'Your post has been approved and is now visible to everyone! ✅',
  });
  const io = req.app.get('io');
  if (io) {
    io.to(`user:${post.user_id}`).emit('post_approved', { postId: req.params.id });
    io.to(`user:${post.user_id}`).emit('new-notification', { userId: post.user_id });
  }
  res.json({ success: true });
});

router.put('/api/admin/posts/:id/reject', requireAdmin, (req, res) => {
  const { reason = '' } = req.body;
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  moderatePost(req.params.id, 'rejected', req.user.id);
  // Notify the post author
  createNotification({
    userId: post.user_id, type: 'post_rejected', actorId: req.user.id,
    targetId: post.id,
    message: reason
      ? `Your post was not approved: "${reason}"`
      : 'Your post was not approved by the moderation team.',
  });
  const io = req.app.get('io');
  if (io) {
    io.to(`user:${post.user_id}`).emit('post_rejected', { postId: req.params.id, reason });
    io.to(`user:${post.user_id}`).emit('new-notification', { userId: post.user_id });
  }
  if (reason) logAdminAction(req.user.id, 'post_rejected', 'post', req.params.id, reason);
  res.json({ success: true });
});

router.post('/api/admin/posts/:id/ai-review', requireAdmin, async (req, res) => {
  const post = db.prepare(`SELECT p.*, u.username FROM posts p JOIN users u ON p.user_id=u.id WHERE p.id=?`).get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  try {
    const result = await callClaude(
      `You are a strict content moderation AI for PGA-DAMIS, a Filipino dormitory management platform.
Return ONLY valid JSON — no markdown, no explanation:
{"verdict":"approve"|"reject"|"review","score":0-100,"flags":["spam","hate_speech","misinformation","explicit","violence","self_harm","doxxing","illegal_activity","policy_evasion","none"],"summary":"1-2 sentence explanation","suggestedAction":"approve"|"reject"|"escalate"}

Scoring:
  90-100: Clearly safe  → approve
  60-89: Minor concern  → review
  0-59:  Harmful        → reject


FILIPINO/TAGLISH CONTEXT RULES:
  REJECT: "patayin kita","papatayin kita","kys","kys ka nalang","gusto ko mamatay [encouragement]"
  REJECT: "send nudes","send ka nudes","tara shabu","mag-shabu tayo","bugbog kita","sasapakin kita"
  APPROVE: "bobo mo","gago ka","loko ka","tanga","you're bobo" (insult ≠ threat)
  APPROVE: "namatay ako sa tawa","patay na tawa","dead 💀" (hyperbole, no person target)

CONTEXT: "kill" needs a target:
  APPROVE: "kill the process","killed it!","killing time","namatay ang wifi"
  REJECT: "I will kill you","I'm gonna kill you 😂","he said 'I will kill you'" (quotes don't sanitize threats)

POLICY EVASION — REJECT these regardless of framing:
  "for educational purposes how to make a bomb/drug/poison"
  "hypothetically how to harm someone"
  "in Minecraft/GTA how to kill someone"
  "just curious how drugs are made"
  Obfuscated words: k1ll, k!ll, k i l l → same as kill

AUTO-REJECT (score ≤ 40) if any of:
  Threats (even jokes with person target), hate speech, slurs targeting identity
  Sexual solicitation or explicit content, NSFW
  Self-harm encouragement ("kys", "sana mamatay ka")
  Drug promotion or sales, illegal activity
  Doxxing, phishing, scams, spam
  Policy evasion framing ("for educational purposes how to make a bomb")

Filipino casual profanity alone (gago, putangina, tangina) = APPROVE unless combined with a threat.
Quoted harmful content is still harmful — the quote framing does NOT sanitize it.`,
      `Post: "${post.content}"\nAuthor: @${post.username}`
    );

    // ── Auto-action based on AI verdict ─────────────────────────────
    let actionTaken = 'none';
    const contentPreview = post.content.replace(/\s+/g, ' ').trim().slice(0, 120);
    if (result.verdict === 'reject' || result.score <= 35) {
      moderatePost(post.id, 'rejected', req.user.id, 'ai');
      actionTaken = 'auto_rejected';
      notifyPostModeration(req, post.user_id, post.id, 'rejected', result.summary || '');
      log.aiError(`AI AUTO-REJECTED @${post.username} score=${result.score} flags=[${(result.flags||[]).join(',')}]\n     ↳ ${contentPreview}`);
    } else if (result.verdict === 'approve' && result.score >= 85) {
      moderatePost(post.id, 'approved', req.user.id, 'ai');
      actionTaken = 'auto_approved';
      notifyPostModeration(req, post.user_id, post.id, 'approved');
      log.ai(`AI auto-approved @${post.username} score=${result.score}\n     ↳ ${contentPreview}`);
    } else {
      markPostAiReviewed(post.id);
      log.ai(`AI → manual review @${post.username} score=${result.score} verdict=${result.verdict}\n     ↳ ${result.summary||contentPreview}`);
    }

    // ── Log to DB ────────────────────────────────────────────────────
    logAiModerationAction({
      postId: post.id, postContent: post.content, authorUsername: post.username,
      verdict: result.verdict, score: result.score, flags: result.flags,
      summary: result.summary, actionTaken,
    });
    logAdminAction(req.user.id, 'ai_post_review', 'post', req.params.id,
      `AI verdict:${result.verdict} score:${result.score} action:${actionTaken}`);

    res.json({ result, postId: req.params.id, actionTaken });
  } catch (err) {
    const errMsg = err.message || '';
    const is429  = err.status === 429 || /429/.test(errMsg);
    const is503  = err.status === 503 || /503|unavailable|overload/i.test(errMsg);
    log.aiError(`Post AI review — ${errMsg}`);
    if (is429) {
      return res.status(429).json({ error: 'AI daily/rate limit reached. Wait before retrying.' });
    }
    res.status(is503 ? 503 : 500).json({
      error: is503 ? 'Gemini is temporarily overloaded. Please retry in a moment.' : 'AI review failed.',
    });
  }
});

router.post('/api/admin/posts/ai-bulk-review', requireAdmin, async (req, res) => {
  // Always fetch ALL pending posts — bulk review forces a decision on every one
  const pending = getPendingPosts({ limit: 50 });
  if (!pending.length) return res.json({ results: [], message: 'No pending posts to review.' });

  const results = [];
  let approved = 0, rejected = 0, skipped = 0;
  const delay = (ms) => new Promise(r => setTimeout(r, ms));

  const BULK_PROMPT = `You are a strict content moderation AI for PGA-DAMIS, a Filipino dormitory management platform.
Return ONLY valid JSON — no markdown:
{"verdict":"approve"|"reject","score":0-100,"flags":["spam","hate_speech","explicit","violence","self_harm","illegal_activity","doxxing","policy_evasion","none"],"summary":"one sentence reason"}

Choose ONLY "approve" or "reject" — no "review". Every post must get a final binary decision.

FILIPINO/TAGLISH RULES:
  REJECT: "patayin kita","papatayin kita","kys","kys ka nalang","sana mamatay ka"
  REJECT: "send nudes","tara shabu","mag-shabu tayo","bugbog kita","sasapakin kita"
  APPROVE: "bobo ka","gago ka","loko ka" (insult without threat), "namatay ako sa tawa" (hyperbole)

"kill" context: "kill the process / killed it / killing time" = APPROVE. "I will kill you / I'm gonna kill you 😂" = REJECT.
Quotes: "he said 'I will kill you'" = REJECT. Quoting harmful content is still harmful.
Obfuscation: "k1ll","k!ll","k i l l" = same as "kill". Don't be fooled.

POLICY EVASION — REJECT regardless of framing:
  "for educational purposes how to make [bomb/drug/poison]"
  "hypothetically how to harm someone"
  "in Minecraft/GTA how to kill someone"
  "just curious how drugs/meth/shabu are made"

REJECT (score < 55): threats, hate speech, sexual content, self-harm encouragement, drug promotion, doxxing, phishing, scams, policy evasion.
APPROVE (score >= 55): normal posts, stories, opinions, casual Filipino/Taglish, rants, memes.
When in doubt → REJECT.`;

  log.ai(`Bulk AI review started — ${pending.length} post(s) to process`);

  for (const post of pending) {
    try {
      const contentPreview = post.content.replace(/\s+/g, ' ').trim().slice(0, 120);
      const result = await callClaude(
        BULK_PROMPT,
        `Post by @${post.author?.username || '?'}: "${post.content.substring(0, 600)}"`
      );

      let actionTaken = 'none';
      if (result.verdict === 'reject' || result.score <= 35) {
        moderatePost(post.id, 'rejected', req.user.id, 'ai');
        actionTaken = 'auto_rejected';
        rejected++;
        notifyPostModeration(req, post.userId, post.id, 'rejected', result.summary || '');
        log.aiError(`Bulk AUTO-REJECTED @${post.author?.username} score=${result.score} flags=[${(result.flags||[]).join(',')}]\n     ↳ ${contentPreview}`);
      } else if (result.score >= 85 && result.verdict === 'approve') {
        moderatePost(post.id, 'approved', req.user.id, 'ai');
        actionTaken = 'auto_approved';
        approved++;
        notifyPostModeration(req, post.userId, post.id, 'approved');
        log.ai(`Bulk auto-approved @${post.author?.username} score=${result.score}\n     ↳ ${contentPreview}`);
      } else {
        // Score is borderline — force a decision based on score
        if (result.score >= 55) {
          moderatePost(post.id, 'approved', req.user.id, 'ai');
          actionTaken = 'auto_approved';
          approved++;
          notifyPostModeration(req, post.userId, post.id, 'approved');
          log.ai(`Bulk force-approved @${post.author?.username} score=${result.score} (borderline)\n     ↳ ${contentPreview}`);
        } else {
          moderatePost(post.id, 'rejected', req.user.id, 'ai');
          actionTaken = 'auto_rejected';
          rejected++;
          notifyPostModeration(req, post.userId, post.id, 'rejected', result.summary || '');
          log.aiError(`Bulk force-rejected @${post.author?.username} score=${result.score} (borderline)\n     ↳ ${contentPreview}`);
        }
      }

      logAiModerationAction({
        postId: post.id, postContent: post.content, authorUsername: post.author?.username,
        verdict: result.verdict, score: result.score, flags: result.flags,
        summary: result.summary, actionTaken,
      });
      results.push({ postId: post.id, result, content: post.content.substring(0, 120), actionTaken });
      await delay(800);
    } catch (bulkErr) {
      const is429 = bulkErr.status === 429 || /429/.test(bulkErr.message);
      if (is429) {
        log.aiError(`Bulk stopped at post ${post.id} — all API keys exhausted. ${results.length} posts processed so far.`);
        results.push({ postId: post.id, result: { verdict: 'review', score: 50, summary: 'All API keys exhausted — skipped' }, actionTaken: 'skipped' });
        break;
      }
      const is503 = bulkErr.status === 503 || /503|unavailable/.test(bulkErr.message);
      log.aiError(`Bulk post ${post.id} ${is503 ? '503 overloaded' : 'error'}: ${bulkErr.message.slice(0,80)}`);
      results.push({ postId: post.id, result: { verdict: 'review', score: 50, summary: is503 ? 'Gemini overloaded' : 'AI error' }, actionTaken: 'none' });
    }
  }

  const summary = { approved, rejected, skipped, total: results.length };
  log.ai(`Bulk complete — ✔ ${approved} approved | ✖ ${rejected} rejected | ⏸ ${skipped} manual review | ${results.length} processed`);
  logAdminAction(req.user.id, 'ai_bulk_review', null, null,
    `Bulk: ${approved} approved, ${rejected} rejected, ${skipped} manual out of ${results.length}`);
  res.json({ results, summary });
});

// ── ID Verification ────────────────────────────────────
router.get('/api/admin/verifications', requireAdmin, (req, res) => {
  res.json({ verifications: getAllVerifications({ page: parseInt(req.query.page) || 1, limit: 20 }) });
});

router.get('/api/admin/verifications/pending', requireAdmin, (req, res) => {
  res.json({ verifications: getPendingVerifications({ limit: 50 }) });
});

router.put('/api/admin/verifications/:id/approve', requireAdmin, (req, res) => {
  const v = db.prepare('SELECT * FROM id_verification_requests WHERE id = ?').get(req.params.id);
  if (!v) return res.status(404).json({ error: 'Verification not found.' });
  reviewVerification(req.params.id, { status: 'approved', adminNotes: req.body.notes || '', adminId: req.user.id });
  createNotification({
    userId: v.user_id, type: 'id_verified', actorId: req.user.id, targetId: req.params.id,
    message: 'Your ID verification has been approved! You now have a verified badge. ✓',
  });
  const io = req.app.get('io');
  if (io) io.to(`user:${v.user_id}`).emit('new-notification', { userId: v.user_id });
  res.json({ success: true });
});

router.put('/api/admin/verifications/:id/reject', requireAdmin, (req, res) => {
  const v = db.prepare('SELECT * FROM id_verification_requests WHERE id = ?').get(req.params.id);
  if (!v) return res.status(404).json({ error: 'Verification not found.' });
  reviewVerification(req.params.id, { status: 'rejected', adminNotes: req.body.notes || '', adminId: req.user.id });
  createNotification({
    userId: v.user_id, type: 'id_rejected', actorId: req.user.id, targetId: req.params.id,
    message: req.body.notes
      ? `Your ID verification was not approved: "${req.body.notes}". Please resubmit with clearer photos.`
      : 'Your ID verification was not approved. Please resubmit with clearer photos.',
  });
  const io = req.app.get('io');
  if (io) io.to(`user:${v.user_id}`).emit('new-notification', { userId: v.user_id });
  res.json({ success: true });
});

router.post('/api/admin/verifications/:id/ai-review', requireAdmin, async (req, res) => {
  const v = db.prepare(`SELECT v.*, u.first_name, u.last_name, u.username, u.birthday, u.email
    FROM id_verification_requests v JOIN users u ON v.user_id=u.id WHERE v.id=?`).get(req.params.id);
  if (!v) return res.status(404).json({ error: 'Verification not found.' });
  try {
    const result = await callClaude(
      `You are an ID verification assistant for PGA-DAMIS Philippines. Based on metadata only (no images), give a risk assessment.
Return ONLY JSON: {"recommendation":"approve"|"reject"|"manual_review","score":0-100,"riskFactors":[],"notes":"1-2 sentences","suggestedQuestions":[]}`,
      `Name: ${v.first_name} ${v.last_name}\nUsername: @${v.username}\nEmail: ${v.email}\nBirthday: ${v.birthday||'N/A'}\nID Type: ${v.id_type}\nHas front: ${v.id_front_url?'yes':'no'}\nHas back: ${v.id_back_url?'yes':'no'}\nHas selfie: ${v.selfie_url?'yes':'no'}\nSubmitted: ${v.created_at}`
    );
    setVerificationAiResult(req.params.id, { aiScore: result.score || null, aiNotes: JSON.stringify(result) });
    logAdminAction(req.user.id, 'ai_verif_review', 'verification', req.params.id, `AI: ${result.recommendation}`);
    res.json({ result });
  } catch (err) {
    log.aiError(`Verif AI review — ${err.message}`);
    send500(res, err, 'AI review failed');
  }
});

// ── Account Approval ──────────────────────────────────
router.get('/api/admin/accounts/pending', requireAdmin, (req, res) => {
  const accounts = getPendingAccounts();
  res.json({ accounts });
});

router.put('/api/admin/accounts/:id/approve', requireAdmin, async (req, res) => {
  const user = findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  if (user.accountStatus !== 'pending')
    return res.status(400).json({ error: 'Account is not pending.' });

  approveAccount(req.params.id);

  // Also approve any pending ID verification for this user (registration + ID = one workflow)
  db.prepare(`UPDATE id_verification_requests SET status='approved', reviewed_by=?, reviewed_at=datetime('now') WHERE user_id=? AND status='pending'`).run(req.user.id, req.params.id);
  db.prepare(`UPDATE users SET id_verified=1, updated_at=datetime('now') WHERE id=?`).run(req.params.id);

  logAdminAction(req.user.id, 'account_approved', 'user', req.params.id, `Approved registration for @${user.username}`);
  log.admin(`✔ APPROVED account @${user.username} (${user.email}) — by admin @${req.user.username}`);

  // Notify admin panel
  const io = req.app.get('io');
  if (io) io.to('admins').emit('account-approved', { userId: req.params.id });

  // Email the user
  sendAccountApprovedEmail(user.email, user.firstName).catch(e => log.error(`Approval email failed: ${e.message}`));

  res.json({ success: true });
});

router.put('/api/admin/accounts/:id/reject', requireAdmin, async (req, res) => {
  const { reason = '' } = req.body;
  const user = findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  if (user.accountStatus !== 'pending')
    return res.status(400).json({ error: 'Account is not pending.' });

  // Log BEFORE deleting so we have the user info in the audit trail
  logAdminAction(req.user.id, 'account_rejected', 'user', req.params.id, `Rejected registration for @${user.username}: ${reason}`);
  log.admin(`✖ REJECTED account @${user.username} (${user.email}) — reason: "${reason || 'none'}" — by @${req.user.username}`);

  // Send rejection email BEFORE deleting (we still need user.email / user.firstName)
  sendAccountRejectedEmail(user.email, user.firstName, reason).catch(e => log.error(`Rejection email failed: ${e.message}`));

  // ── Archive to rejected_registrations so admin can review/restore later ──
  const idDocs = db.prepare('SELECT * FROM id_verification_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(req.params.id);
  archiveRejectedRegistration({ user, idDocs, reason, rejectedBy: req.user.id });

  // ── Hard-delete: removes from users + cascades id_verification_requests etc.
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);

  const io = req.app.get('io');
  if (io) io.to('admins').emit('account-rejected', { userId: req.params.id });

  res.json({ success: true });
});

// ── Rejected Registrations Archive ────────────────────
router.get('/api/admin/accounts/rejected', requireAdmin, (req, res) => {
  res.json({ accounts: getRejectedRegistrations() });
});

router.delete('/api/admin/accounts/rejected/:id', requireAdmin, (req, res) => {
  deleteRejectedRegistration(req.params.id);
  logAdminAction(req.user.id, 'rejected_record_deleted', 'rejected_registration', req.params.id);
  res.json({ success: true });
});

router.post('/api/admin/accounts/rejected/:id/restore', requireAdmin, (req, res) => {
  const rec = db.prepare('SELECT * FROM rejected_registrations WHERE id = ?').get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'Rejected record not found.' });

  // Guard: don't restore if email/username/phone already taken by an active account
  if (findUserByEmail(rec.email))
    return res.status(409).json({ error: `Email ${rec.email} is already registered to another account.` });
  if (findUserByUsername(rec.username))
    return res.status(409).json({ error: `Username @${rec.username} is already taken.` });
  if (rec.phone && findUserByPhone(rec.phone))
    return res.status(409).json({ error: `Phone number is already registered to another account.` });

  // Re-create the user as pending — restore original password hash if available
  const restored = createUser({
    email:        rec.email,
    password:     rec.password_hash || null,
    firstName:    rec.first_name,
    middleName:   rec.middle_name || '',
    lastName:     rec.last_name,
    suffix:       rec.suffix || '',
    username:     rec.username,
    birthday:     rec.birthday || '',
    sex:          rec.sex || '',
    phone:        rec.phone || null,
    bio:          rec.bio || '',
    location:     rec.location || '',
    avatar:       rec.avatar || '',
    emailVerified: true,
    idVerified:   false,
    authProvider: rec.auth_provider || 'local',
    accountStatus: 'pending',
    // ── Registration/application fields ──
    civilStatus:      rec.civil_status      || '',
    presentAddress:   rec.present_address   || '',
    permanentAddress: rec.permanent_address || '',
    schoolName:       rec.school_name       || '',
    course:           rec.course            || '',
    yearLevel:        rec.year_level        || '',
    schoolAddress:    rec.school_address    || '',
    fatherInfo:       rec.father_info       || '',
    motherInfo:       rec.mother_info       || '',
    monthlyIncome:    rec.monthly_income    || '',
  });

  // Re-attach ID docs AND cert documents if they exist
  if (rec.id_front_url || rec.selfie_url) {
    const { submitIdVerification } = require('../utils/db');
    try {
      submitIdVerification({
        userId:            restored.id,
        idFrontUrl:        rec.id_front_url        || '',
        idBackUrl:         rec.id_back_url         || '',
        selfieUrl:         rec.selfie_url          || '',
        idType:            rec.id_type             || 'school_id',
        certResidencyUrl:  rec.cert_residency_url  || '',
        certLowIncomeUrl:  rec.cert_low_income_url || '',
        certEnrollmentUrl: rec.cert_enrollment_url || '',
      });
    } catch (e) {
      log.error(`ID re-attach failed (non-fatal): ${e.message}`);
    }
  }

  // Remove from rejected archive
  deleteRejectedRegistration(req.params.id);

  logAdminAction(req.user.id, 'rejected_account_restored', 'user', restored.id,
    `Restored @${restored.username} from rejected archive`);
  log.admin(`↩ RESTORED rejected account @${restored.username} (${restored.email}) — by @${req.user.username}`);

  // Notify admin panel
  const io = req.app.get('io');
  if (io) io.to('admins').emit('new-registration', {
    userId: restored.id, username: restored.username,
    firstName: restored.firstName, lastName: restored.lastName,
    email: restored.email, createdAt: new Date().toISOString(),
  });

  res.json({ success: true, userId: restored.id });
});

// ── Full user profile for admin review (User Management → Review button) ──
router.get('/api/admin/users/:id/profile', requireAdmin, (req, res) => {
  const profile = getFullUserProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'User not found.' });
  res.json({ user: profile });
});

// ── AI Moderation Log ─────────────────────────────────
router.get('/api/admin/ai-moderation-log', requireAdmin, (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json({ log: getAiModerationLog({ limit }) });
});

// ── AI Rate Status (shows RPM/RPD usage) ──────────────
router.get('/api/admin/ai-status', requireAdmin, (req, res) => {
  res.json(geminiPool.getStatus());
});

// ── Logs ───────────────────────────────────────────────
router.get('/api/admin/logs', requireAdmin, (req, res) => {
  res.json({ logs: getAdminLogs({ limit: parseInt(req.query.limit) || 50 }) });
});


// ── Dormitory Management API ───────────────────────────────────────

// GET all rooms with occupancy
router.get('/api/admin/dormitory/rooms', requireAdmin, (req, res) => {
  try {
    const rooms = getDormRooms();
    res.json({ rooms });
  } catch (err) { send500(res, err); }
});

// Search approved users for assignment
router.get('/api/admin/dormitory/users', requireAdmin, (req, res) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    const users = db.prepare(`
      SELECT u.id, u.first_name, u.last_name, u.username, u.email, u.avatar,
             u.sex, u.course, u.year_level,
             ba.id as assignment_id, dr.room_number, ba.bed_number
      FROM users u
      LEFT JOIN bed_assignments ba ON ba.user_id = u.id
      LEFT JOIN dorm_rooms dr ON dr.id = ba.room_id
      WHERE u.account_status='approved' AND u.is_active=1
        AND (u.first_name LIKE ? OR u.last_name LIKE ? OR u.username LIKE ? OR u.email LIKE ?)
      ORDER BY u.first_name, u.last_name
      LIMIT 20
    `).all(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    res.json({ users });
  } catch (err) { send500(res, err); }
});

// POST assign a student to a bed
router.post('/api/admin/dormitory/assign', requireAdmin, async (req, res) => {
  const { roomId, bedNumber, userId, notes } = req.body;
  if (!roomId || !bedNumber || !userId) return res.status(400).json({ error: 'roomId, bedNumber, userId required' });
  try {
    // Check room exists and has capacity
    const room = db.prepare('SELECT * FROM dorm_rooms WHERE id=?').get(roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (bedNumber < 1 || bedNumber > room.capacity) return res.status(400).json({ error: `Bed must be 1–${room.capacity}` });

    // Check if the target bed is already occupied
    const bedOccupied = db.prepare('SELECT user_id FROM bed_assignments WHERE room_id=? AND bed_number=?').get(roomId, bedNumber);
    if (bedOccupied) return res.status(409).json({ error: `Bed ${bedNumber} in Room ${room.room_number} is already occupied` });

    // Check if this student already has any bed assignment
    const studentAssigned = db.prepare(
      'SELECT ba.bed_number, dr.room_number FROM bed_assignments ba JOIN dorm_rooms dr ON dr.id=ba.room_id WHERE ba.user_id=?'
    ).get(userId);
    if (studentAssigned) {
      return res.status(409).json({
        error: `Student is already assigned to Room ${studentAssigned.room_number}, Bed ${studentAssigned.bed_number}. Remove their current assignment first.`
      });
    }

    // Check gender match
    const user = db.prepare("SELECT sex, first_name, last_name, email, username FROM users WHERE id=?").get(userId);
    if (user) {
      const userGender = (user.sex || '').toLowerCase();
      const isMale = userGender === 'male' || userGender === 'm';
      if (room.gender === 'female' && isMale) return res.status(400).json({ error: 'Cannot assign male student to female room' });
      if (room.gender === 'male' && !isMale && userGender) return res.status(400).json({ error: 'Cannot assign female student to male room' });
    }

    const io = req.app.get('io');
    assignBed(roomId, bedNumber, userId, req.user?.id, notes);
    logAdminAction(req.user?.id, 'assign_bed', `Room ${room.room_number} Bed ${bedNumber} → @${user?.username || userId}`);
    log.dorm(`✔ Bed assigned: Room ${room.room_number} Bed ${bedNumber} → @${user?.username || userId} — by @${req.user?.username}`);

    // Auto-generate bill for the current month so it appears immediately in billing
    const currentMonth = new Date().toISOString().slice(0, 7);
    try {
      const billResult = generateBillForUser(userId, currentMonth);
      if (billResult.created) {
        log.billing(`📋 Auto-bill created for @${user?.username} — ${currentMonth} | ₱${billResult.rate}`);
      }
    } catch (billErr) {
      log.warn(`Auto-bill on assign failed (non-fatal): ${billErr.message}`);
    }

    // In-app notification
    createNotification({
      userId,
      type: 'bed_assigned',
      actorId: null, // system notification
      targetId: room.id,
      message: `You have been assigned to Room ${room.room_number}, Bed ${bedNumber}.`,
    });
    if (io) io.to(`user:${userId}`).emit('new-notification', { userId });
    if (io) io.to(`user:${userId}`).emit('bed_assigned', { roomNumber: room.room_number, bedNumber });

    // Email notification (non-blocking)
    if (user?.email) {
      const { sendBedAssignedEmail } = require('../utils/emailService');
      sendBedAssignedEmail(user.email, user.first_name, room.room_number, bedNumber).then(r => {
        if (r.success) log.dorm(`📧 Bed-assigned email sent → ${user.email}`);
        else           log.warn(`Bed-assigned email failed → ${user.email}`);
      }).catch(() => {});
    }

    res.json({ success: true });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'That bed or student is already assigned' });
    log.error(`assign_bed failed: ${err.message}`);
    send500(res, err, 'assign_bed');
  }
});

// DELETE unassign a student
router.delete('/api/admin/dormitory/unassign/:userId', requireAdmin, async (req, res) => {
  try {
    // Fetch assignment details BEFORE deleting (for notification/email)
    const assignment = db.prepare(
      'SELECT ba.bed_number, dr.room_number, dr.id as room_id, u.first_name, u.last_name, u.email, u.username ' +
      'FROM bed_assignments ba ' +
      'JOIN dorm_rooms dr ON dr.id=ba.room_id ' +
      'JOIN users u ON u.id=ba.user_id ' +
      'WHERE ba.user_id=?'
    ).get(req.params.userId);

    const result = unassignBed(req.params.userId);
    if (!result.changes) return res.status(404).json({ error: 'No assignment found for this user' });

    logAdminAction(req.user?.id, 'unassign_bed', `User @${assignment?.username || req.params.userId} removed from Room ${assignment?.room_number} Bed ${assignment?.bed_number}`);
    log.dorm(`✖ Bed removed: @${assignment?.username || req.params.userId} from Room ${assignment?.room_number} Bed ${assignment?.bed_number} — by @${req.user?.username}`);

    if (assignment) {
      // In-app notification
      createNotification({
        userId: req.params.userId,
        type: 'bed_unassigned',
        actorId: null,
        targetId: null,
        message: `Your bed assignment (Room ${assignment.room_number}, Bed ${assignment.bed_number}) has been removed by the administrator.`,
      });
      const io = req.app.get('io');
      if (io) io.to(`user:${req.params.userId}`).emit('new-notification', { userId: req.params.userId });
      if (io) io.to(`user:${req.params.userId}`).emit('bed_unassigned', { roomNumber: assignment.room_number, bedNumber: assignment.bed_number });

      // Email notification (non-blocking)
      if (assignment.email) {
        const { sendBedUnassignedEmail } = require('../utils/emailService');
        sendBedUnassignedEmail(assignment.email, assignment.first_name, assignment.room_number, assignment.bed_number).then(r => {
          if (r.success) log.dorm(`📧 Bed-unassigned email sent → ${assignment.email}`);
          else           log.warn(`Bed-unassigned email failed → ${assignment.email}`);
        }).catch(() => {});
      }
    }

    res.json({ success: true });
  } catch (err) {
    log.error(`unassign_bed failed: ${err.message}`);
    send500(res, err, 'unassign_bed');
  }
});

// GET billing records
router.get('/api/admin/dormitory/billing', requireAdmin, (req, res) => {
  try {
    const bills = getDormBilling(req.query.month || null);
    res.json({ bills });
  } catch (err) { send500(res, err); }
});

// POST generate monthly bills for all assigned students
// Body: { month: "YYYY-MM", updateExisting: false }
//   updateExisting=true  → re-price existing UNPAID bills to the current rate (useful after rate change)
//   updateExisting=false → only create missing bills (safe default)
router.post('/api/admin/dormitory/billing/generate', requireAdmin, (req, res) => {
  const { month, updateExisting = false } = req.body;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month must be YYYY-MM' });
  try {
    const result = generateMonthlyBills(month, { updateExisting: !!updateExisting });
    const { created, updated = 0, skipped, rate } = result;
    logAdminAction(req.user?.id, 'generate_bills',
      `Month ${month}: ${created} created, ${updated} re-priced, ${skipped} unchanged @ \u20b1${rate}`);
    const parts = [
      created ? `\u2714 ${created} new` : null,
      updated ? `\u270f ${updated} re-priced` : null,
      skipped ? `\u23ed ${skipped} unchanged` : null,
    ].filter(Boolean).join(' | ');
    log.billing(`\ud83d\udccb Bills generated for ${month} \u2014 ${parts} \u2014 by @${req.user?.username}`);

    // Push billing_updated socket + notification to all affected residents
    if (created > 0 || updated > 0) {
      const io = req.app.get('io');
      const affected = db.prepare('SELECT DISTINCT user_id FROM dorm_billing WHERE month=?').all(month);
      const actionText = updated > 0 ? `updated to \u20b1${rate}` : `set at \u20b1${rate}`;
      for (const { user_id } of affected) {
        createNotification({
          userId: user_id, type: 'billing_update', actorId: null, targetId: null,
          message: `Your dorm bill for ${month} has been ${actionText}. Please check your payment status.`,
        });
        if (io) {
          io.to(`user:${user_id}`).emit('billing_updated', { month, rate });
          io.to(`user:${user_id}`).emit('new-notification', { userId: user_id });
        }
      }
    }

    res.json({
      success: true, created, updated, skipped, rate,
      message: `${created} new bill${created !== 1 ? 's' : ''} created` +
        (updated ? `, ${updated} re-priced to \u20b1${rate}` : '') +
        `, ${skipped} unchanged.`,
    });
  } catch (err) { send500(res, err); }
});

// PUT mark bill as paid
router.put('/api/admin/dormitory/billing/:id/pay', requireAdmin, (req, res) => {
  try {
    const bill = db.prepare(
      'SELECT b.*, u.username, u.id as user_id FROM dorm_billing b JOIN users u ON u.id=b.user_id WHERE b.id=?'
    ).get(req.params.id);
    if (!bill) return res.status(404).json({ error: 'Bill not found' });
    const result = markBillPaid(req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Bill not found' });
    log.billing(`\u{1F4B0} Bill PAID \u2014 @${bill.username} | month=${bill.month} | \u20b1${bill.amount} \u2014 by @${req.user?.username}`);

    // Push real-time update to the resident
    const io = req.app.get('io');
    createNotification({
      userId: bill.user_id, type: 'billing_paid', actorId: null, targetId: null,
      message: `\u2705 Your dorm bill of \u20b1${bill.amount} for ${bill.month} has been marked as PAID by the admin.`,
    });
    if (io) {
      io.to(`user:${bill.user_id}`).emit('billing_updated', { month: bill.month, status: 'paid' });
      io.to(`user:${bill.user_id}`).emit('new-notification', { userId: bill.user_id });
    }
    res.json({ success: true });
  } catch (err) { send500(res, err); }
});

// PUT waive bill
router.put('/api/admin/dormitory/billing/:id/waive', requireAdmin, (req, res) => {
  try {
    const bill = db.prepare(
      'SELECT b.*, u.username FROM dorm_billing b JOIN users u ON u.id=b.user_id WHERE b.id=?'
    ).get(req.params.id);
    const result = waiveBill(req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Bill not found' });
    log.billing(`🎁 Bill WAIVED — @${bill?.username} | month=${bill?.month} | ₱${bill?.amount} — by @${req.user?.username}`);
    res.json({ success: true });
  } catch (err) { send500(res, err); }
});

// POST send payment reminder email + in-app notification
router.post('/api/admin/dormitory/billing/:id/remind', requireAdmin, async (req, res) => {
  try {
    const bill = db.prepare(
      'SELECT b.*, u.first_name, u.last_name, u.email, u.username, u.id as user_id FROM dorm_billing b JOIN users u ON u.id=b.user_id WHERE b.id=?'
    ).get(req.params.id);
    if (!bill) return res.status(404).json({ error: 'Bill not found' });

    const io = req.app.get('io');
    const month = bill.month;
    const amount = bill.amount;
    const username = bill.username || 'unknown';

    // In-app notification
    createNotification({
      userId: bill.user_id,
      type: 'billing_reminder',
      actorId: null,
      targetId: null,
      message: `Payment reminder: Your dorm bill of ₱${amount} for ${month} is due. Please settle as soon as possible.`,
    });
    if (io) io.to(`user:${bill.user_id}`).emit('new-notification', { userId: bill.user_id });

    // Email reminder
    const { sendDormReminderEmail } = require('../utils/emailService');
    if (sendDormReminderEmail) {
      await sendDormReminderEmail(bill.email, bill.first_name, month, amount);
    }
    log.billing(`📧 Payment reminder sent → @${username} (${bill.email}) | month=${month} | ₱${amount} — by @${req.user?.username}`);
    res.json({ success: true });
  } catch (err) { send500(res, err); }
});

// POST remind all unpaid bills for a given month
router.post('/api/admin/dormitory/billing/remind-all', requireAdmin, async (req, res) => {
  try {
    const { month } = req.body;
    if (!month) return res.status(400).json({ error: 'Month is required' });
    const unpaidBills = db.prepare(
      'SELECT b.*, u.first_name, u.last_name, u.email, u.username, u.id as user_id ' +
      'FROM dorm_billing b JOIN users u ON u.id=b.user_id ' +
      "WHERE b.month=? AND b.status='unpaid'"
    ).all(month);
    if (!unpaidBills.length) return res.json({ success: true, sent: 0, message: 'No unpaid bills to remind.' });

    const { sendDormReminderEmail } = require('../utils/emailService');
    const io = req.app.get('io');
    let sent = 0, failed = 0;
    for (const bill of unpaidBills) {
      try {
        // In-app notification
        createNotification({
          userId: bill.user_id,
          type: 'billing_reminder',
          actorId: null,
          targetId: null,
          message: `Payment reminder: Your dorm bill of ₱${bill.amount} for ${bill.month} is due. Please settle as soon as possible.`,
        });
        if (io) io.to(`user:${bill.user_id}`).emit('new-notification', { userId: bill.user_id });
        // Email
        await sendDormReminderEmail(bill.email, bill.first_name, bill.month, bill.amount);
        sent++;
      } catch (e) {
        log.warn(`remind-all: failed for @${bill.username || bill.email}: ${e.message}`);
        failed++;
      }
    }
    log.billing(`📢 Remind-All sent for ${month} — ✔ ${sent} notified | ✖ ${failed} failed — by @${req.user?.username}`);
    res.json({ success: true, sent, failed, message: `Reminder sent to ${sent} student${sent !== 1 ? 's' : ''}.` });
  } catch (err) { send500(res, err); }
});

// GET dorm monthly rate
router.get('/api/admin/dormitory/billing/rate', requireAdmin, (req, res) => {
  const rate = parseInt(getSetting('dorm_rate', '200'), 10) || 200;
  res.json({ rate });
});

// PUT update dorm monthly rate
router.put('/api/admin/dormitory/billing/rate', requireAdmin, (req, res) => {
  const { rate } = req.body;
  const parsed = parseInt(rate, 10);
  if (!parsed || parsed < 1 || parsed > 99999) return res.status(400).json({ error: 'Invalid rate. Must be between 1 and 99,999.' });
  setSetting('dorm_rate', String(parsed));
  log.billing(`💱 Dorm rate updated → ₱${parsed}/month — by @${req.user?.username}`);
  res.json({ success: true, rate: parsed });
});

// ─── Room CRUD ──────────────────────────────────────────────────────────────

// POST add a new room
router.post('/api/admin/dormitory/rooms', requireAdmin, (req, res) => {
  try {
    const { gender, capacity, roomNumber } = req.body;
    if (!gender || !['male','female'].includes(gender)) return res.status(400).json({ error: 'gender must be male or female' });
    const cap = parseInt(capacity, 10) || 4;
    if (cap < 1 || cap > 20) return res.status(400).json({ error: 'capacity must be 1–20' });

    let finalNum;
    if (roomNumber !== undefined && roomNumber !== null && roomNumber !== '') {
      // Custom room number requested
      finalNum = parseInt(roomNumber, 10);
      if (isNaN(finalNum) || finalNum < 1) return res.status(400).json({ error: 'roomNumber must be a positive integer' });
      const exists = db.prepare('SELECT id FROM dorm_rooms WHERE room_number=?').get(finalNum);
      if (exists) return res.status(409).json({ error: `Room ${finalNum} already exists. Choose a different number.` });
    } else {
      // Auto-assign next available
      const maxRow = db.prepare('SELECT MAX(room_number) as mx FROM dorm_rooms').get();
      finalNum = (maxRow?.mx || 0) + 1;
    }

    const { lastInsertRowid } = db.prepare(
      'INSERT INTO dorm_rooms (room_number, gender, capacity) VALUES (?, ?, ?)'
    ).run(finalNum, gender, cap);

    logAdminAction(req.user?.id, 'add_room', `Added Room ${finalNum} (${gender}, ${cap} beds) — by @${req.user?.username}`);
    log.dorm(`🏠 Room ${finalNum} added (${gender}, capacity=${cap}) by @${req.user?.username}`);
    res.json({ success: true, roomNumber: finalNum, id: lastInsertRowid });
  } catch (err) { send500(res, err); }
});

// PUT update room (gender / capacity)
router.put('/api/admin/dormitory/rooms/:id', requireAdmin, (req, res) => {
  try {
    const room = db.prepare('SELECT * FROM dorm_rooms WHERE id=?').get(req.params.id);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const gender   = req.body.gender   || room.gender;
    const capacity = req.body.capacity !== undefined ? parseInt(req.body.capacity, 10) : room.capacity;

    if (!['male','female'].includes(gender)) return res.status(400).json({ error: 'gender must be male or female' });
    if (isNaN(capacity) || capacity < 1 || capacity > 20) return res.status(400).json({ error: 'capacity must be 1–20' });

    // If reducing capacity, check no beds above new capacity are occupied
    if (capacity < room.capacity) {
      const overflow = db.prepare(
        'SELECT COUNT(*) as cnt FROM bed_assignments WHERE room_id=? AND bed_number>?'
      ).get(room.id, capacity);
      if (overflow.cnt > 0) {
        return res.status(409).json({ error: `Cannot reduce capacity: ${overflow.cnt} bed(s) above ${capacity} are occupied` });
      }
      // Remove any empty bed_assignments rows above new cap (there shouldn't be any, but clean up)
      db.prepare('DELETE FROM bed_assignments WHERE room_id=? AND bed_number>? AND user_id IS NULL').run(room.id, capacity);
    }

    // If gender changes, make sure no current occupants conflict
    if (gender !== room.gender) {
      const occupants = db.prepare(
        'SELECT u.sex FROM bed_assignments ba JOIN users u ON u.id=ba.user_id WHERE ba.room_id=?'
      ).all(room.id);
      const conflict = occupants.find(u => {
        const sex = (u.sex||'').toLowerCase();
        return gender === 'female' ? (sex === 'male' || sex === 'm') : (sex === 'female' || sex === 'f');
      });
      if (conflict) return res.status(409).json({ error: 'Cannot change gender: room has occupants of the other gender' });
    }

    db.prepare('UPDATE dorm_rooms SET gender=?, capacity=? WHERE id=?').run(gender, capacity, room.id);
    logAdminAction(req.user?.id, 'update_room', `Room ${room.room_number}: gender=${gender}, capacity=${capacity}`);
    log.dorm(`✏️ Room ${room.room_number} updated → gender=${gender}, capacity=${capacity} by @${req.user?.username}`);
    res.json({ success: true });
  } catch (err) { send500(res, err); }
});

// DELETE a room
router.delete('/api/admin/dormitory/rooms/:id', requireAdmin, (req, res) => {
  try {
    const room = db.prepare('SELECT * FROM dorm_rooms WHERE id=?').get(req.params.id);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const occupants = db.prepare('SELECT COUNT(*) as cnt FROM bed_assignments WHERE room_id=?').get(room.id);
    if (occupants.cnt > 0) {
      return res.status(409).json({ error: `Cannot delete Room ${room.room_number}: ${occupants.cnt} resident(s) still assigned. Remove them first.` });
    }

    db.prepare('DELETE FROM dorm_rooms WHERE id=?').run(room.id);
    logAdminAction(req.user?.id, 'delete_room', `Deleted Room ${room.room_number} (${room.gender})`);
    log.dorm(`🗑️  Room ${room.room_number} deleted by @${req.user?.username}`);
    res.json({ success: true });
  } catch (err) { send500(res, err); }
});

// PUT mark bill as unpaid (undo paid)
router.put('/api/admin/dormitory/billing/:id/unpay', requireAdmin, (req, res) => {
  try {
    const bill = db.prepare(
      'SELECT b.*, u.username, u.id as user_id FROM dorm_billing b JOIN users u ON u.id=b.user_id WHERE b.id=?'
    ).get(req.params.id);
    if (!bill) return res.status(404).json({ error: 'Bill not found' });
    markBillUnpaid(req.params.id);
    log.billing(`\u21a9\ufe0f  Bill UNPAID (reversed) \u2014 @${bill.username} | month=${bill.month} | \u20b1${bill.amount} \u2014 by @${req.user?.username}`);

    // Push real-time update to the resident
    const io = req.app.get('io');
    createNotification({
      userId: bill.user_id, type: 'billing_unpaid', actorId: null, targetId: null,
      message: `\u26a0\ufe0f Your dorm bill of \u20b1${bill.amount} for ${bill.month} has been marked UNPAID. Please contact admin if you believe this is an error.`,
    });
    if (io) {
      io.to(`user:${bill.user_id}`).emit('billing_updated', { month: bill.month, status: 'unpaid' });
      io.to(`user:${bill.user_id}`).emit('new-notification', { userId: bill.user_id });
    }
    res.json({ success: true });
  } catch (err) { send500(res, err); }
});

// ════════════════════════════════════════════════════
// USER REPORTS (admin view)
// GET  /api/admin/users/reports        — all reports (optionally filter by targetId or status)
// PUT  /api/admin/reports/:id/status   — mark report reviewed/dismissed
// GET  /api/admin/users/:id/reputation — get reputation score for a specific user
// ════════════════════════════════════════════════════

router.get('/api/admin/users/reports', requireAdmin, (req, res) => {
  try {
    const { targetId, status } = req.query;
    const reports = getAllUserReports({ targetId, status });
    log.info(`[admin] Fetched ${reports.length} user report(s) (filter: status=${status || 'all'}, target=${targetId || 'all'})`);
    res.json({ reports });
  } catch (err) { send500(res, err); }
});

router.put('/api/admin/reports/:id/status', requireAdmin, (req, res) => {
  try {
    const { status, adminNote } = req.body;
    const allowed = ['pending', 'reviewed', 'dismissed', 'actioned'];
    if (!allowed.includes(status)) return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
    updateReportStatus(req.params.id, status, adminNote || '');
    logAdminAction(req.user?.id, 'review_report', `Report ${req.params.id} marked ${status}`);
    log.info(`[admin] Report ${req.params.id} → ${status} by @${req.user?.username}`);
    res.json({ success: true });
  } catch (err) { send500(res, err); }
});

// Quick per-user report count — used when enriching user management table
router.get('/api/admin/users/report-counts', requireAdmin, (req, res) => {
  try {
    const rows = getReportCountByUser();
    // Convert to { [userId]: count }
    const map = {};
    for (const row of rows) map[row.target_id] = row.count;
    res.json({ counts: map });
  } catch (err) { send500(res, err); }
});

// Per-user reputation score
router.get('/api/admin/users/:id/reputation', requireAdmin, (req, res) => {
  try {
    const score = getReputationScore(req.params.id);
    res.json({ score });
  } catch (err) { send500(res, err); }
});

// ── Batch reputation — GET /api/admin/users/reputation/batch?ids=id1,id2,... ──
// Returns { scores: { [userId]: number } } in one round-trip.
// Eliminates the N-request flood that refreshAll() previously triggered.
router.get('/api/admin/users/reputation/batch', requireAdmin, (req, res) => {
  try {
    const ids = (req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!ids.length) return res.json({ scores: {} });
    const scores = {};
    ids.forEach(id => { scores[id] = getReputationScore(id); });
    res.json({ scores });
  } catch (err) { send500(res, err); }
});

// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  MAINTENANCE REQUESTS (Admin)                                                ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

/** GET /api/admin/maintenance/stats */
router.get('/api/admin/maintenance/stats', requireAdmin, (req, res) => {
  try {
    res.json(getMaintenanceStats());
  } catch (err) { send500(res, err); }
});

/** GET /api/admin/maintenance/requests?status=&limit=&offset= */
router.get('/api/admin/maintenance/requests', requireAdmin, (req, res) => {
  try {
    const { status, limit, offset } = req.query;
    const requests = getMaintenanceRequests({
      status: status || 'all',
      limit: Math.min(parseInt(limit) || 100, 500),
      offset: parseInt(offset) || 0,
    });
    res.json(requests);
  } catch (err) { send500(res, err); }
});

/** PUT /api/admin/maintenance/requests/:id */
router.put('/api/admin/maintenance/requests/:id', requireAdmin, (req, res) => {
  try {
    const { status, adminNote } = req.body;
    if (!status) return res.status(400).json({ error: 'status is required' });
    const VALID = ['open','in_progress','resolved','closed'];
    if (!VALID.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    updateMaintenanceRequest(req.params.id, { status, adminNote });
    logAdminAction(req.user?.id, 'maintenance_update', `Request ${req.params.id} → ${status}${adminNote ? ' | note: '+adminNote.slice(0,80) : ''}`);
    log.info(`[admin] Maintenance #${req.params.id} → "${status}" by @${req.user?.username}`);
    res.json({ success: true });
  } catch (err) { send500(res, err); }
});

// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  UTILITY BILLS (Admin)                                                       ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

/** GET /api/admin/utility/bills?month=&type=&from=&to= */
router.get('/api/admin/utility/bills', requireAdmin, (req, res) => {
  try {
    const { month, type, from, to } = req.query;
    res.json(getUtilityBills({ month, type, from, to }));
  } catch (err) { send500(res, err); }
});

/** GET /api/admin/utility/trend?months= */
router.get('/api/admin/utility/trend', requireAdmin, (req, res) => {
  try {
    const months = Math.min(parseInt(req.query.months) || 12, 24);
    res.json(getUtilityTrend(months));
  } catch (err) { send500(res, err); }
});

/** POST /api/admin/utility/bills — upsert a bill (multipart: optional 'image' field) */
router.post('/api/admin/utility/bills', requireAdmin, multerUpload.single('image'), async (req, res) => {
  try {
    const { month, type, amount, unitUsed, note, removeImage } = req.body;
    if (!month || !type || amount == null) return res.status(400).json({ error: 'month, type, and amount are required' });
    if (!['electricity','water'].includes(type)) return res.status(400).json({ error: 'type must be electricity or water' });
    const parsed = parseFloat(amount);
    if (isNaN(parsed) || parsed < 0) return res.status(400).json({ error: 'amount must be a non-negative number' });

    // Fetch existing row to preserve image if not changing it
    const existing = db.prepare("SELECT image_url FROM utility_bills WHERE month = ? AND type = ?").get(month, type);

    // ── Determine image state ────────────────────────────────────────────────
    // Three cases: explicit removal, new upload, or no change (preserve existing).
    // removeImage flag is propagated all the way to upsertUtilityBill so the DB
    // CASE WHEN guard doesn't silently block the intentional clear.
    const isRemoval = removeImage === '1';
    let imageUrl = '';

    if (isRemoval) {
      // Caller wants the photo gone — imageUrl stays '' and removeImage=true reaches DB.
      log.info(`[admin] Utility bill image removed for ${type} ${month} by @${req.user?.username}`);
    } else if (req.file) {
      // New image uploaded — resize and store.
      const buf = await resizeImage(req.file.buffer, { width: 1400, quality: 82 });
      imageUrl = hasCloudinary
        ? (await toCloudinary(buf, 'damis/utility-bills')).secure_url
        : `data:${req.file.mimetype};base64,${buf.toString('base64')}`;
      log.info(`[admin] Utility bill image uploaded: ${imageUrl.slice(0, 60)}…`);
    } else {
      // No image change — preserve whatever is in the DB (handled by CASE WHEN in upsert).
      imageUrl = '';
    }

    upsertUtilityBill({
      month,
      type,
      amount:      parsed,
      unitUsed:    unitUsed != null ? parseFloat(unitUsed) : null,
      note:        note?.trim() || null,
      imageUrl,
      removeImage: isRemoval,
    });
    logAdminAction(req.user?.id, 'utility_bill_upsert', `${type} ${month} ₱${parsed}`);
    log.info(`[admin] Utility bill upserted: ${type} ${month} ₱${parsed} by @${req.user?.username}`);
    res.json({ success: true });
  } catch (err) { send500(res, err); }
});

// ── GCash QR / payment info upload ──────────────────────────────────────────
// Stored as a settings key so it's shared across all billing months.
// POST /api/admin/billing/gcash-qr   multipart: 'qr' field (image)
router.post('/api/admin/billing/gcash-qr', requireAdmin, multerUpload.single('qr'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded.' });
    const buf = await resizeImage(req.file.buffer, { width: 800, quality: 88 });
    const url = hasCloudinary
      ? (await toCloudinary(buf, 'damis/gcash')).secure_url
      : `data:${req.file.mimetype};base64,${buf.toString('base64')}`;
    setSetting('gcash_qr_url', url);
    logAdminAction(req.user?.id, 'gcash_qr_upload', url.slice(0, 80));
    log.info(`[admin] GCash QR uploaded by @${req.user?.username}`);
    res.json({ success: true, url });
  } catch (err) { send500(res, err); }
});

/** GET /api/admin/billing/gcash-qr — fetch current GCash QR URL (and number) */
router.get('/api/admin/billing/gcash-qr', requireAdmin, (req, res) => {
  res.json({
    url:    getSetting('gcash_qr_url', ''),
    number: getSetting('gcash_number', ''),
  });
});

/** PUT /api/admin/billing/gcash-number — save GCash number text */
router.put('/api/admin/billing/gcash-number', requireAdmin, (req, res) => {
  const { number } = req.body;
  setSetting('gcash_number', (number || '').trim());
  log.info(`[admin] GCash number updated by @${req.user?.username}`);
  res.json({ success: true });
});

/** DELETE /api/admin/billing/:billId/receipt — admin clears a resident's uploaded receipt */
router.delete('/api/admin/billing/:billId/receipt', requireAdmin, (req, res) => {
  try {
    clearBillReceipt(req.params.billId);
    logAdminAction(req.user?.id, 'bill_receipt_clear', req.params.billId);
    res.json({ success: true });
  } catch (err) { send500(res, err); }
});

/** DELETE /api/admin/dormitory/billing/:id/receipt — alias under dormitory prefix */
router.delete('/api/admin/dormitory/billing/:id/receipt', requireAdmin, (req, res) => {
  try {
    clearBillReceipt(req.params.id);
    logAdminAction(req.user?.id, 'bill_receipt_clear', req.params.id);
    log.info(`[admin] Receipt cleared for bill ${req.params.id} by @${req.user?.username}`);
    res.json({ success: true });
  } catch (err) { send500(res, err); }
});

/** DELETE /api/admin/billing/gcash-qr — remove GCash QR image */
router.delete('/api/admin/billing/gcash-qr', requireAdmin, (req, res) => {
  try {
    setSetting('gcash_qr_url', '');
    logAdminAction(req.user?.id, 'gcash_qr_remove', 'removed');
    log.info(`[admin] GCash QR removed by @${req.user?.username}`);
    res.json({ success: true });
  } catch (err) { send500(res, err); }
});


// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  EXPORT ENDPOINTS (data for client-side Excel/PDF generation)                ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

/** GET /api/admin/export/rooms — returns room data for client-side export */
router.get('/api/admin/export/rooms', requireAdmin, (req, res) => {
  try {
    const rooms = getDormRooms();

    // Summary rows (one per room)
    const summaryRows = rooms.map(r => {
      const occ = r.occupied || 0;
      return {
        roomNo:    r.room_number,
        gender:    r.gender,
        capacity:  r.capacity,
        occupied:  occ,
        available: r.capacity - occ,
        status:    occ === r.capacity ? 'Full' : occ === 0 ? 'Empty' : 'Partial',
        occupants: (r.assignments || []).map(a => a.name).join(', ') || '—',
      };
    });

    // Detailed occupant rows (one per occupied bed)
    const occupantRows = [];
    for (const r of rooms) {
      const bedMap = {};
      for (const a of (r.assignments || [])) {
        bedMap[a.bedNumber] = a;
      }
      for (let bed = 1; bed <= r.capacity; bed++) {
        const a = bedMap[bed];
        occupantRows.push({
          roomNo:   r.room_number,
          gender:   r.gender,
          bedNo:    bed,
          status:   a ? 'Occupied' : 'Available',
          name:     a ? a.name    : '—',
          userId:   a ? a.userId  : '—',
        });
      }
    }

    res.json({ summaryRows, occupantRows });
  } catch (err) { send500(res, err); }
});

/** GET /api/admin/export/billing?month= — returns billing data for client-side export */
router.get('/api/admin/export/billing', requireAdmin, (req, res) => {
  try {
    const { month } = req.query;
    const bills = getDormBilling(month) || [];          // plain array from db
    const rows = bills.map(b => ({
      name:        `${b.first_name} ${b.last_name}`,
      username:    `@${b.username}`,
      room:        b.room_number != null ? b.room_number : '—',
      bed:         b.bed_number  != null ? b.bed_number  : '—',
      month:       b.month,
      amount:      b.amount,
      status:      b.status,
      paidAt:      b.paid_at       || '—',
      note:        b.user_comment  || '',
      adminNote:   b.admin_note    || '',
    }));
    const total   = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const paid    = rows.filter(r => r.status === 'paid').reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const unpaid  = total - paid;
    res.json({ month: month || 'all', rows, summary: { total, paid, unpaid } });
  } catch (err) { send500(res, err); }
});

/** GET /api/admin/export/maintenance — returns maintenance data for client-side export */
router.get('/api/admin/export/maintenance', requireAdmin, (req, res) => {
  try {
    const { status } = req.query;
    const requests = getMaintenanceRequests({ status: status || 'all', limit: 500, offset: 0 });
    const rows = requests.map(r => ({
      id:          r.id.slice(0,8),
      resident:    `${r.first_name} ${r.last_name}`,
      username:    `@${r.username}`,
      room:        r.room_number || '—',
      category:    r.category,
      title:       r.title,
      description: r.description,
      location:    r.location || '—',
      priority:    r.priority,
      status:      r.status,
      adminNote:   r.admin_note || '',
      submitted:   r.created_at,
      resolved:    r.resolved_at || '—',
    }));
    res.json(rows);
  } catch (err) { send500(res, err); }
});

// ══════════════════════════════════════════════════════════════════
// SEMESTER MANAGEMENT
// ══════════════════════════════════════════════════════════════════

/** GET /api/admin/semester — return current semester settings */
router.get('/api/admin/semester', requireAdmin, (req, res) => {
  res.json({
    currentSemester: getSetting('current_semester', '1st Semester'),
    schoolYear:      getSetting('school_year', String(new Date().getFullYear())),
    slipValidTo:     getSetting('slip_valid_to', ''),
  });
});

/** PUT /api/admin/semester — update semester display settings (no rollover) */
router.put('/api/admin/semester', requireAdmin, (req, res) => {
  try {
    const { currentSemester, schoolYear, slipValidTo } = req.body;
    if (currentSemester) setSetting('current_semester', currentSemester);
    if (schoolYear)      setSetting('school_year', String(schoolYear));
    if (slipValidTo !== undefined) setSetting('slip_valid_to', slipValidTo);
    logAdminAction(req.user.id, 'semester_updated', 'system', null,
      `${getSetting('current_semester')} SY${getSetting('school_year')} validTo=${slipValidTo}`);
    log.admin(`📅 Semester updated → ${getSetting('current_semester')} SY${getSetting('school_year')} by @${req.user.username}`);
    res.json({ success: true });
  } catch (err) { send500(res, err); }
});

/**
 * POST /api/admin/semester/rollover
 * Snapshots the full live DB into the Archive DB "closet" (see snapshotLiveDb
 * below), THEN archives all current residents to deleted_users with
 * semester_tag, resets admission counter, and updates semester settings.
 * The snapshot happens first so it captures the closing semester's full
 * state (residents + rooms + billing) before any rows are touched.
 * Body: { newSemester, schoolYear, slipValidTo }
 */
router.post('/api/admin/semester/rollover', requireAdmin, async (req, res) => {
  try {
    const { newSemester, schoolYear, slipValidTo } = req.body;
    if (!newSemester || !schoolYear) return res.status(400).json({ error: 'newSemester and schoolYear are required.' });

    // Snapshot BEFORE rollover mutates anything, so the archive reflects the
    // closing semester's full data — not the post-rollover, residents-removed state.
    const outgoingSemester = getSetting('current_semester', '1st Semester');
    const outgoingYear     = getSetting('school_year', String(schoolYear));
    const residentCountBefore = db.prepare(
      `SELECT COUNT(*) AS c FROM users WHERE account_status = 'approved' AND role = 'user'`
    ).get().c;

    let dbBackupWarning = null;
    try {
      await snapshotLiveDb({
        label: `${outgoingSemester} ${outgoingYear}`,
        semesterTag: `${outgoingSemester} ${outgoingYear}`,
        reason: 'semester_rollover',
        residentCount: residentCountBefore,
        adminId: req.user.id,
      });
    } catch (backupErr) {
      // Non-fatal: don't block the semester from starting just because the
      // snapshot upload hiccuped. Surface it loudly so the admin knows to
      // grab a manual backup instead.
      dbBackupWarning = `Automatic DB snapshot failed: ${backupErr.message}. Consider downloading a manual backup from Backup & Restore.`;
      log.error(`⚠ Semester rollover: automatic DB snapshot failed — ${backupErr.message}`);
    }

    const result = semesterRollover(newSemester, schoolYear, slipValidTo || '', req.user.id);
    logAdminAction(req.user.id, 'semester_rollover', 'system', null,
      `${newSemester} SY${schoolYear} — archived ${result.archived} residents`);
    log.admin(`🔄 SEMESTER ROLLOVER → ${newSemester} SY${schoolYear} | archived=${result.archived} skipped=${result.skipped} — by @${req.user.username}`);
    res.json({ success: true, ...result, newSemester, schoolYear, dbBackupWarning });
  } catch (err) { send500(res, err); }
});

// ══════════════════════════════════════════════════════════════════
// ADMISSION SLIP — server-side XLSX generation
// ══════════════════════════════════════════════════════════════════

/**
 * GET /api/admin/users/:id/admission-slip
 * Fills the Admission_Slip_Template.xlsx with resident data and
 * streams it as a downloadable file.
 * Uses exceljs to load the template, replace formula cells with
 * computed values, and write to an in-memory buffer.
 */
router.get('/api/admin/users/:id/admission-slip', requireAdmin, async (req, res) => {
  try {
    const ExcelJS = require('exceljs');
    const path    = require('path');

    const userId = req.params.id;
    // Fetch full resident data
    const row = db.prepare(`
      SELECT u.*,
        dr.room_number, ba.bed_number
      FROM users u
      LEFT JOIN bed_assignments ba ON ba.user_id = u.id
      LEFT JOIN dorm_rooms dr ON dr.id = ba.room_id
      WHERE u.id = ?
    `).get(userId);

    if (!row) return res.status(404).json({ error: 'Resident not found.' });

    // Get or assign admission number for this resident+semester
    let admissionNo = (row.admission_no || '').trim();
    if (!admissionNo) {
      admissionNo = nextAdmissionNo();
      db.prepare("UPDATE users SET admission_no = ? WHERE id = ?").run(admissionNo, userId);
    }

    const semester   = getSetting('current_semester', '1st Semester');
    const schoolYear = getSetting('school_year', String(new Date().getFullYear()));
    const slipValidTo = getSetting('slip_valid_to', '');

    // Address — extract just "Municipality, Province" from the full stored address string
    // Stored format: "Barangay, City/Municipality, Province, Region, Philippines"
    // We want the 2nd and 3rd comma-separated parts (index 1 and 2)
    const rawAddr = (row.permanent_address || row.present_address || '').trim();
    let address = rawAddr;
    if (rawAddr) {
      const parts = rawAddr.split(',').map(p => p.trim()).filter(Boolean);
      // parts[0]=barangay, parts[1]=city/municipality, parts[2]=province, parts[3]=region
      if (parts.length >= 3) {
        address = `${parts[1]}, ${parts[2]}`;
      } else if (parts.length === 2) {
        address = `${parts[0]}, ${parts[1]}`;
      } else {
        address = rawAddr;
      }
    }

    // ECN: father and/or mother phone from JSON-encoded info fields
    // Stored as JSON: {"firstName":"...","lastName":"...","phone":"9171234567",...}
    function extractPhone(jsonStr) {
      if (!jsonStr) return '';
      try {
        const obj = JSON.parse(jsonStr);
        const raw = (obj.phone || '').toString().replace(/\D/g, '');
        if (!raw) return '';
        // Normalise to +63XXXXXXXXXX format
        return raw.startsWith('63') ? '+' + raw
          : raw.startsWith('0')    ? '+63' + raw.slice(1)
          : raw.length === 10      ? '+63' + raw
          : raw;
      } catch (_) {
        // Not JSON — try to extract a phone number substring
        const m = jsonStr.match(/[\d\s\-+()]{7,}/);
        return m ? m[0].trim() : jsonStr.slice(0, 20);
      }
    }
    const fatherPhone = extractPhone(row.father_info);
    const motherPhone = extractPhone(row.mother_info);
    const ecn = [fatherPhone, motherPhone].filter(Boolean).join(' / ') || '—';

    const slipDate = new Date();
    const dateStr  = slipDate.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });
    const validToStr = slipValidTo
      ? new Date(slipValidTo).toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' })
      : '';

    const roomStr = row.room_number ? String(row.room_number) : '—';

    // Load template
    const templatePath = path.join(__dirname, '..', 'assets', 'Admission_Slip_Template.xlsx');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(templatePath);
    const ws = wb.getWorksheet(1);

    /**
     * Fill both halves of the slip (rows 11-27 = management copy, rows 43-59 = resident copy).
     * Clears cross-workbook formulas and writes computed string values.
     */
    function fillSlip(dateRow, semesterRow, schoolYearRow, validToRow,
                      familyRow, firstRow, middleRow, addrRow, contactRow, ecnRow,
                      admNoCol, roomNoCol, dateSignRow1, dateSignRow2) {
      const setVal = (rowNum, colNum, val) => {
        const cell = ws.getCell(rowNum, colNum);
        cell.value = val;  // clears any formula
      };

      // Date (col B=2)
      setVal(dateRow, 2, dateStr);
      // Admission No. (col F=6)
      setVal(dateRow, 6, admissionNo);
      // Semester (col B=2 of semesterRow)
      setVal(semesterRow, 2, semester);
      // Room No. (col F=6)
      setVal(semesterRow, 6, roomStr);
      // School Year
      setVal(schoolYearRow, 2, parseInt(schoolYear, 10) || new Date().getFullYear());
      // Valid from / to
      setVal(validToRow, 2, dateStr);
      setVal(validToRow, 4, validToStr);
      // Personal info
      setVal(familyRow,  2, row.last_name  || '');
      setVal(familyRow,  5, address);
      setVal(firstRow,   2, row.first_name || '');
      setVal(firstRow,   5, row.phone      || '');
      setVal(middleRow,  2, row.middle_name || '');
      setVal(middleRow,  5, ecn);
      // Signature date lines
      setVal(dateSignRow1, 1, dateStr);
      setVal(dateSignRow1, 3, dateStr);
      setVal(dateSignRow2, 1, dateStr);
      setVal(dateSignRow2, 3, dateStr);
    }

    // Management copy: rows 11,12,13,14, 16,17,18, 26,26
    fillSlip(11, 12, 13, 14,  16, 17, 18,  16, 17, 18,  6, 6,  26, 26);
    // Resident copy: rows 43,44,45,46, 48,49,50, 58,58
    fillSlip(43, 44, 45, 46,  48, 49, 50,  48, 49, 50,  6, 6,  58, 58);

    // Stream as download
    const safeName = `${(row.last_name||'').replace(/\s+/g,'_')}_AdmissionSlip.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);

    await wb.xlsx.write(res);
    res.end();

    logAdminAction(req.user.id, 'admission_slip_generated', 'user', userId,
      `@${row.username} — slip #${admissionNo} ${semester} SY${schoolYear}`);
    log.admin(`📄 Admission slip generated for @${row.username} #${admissionNo} — by @${req.user.username}`);
  } catch (err) { send500(res, err); }
});

// ══════════════════════════════════════════════════════════════════
// DB ARCHIVES — the "closet" of full .db snapshots
// ══════════════════════════════════════════════════════════════════

/**
 * Take a hot backup of the live DB and store it as a saved snapshot:
 * uploaded to Cloudinary (raw resource, survives Railway redeploys) when
 * configured, otherwise kept on local disk under DATA_DIR/db-archives as a
 * dev-mode fallback. Always cleans up its own temp file.
 *
 * Called automatically by /api/admin/semester/rollover, and by the manual
 * "Save Snapshot Now" button on the Archive DB tab.
 */
async function snapshotLiveDb({ label, semesterTag = '', reason = 'semester_rollover', residentCount = 0, adminId = '' }) {
  const path = require('path');
  const os   = require('os');
  const fs   = require('fs');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const fileName  = `damis-archive-${timestamp}.db`;
  const tmpPath   = path.join(os.tmpdir(), fileName);

  await db.backup(tmpPath); // better-sqlite3 async backup — consistent even under write load
  const fileSizeBytes = fs.statSync(tmpPath).size;

  try {
    let storage = 'local', fileUrl = '', cloudinaryPublicId = '';

    if (hasCloudinary) {
      const buffer = fs.readFileSync(tmpPath);
      const uploaded = await toCloudinary(buffer, 'pga-damis/db-archives', {
        resource_type: 'raw',
        public_id: fileName.replace(/\.db$/, ''),
      });
      storage = 'cloudinary';
      fileUrl = uploaded.secure_url;
      cloudinaryPublicId = uploaded.public_id;
    } else {
      // Dev fallback — no Cloudinary configured, keep it on local disk.
      const DATA_DIR   = process.env.DATA_DIR || path.join(__dirname, '..');
      const archiveDir = path.join(DATA_DIR, 'db-archives');
      fs.mkdirSync(archiveDir, { recursive: true });
      const destPath = path.join(archiveDir, fileName);
      fs.copyFileSync(tmpPath, destPath);
      storage = 'local';
      fileUrl = destPath;
    }

    const id = createDbArchive({
      label, semesterTag, reason, residentCount, fileSizeBytes,
      fileName, storage, fileUrl, cloudinaryPublicId, createdBy: adminId,
    });
    log.admin(`📦 DB snapshot saved: "${label}" (${(fileSizeBytes / 1024 / 1024).toFixed(2)} MB, ${storage})`);
    return id;
  } finally {
    fs.unlink(tmpPath, () => {});
  }
}

/** GET /api/admin/db-archives — list all saved snapshots, newest first */
router.get('/api/admin/db-archives', requireAdmin, (req, res) => {
  try {
    res.json({ archives: getDbArchives() });
  } catch (err) { send500(res, err); }
});

/**
 * POST /api/admin/db-archives/manual
 * Saves a snapshot on demand (outside of a semester rollover), so admins
 * can stock the closet whenever they want without waiting for a rollover.
 * Body: { label }
 */
router.post('/api/admin/db-archives/manual', requireAdmin, async (req, res) => {
  try {
    const label = (req.body?.label || '').trim() ||
      `Manual snapshot ${new Date().toISOString().slice(0, 10)}`;
    const residentCount = db.prepare(
      `SELECT COUNT(*) AS c FROM users WHERE account_status = 'approved' AND role = 'user'`
    ).get().c;

    const id = await snapshotLiveDb({ label, reason: 'manual', residentCount, adminId: req.user.id });
    logAdminAction(req.user.id, 'db_archive_saved', 'system', id, label);
    res.json({ success: true, id });
  } catch (err) { send500(res, err); }
});

/** GET /api/admin/db-archives/:id/download — stream a saved snapshot back to the browser */
router.get('/api/admin/db-archives/:id/download', requireAdmin, async (req, res) => {
  try {
    const rec = getDbArchiveById(req.params.id);
    if (!rec) return res.status(404).json({ error: 'Archive not found.' });

    const fs = require('fs');
    const downloadName = rec.file_name || `${rec.label.replace(/\s+/g, '_')}.db`;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);

    if (rec.storage === 'cloudinary') {
      const upstream = await fetch(rec.file_url);
      if (!upstream.ok) throw new Error(`Cloudinary fetch failed (${upstream.status})`);
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } else {
      if (!fs.existsSync(rec.file_url)) return res.status(404).json({ error: 'Archive file is missing from local disk.' });
      fs.createReadStream(rec.file_url).pipe(res);
    }

    logAdminAction(req.user.id, 'db_archive_downloaded', 'system', rec.id, rec.label);
    log.admin(`💾 DB archive downloaded: "${rec.label}" — by @${req.user.username}`);
  } catch (err) { send500(res, err); }
});

/**
 * POST /api/admin/db-archives/:id/restore
 * Loads a saved snapshot back in as the live DB — same mechanism as
 * /api/admin/backup/restore, just sourced from the closet instead of an
 * upload. Destructive: overwrites all current data.
 */
router.post('/api/admin/db-archives/:id/restore', requireAdmin, async (req, res) => {
  try {
    const rec = getDbArchiveById(req.params.id);
    if (!rec) return res.status(404).json({ error: 'Archive not found.' });

    const path = require('path');
    const os   = require('os');
    const fs   = require('fs');
    const Database = require('better-sqlite3');

    const tmpPath = path.join(os.tmpdir(), `damis-archive-restore-${Date.now()}.db`);

    if (rec.storage === 'cloudinary') {
      const upstream = await fetch(rec.file_url);
      if (!upstream.ok) throw new Error(`Cloudinary fetch failed (${upstream.status})`);
      fs.writeFileSync(tmpPath, Buffer.from(await upstream.arrayBuffer()));
    } else {
      if (!fs.existsSync(rec.file_url)) return res.status(404).json({ error: 'Archive file is missing from local disk.' });
      fs.copyFileSync(rec.file_url, tmpPath);
    }

    // Validate before touching the live DB
    try {
      const checkDb = new Database(tmpPath, { readonly: true });
      checkDb.prepare('SELECT COUNT(*) FROM users').get();
      checkDb.close();
    } catch (e) {
      fs.unlink(tmpPath, () => {});
      return res.status(400).json({ error: `Archived file appears corrupt: ${e.message}` });
    }

    const DATA_DIR   = process.env.DATA_DIR || path.join(__dirname, '..');
    const liveDbPath = path.join(DATA_DIR, 'connecthub.db');
    const srcDb = new Database(tmpPath, { readonly: true });
    await srcDb.backup(liveDbPath);
    srcDb.close();
    fs.unlink(tmpPath, () => {});

    log.admin(`♻ DB RESTORED from archive "${rec.label}" — by @${req.user.username}`);
    // No logAdminAction here — the admin_logs table just got replaced by the restore.
    res.json({ success: true, message: `Database restored from "${rec.label}". The server will continue running with the restored data.` });
  } catch (err) { send500(res, err); }
});

/** DELETE /api/admin/db-archives/:id — purge a saved snapshot and free its storage */
router.delete('/api/admin/db-archives/:id', requireAdmin, async (req, res) => {
  try {
    const rec = getDbArchiveById(req.params.id);
    if (!rec) return res.status(404).json({ error: 'Archive not found.' });

    if (rec.storage === 'cloudinary' && rec.cloudinary_public_id) {
      try {
        const cloudinary = require('cloudinary').v2;
        await cloudinary.uploader.destroy(rec.cloudinary_public_id, { resource_type: 'raw' });
      } catch (e) { log.warn(`Cloudinary purge failed (non-fatal): ${e.message}`); }
    } else if (rec.storage === 'local' && rec.file_url) {
      require('fs').unlink(rec.file_url, () => {});
    }

    deleteDbArchiveById(rec.id);
    logAdminAction(req.user.id, 'db_archive_purged', 'system', rec.id, rec.label);
    log.admin(`🗑 DB archive purged: "${rec.label}" — by @${req.user.username}`);
    res.json({ success: true });
  } catch (err) { send500(res, err); }
});

// ══════════════════════════════════════════════════════════════════
// BACKUP & RESTORE
// ══════════════════════════════════════════════════════════════════

/**
 * GET /api/admin/backup/download
 * Uses better-sqlite3's built-in .backup() to create a consistent
 * hot backup of the live DB and streams it as a .db file download.
 * Safe to run while the app is serving requests (WAL checkpoint included).
 */
router.get('/api/admin/backup/download', requireAdmin, async (req, res) => {
  try {
    const path = require('path');
    const os   = require('os');
    const fs   = require('fs');

    const timestamp   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupName  = `damis-backup-${timestamp}.db`;
    const backupPath  = path.join(os.tmpdir(), backupName);

    // better-sqlite3 async backup — consistent even under write load
    await db.backup(backupPath);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${backupName}"`);
    const stream = fs.createReadStream(backupPath);
    stream.pipe(res);
    stream.on('end', () => {
      fs.unlink(backupPath, () => {}); // clean up temp file
    });
    stream.on('error', (e) => { send500(res, e, 'backup stream'); });

    logAdminAction(req.user.id, 'db_backup_downloaded', 'system', null, backupName);
    log.admin(`💾 DB backup downloaded: ${backupName} — by @${req.user.username}`);
  } catch (err) { send500(res, err); }
});

/**
 * POST /api/admin/backup/restore
 * Accepts a .db file upload, validates it is a SQLite database,
 * then replaces the live DB using SQLite's restore pattern.
 * ⚠ This is destructive — the current DB is replaced.
 * Requires admin role.
 */
router.post('/api/admin/backup/restore',
  requireAdmin,
  backupUpload.single('backup'),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No backup file uploaded.' });
      // Any admin can restore (superadmin role not required)

      const path = require('path');
      const os   = require('os');
      const fs   = require('fs');
      const Database = require('better-sqlite3');

      // Validate magic bytes: SQLite files start with "SQLite format 3\000"
      const magic = req.file.buffer.slice(0, 16).toString('ascii');
      if (!magic.startsWith('SQLite format 3')) {
        return res.status(400).json({ error: 'Uploaded file is not a valid SQLite database.' });
      }

      // Write uploaded buffer to a temp file
      const tmpPath = path.join(os.tmpdir(), `damis-restore-${Date.now()}.db`);
      fs.writeFileSync(tmpPath, req.file.buffer);

      // Validate the uploaded DB can be opened
      let uploadedDb;
      try {
        uploadedDb = new Database(tmpPath, { readonly: true });
        // Quick sanity: must have a users table
        uploadedDb.prepare("SELECT COUNT(*) FROM users").get();
        uploadedDb.close();
      } catch (e) {
        fs.unlink(tmpPath, () => {});
        return res.status(400).json({ error: `Backup file appears corrupt: ${e.message}` });
      }

      // Get the live DB path
      const DATA_DIR  = process.env.DATA_DIR || path.join(__dirname, '..');
      const liveDbPath = path.join(DATA_DIR, 'connecthub.db');

      // Use better-sqlite3 restore: open the uploaded DB and backup INTO the live DB
      // This is safe because .backup() copies page-by-page with WAL checkpoints
      const srcDb = new Database(tmpPath, { readonly: true });
      await srcDb.backup(liveDbPath);
      srcDb.close();
      fs.unlink(tmpPath, () => {});

      log.admin(`♻ DB RESTORED from backup — by @${req.user.username}`);
      // Note: we don't logAdminAction here because the log table was just replaced
      res.json({ success: true, message: 'Database restored. The server will continue running with the restored data.' });
    } catch (err) { send500(res, err); }
  }
);


module.exports = router;
module.exports.callAI = callAI;
module.exports.notifyPostModeration = notifyPostModeration;
