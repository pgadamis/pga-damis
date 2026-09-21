/**
 * routes/users.js
 *
 * GET  /api/users/me              — logged-in user's own profile
 * PUT  /api/users/me              — update own profile
 * PUT  /api/users/me/avatar       — change avatar (Cloudinary)
 * PUT  /api/users/me/cover        — change cover photo (Cloudinary)
 * GET  /api/users/search?q=...    — search users
 * GET  /api/users/suggested       — suggested people to follow
 * GET  /api/users/:username       — any user's public profile
 * GET  /api/users/:username/posts — a user's posts
 * POST /api/users/:id/follow      — follow / unfollow toggle
 */

const express = require('express');
const router  = express.Router();

const { requireAuth } = require('../middleware/auth');
const { uploadAvatar, uploadCover, uploadIdDocs, multerUpload, toCloudinary, resizeImage, hasCloudinary } = require('../middleware/upload');
const {
  findUserById, findUserByUsername, updateUser, getUserPosts,
  toggleFollow, isFollowing, getFollowerCount, getFollowingCount,
  getSuggestedUsers, searchUsers,
  createNotification,
  submitIdVerification,
  sendFollowRequest, acceptFollowRequest, declineFollowRequest,
  cancelFollowRequest, getPendingFollowRequests, getFollowRequestStatus,
  sendFriendRequest, acceptFriendRequest, declineFriendRequest, removeFriend,
  getFriendshipStatus, areFriends, getPendingFriendRequests, getOutgoingFriendRequests, getFriendCount,
  db, setBillComment, setBillReceipt,
  getReputationScore, getMyRepVote, setRepVote,
  createUserReport,
  createMaintenanceRequest, getMaintenanceRequests,
  createIncidentReport, getIncidentReports,
} = require('../utils/db');

const log = require('../utils/logger');

function publicProfile(user, extras = {}) {
  return {
    id:               user.id,
    firstName:        user.firstName,
    middleName:       user.middleName  || '',
    lastName:         user.lastName,
    suffix:           user.suffix      || '',
    username:         user.username,
    avatar:           user.avatar      || '',
    coverPhoto:       user.coverPhoto  || '',
    bio:              user.bio         || '',
    location:         user.location    || '',
    permanentAddress: user.permanentAddress || '',
    course:           user.course      || '',
    yearLevel:        user.yearLevel   || '',
    idVerified:       user.idVerified,
    createdAt:        user.createdAt,
    ...extras,
  };
}

// ════════════════════════════════════════════════════
// GET SELF
// ════════════════════════════════════════════════════
router.get('/api/users/me', requireAuth, (req, res) => {
  const user = findUserById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json({
    user: {
      ...publicProfile(user),
      email:       user.email,
      phone:       user.phone,
      birthday:    user.birthday,
      sex:         user.sex,
      authProvider: user.authProvider,
      role:        user.role,
      followerCount:  getFollowerCount(user.id),
      followingCount: getFollowingCount(user.id),
    }
  });
});

// ════════════════════════════════════════════════════
// UPDATE PROFILE
// ════════════════════════════════════════════════════
router.put('/api/users/me', requireAuth, (req, res) => {
  // Only bio is user-editable; name and address are set at registration
  const fields = {};
  if (req.body.bio !== undefined) fields.bio = String(req.body.bio).slice(0, 160);
  if (!Object.keys(fields).length) return res.status(400).json({ error: 'No editable fields provided.' });
  updateUser(req.user.id, fields);
  const updated = findUserById(req.user.id);
  log.info(`Profile updated by @${req.user.username} — fields: ${Object.keys(fields).join(', ')}`);
  res.json({ user: publicProfile(updated) });
});

// ════════════════════════════════════════════════════
// CHANGE AVATAR
// ════════════════════════════════════════════════════
router.put('/api/users/me/avatar', requireAuth, ...uploadAvatar, (req, res) => {
  if (!req.cloudinaryUrl) return res.status(400).json({ error: 'No image provided.' });
  updateUser(req.user.id, { avatar: req.cloudinaryUrl });
  res.json({ avatar: req.cloudinaryUrl });
});

// ════════════════════════════════════════════════════
// CHANGE COVER PHOTO
// ════════════════════════════════════════════════════
router.put('/api/users/me/cover', requireAuth, ...uploadCover, (req, res) => {
  if (!req.cloudinaryUrl) return res.status(400).json({ error: 'No image provided.' });
  updateUser(req.user.id, { coverPhoto: req.cloudinaryUrl });
  res.json({ coverPhoto: req.cloudinaryUrl });
});

// ════════════════════════════════════════════════════
// SEARCH
// ════════════════════════════════════════════════════
router.get('/api/users/search', (req, res) => {
  const { q } = req.query;
  if (!q?.trim()) return res.json({ users: [] });
  const viewerId = req.isAuthenticated() ? req.user.id : null;
  const results  = searchUsers(q.trim(), viewerId);
  res.json({ users: results });
});

// ════════════════════════════════════════════════════
// SUGGESTED USERS
// ════════════════════════════════════════════════════
router.get('/api/users/suggested', requireAuth, (req, res) => {
  const users = getSuggestedUsers(req.user.id, 6);
  res.json({ users });
});

// ════════════════════════════════════════════════════
// LITERAL routes that must precede /:username wildcard
// ════════════════════════════════════════════════════
router.get('/api/users/friend-requests', requireAuth, (req, res) => {
  const incoming = getPendingFriendRequests(req.user.id);
  const outgoing = getOutgoingFriendRequests(req.user.id);
  log.info(`Friend requests for @${req.user.username}: ${incoming.length} incoming, ${outgoing.length} outgoing`);
  res.json({ requests: incoming, outgoing });
});
router.get('/api/users/follow-requests', requireAuth, (req, res) => {
  res.json({ requests: getPendingFriendRequests(req.user.id) });
});

// PUBLIC PROFILE  (must be after /me, /search, /suggested)
// ════════════════════════════════════════════════════
router.get('/api/users/:username', (req, res) => {
  const user = findUserByUsername(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  if (user.accountStatus !== 'approved') {
    return res.status(404).json({ error: 'User not found.' });
  }

  const viewerId = req.isAuthenticated() ? req.user.id : null;
  const reputationScore = getReputationScore(user.id);
  const myVote          = viewerId ? getMyRepVote(viewerId, user.id) : 0;

  res.json({
    user: publicProfile(user, {
      followerCount:       getFollowerCount(user.id),
      followingCount:      getFollowingCount(user.id),
      isFollowing:         viewerId ? isFollowing(viewerId, user.id) : false,
      followRequestStatus: viewerId ? getFollowRequestStatus(viewerId, user.id) : null,
      friendshipStatus:    viewerId ? getFriendshipStatus(viewerId, user.id) : null,
      areFriends:          viewerId ? areFriends(viewerId, user.id) : false,
      friendCount:         getFriendCount(user.id),
      reputationScore,
      myVote,
    })
  });
});

// ════════════════════════════════════════════════════
// USER'S POSTS
// ════════════════════════════════════════════════════
router.get('/api/users/:username/posts', (req, res) => {
  const user = findUserByUsername(req.params.username);
  if (!user || user.accountStatus !== 'approved') return res.status(404).json({ error: 'User not found.' });
  const page     = parseInt(req.query.page)  || 1;
  const limit    = parseInt(req.query.limit) || 10;
  const viewerId = req.isAuthenticated() ? req.user.id : null;
  const posts    = getUserPosts({ userId: user.id, viewerId, page, limit });
  res.json({ posts, page, hasMore: posts.length === limit });
});

// ════════════════════════════════════════════════════
// FOLLOW / UNFOLLOW / FOLLOW REQUESTS
// ════════════════════════════════════════════════════

// POST /api/users/:id/friend — send friend request
router.post('/api/users/:id/friend', requireAuth, (req, res) => {
  const targetId = req.params.id;
  if (targetId === req.user.id) return res.status(400).json({ error: 'Cannot friend yourself.' });
  const target = findUserById(targetId);
  if (!target) return res.status(404).json({ error: 'User not found.' });

  const result = sendFriendRequest(req.user.id, targetId);
  if (!result.existing) {
    log.friend(`@${req.user.username} → @${target.username} (sent)`);
    createNotification({
      userId: targetId, type: 'friend_request', actorId: req.user.id,
      targetId: req.user.id, message: `${req.user.firstName} sent you a friend request`,
    });
    const io = req.app.get('io');
    if (io) io.to(`user:${targetId}`).emit('new-notification', { userId: targetId });
  } else {
    log.friend(`@${req.user.username} → @${target.username} (already ${result.status})`);
  }
  res.json({ status: result.status, friendshipStatus: getFriendshipStatus(req.user.id, targetId) });
});

// POST /api/users/:id/friend/accept — accept friend request
router.post('/api/users/:id/friend/accept', requireAuth, (req, res) => {
  acceptFriendRequest(req.params.id, req.user.id);
  const fc = getFriendCount(req.user.id);
  log.friend(`✅ @${req.user.username} accepted from user ${req.params.id} | friends: ${fc}`);
  // Mark the friend_request notification from this actor as read so it doesn't re-show
  db.prepare("UPDATE notifications SET is_read=1 WHERE user_id=? AND type='friend_request' AND actor_id=?").run(req.user.id, req.params.id);
  createNotification({
    userId: req.params.id, type: 'friend_accept', actorId: req.user.id,
    targetId: req.user.id, message: `${req.user.firstName} accepted your friend request`,
  });
  const io = req.app.get('io');
  if (io) io.to(`user:${req.params.id}`).emit('new-notification', { userId: req.params.id });
  res.json({ success: true, areFriends: true, friendCount: fc });
});

// POST /api/users/:id/friend/decline — decline friend request
router.post('/api/users/:id/friend/decline', requireAuth, (req, res) => {
  declineFriendRequest(req.params.id, req.user.id);
  db.prepare("UPDATE notifications SET is_read=1 WHERE user_id=? AND type='friend_request' AND actor_id=?").run(req.user.id, req.params.id);
  res.json({ success: true });
});

// DELETE /api/users/:id/friend — unfriend or cancel request
router.delete('/api/users/:id/friend', requireAuth, (req, res) => {
  removeFriend(req.user.id, req.params.id);
  // Cancel: mark the friend_request notification on THEIR side as read
  // so they no longer see Accept/Decline buttons
  db.prepare("UPDATE notifications SET is_read=1 WHERE user_id=? AND type='friend_request' AND actor_id=?")
    .run(req.params.id, req.user.id);
  // Also clean up any notification WE received from them (in case of mutual)
  db.prepare("UPDATE notifications SET is_read=1 WHERE user_id=? AND type='friend_request' AND actor_id=?")
    .run(req.user.id, req.params.id);
  log.friend(`@${req.user.username} cancelled/unfriended user ${req.params.id}`);
  res.json({ success: true, areFriends: false });
});

// ════════════════════════════════════════════════════
// VERIFICATION STATUS (own account)
// ════════════════════════════════════════════════════
router.get('/api/users/me/verification-status', requireAuth, (req, res) => {
  const latest = db.prepare(
    `SELECT status, created_at, reviewed_at, admin_notes FROM id_verification_requests
     WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`
  ).get(req.user.id);
  res.json({ status: latest?.status || null, request: latest || null });
});

// ════════════════════════════════════════════════════
// ID VERIFICATION SUBMISSION (with file upload)
// ════════════════════════════════════════════════════
router.post('/api/users/me/submit-verification', requireAuth, ...uploadIdDocs, async (req, res) => {
  try {
    const urls = req.idDocUrls || {};
    // Also accept raw URLs (e.g. already-uploaded Cloudinary URLs)
    const idFrontUrl = urls.id_front || req.body.idFrontUrl || '';
    const idBackUrl  = urls.id_back  || req.body.idBackUrl  || '';
    const selfieUrl  = urls.selfie   || req.body.selfieUrl  || '';
    const idType     = req.body.idType || 'national_id';

    if (!idFrontUrl) return res.status(400).json({ error: 'ID front photo is required.' });

    const reqId = submitIdVerification({
      userId: req.user.id,
      idFrontUrl,
      idBackUrl,
      selfieUrl,
      idType,
    });
    res.json({ success: true, requestId: reqId, message: 'Verification request submitted. An admin will review it shortly.' });
  } catch (err) {
    console.error('submit-verification error:', err);
    res.status(500).json({ error: 'Failed to submit verification request.' });
  }
});

// POST /api/users/:id/follow-only — follow without friending
router.post('/api/users/:id/follow-only', requireAuth, (req, res) => {
  const targetId = req.params.id;
  if (targetId === req.user.id) return res.status(400).json({ error: 'Cannot follow yourself.' });
  const target = findUserById(targetId);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  // If already following, unfollow
  if (isFollowing(req.user.id, targetId)) {
    toggleFollow(req.user.id, targetId);
    return res.json({ following: false, followerCount: getFollowerCount(targetId) });
  }
  // Follow them
  toggleFollow(req.user.id, targetId);
  if (req.user.id !== targetId) {
    createNotification({ userId: targetId, type: 'follow', actorId: req.user.id, targetId: req.user.id, message: `${req.user.firstName} started following you` });
    const io = req.app.get('io');
    if (io) io.to(`user:${targetId}`).emit('new-notification', { userId: targetId });
  }
  res.json({ following: true, followerCount: getFollowerCount(targetId) });
});

// DELETE /api/users/:id/follow-only — unfollow
router.delete('/api/users/:id/follow-only', requireAuth, (req, res) => {
  if (isFollowing(req.user.id, req.params.id)) toggleFollow(req.user.id, req.params.id);
  res.json({ following: false, followerCount: getFollowerCount(req.params.id) });
});

/**
 * Dump the real column list of a table to the log.
 *
 * Used only on the failure path below. The most common cause of an
 * unexplained 500 on a hand-written SELECT is a column that exists in the
 * CREATE TABLE in utils/db.js but NOT in the deployed database — SQLite's
 * CREATE TABLE IF NOT EXISTS is a no-op on an existing table, so a column
 * added to that statement later never reaches a database that already
 * existed. Printing what production actually has turns a mystery into a
 * one-line diagnosis.
 */
function logTableColumns(table) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.length) {
      log.error(`[dorm]   ${table}: TABLE DOES NOT EXIST`);
      return;
    }
    log.error(`[dorm]   ${table}: ${cols.map(c => c.name).join(', ')}`);
  } catch (e) {
    log.error(`[dorm]   ${table}: could not read schema — ${e.message}`);
  }
}

// GET /api/users/me/dormitory — current user's bed assignment + billing
//
// Each section is queried in its own try block. A failure in billing or in the
// GCash settings must not hide the resident's room number — before, any one
// error threw out of a single try/catch and the whole widget rendered
// "Could not load dormitory info." with nothing in the server log to explain
// why, because the message was returned to the browser and never logged.
router.get('/api/users/me/dormitory', requireAuth, (req, res) => {
  const userId   = req.user?.id;
  const warnings = [];

  if (!userId) {
    // Should be impossible behind requireAuth, but a silent undefined bind
    // would otherwise produce a confusing empty result rather than an error.
    log.error(`[dorm] /me/dormitory reached with no req.user.id — session shape: ${JSON.stringify(Object.keys(req.user || {}))}`);
    res._errMsg = 'no req.user.id on an authenticated request';
    return res.status(500).json({ error: 'Your session is missing a user id. Please log out and back in.' });
  }

  // ── 1. Bed assignment (the part the widget most needs) ────────────────
  let assignment = null;
  try {
    assignment = db.prepare(
      'SELECT ba.bed_number, ba.assigned_at, ba.notes, ' +
      'dr.room_number, dr.gender, dr.capacity ' +
      'FROM bed_assignments ba ' +
      'JOIN dorm_rooms dr ON dr.id = ba.room_id ' +
      'WHERE ba.user_id = ?'
    ).get(userId);
  } catch (err) {
    // This is the only genuinely fatal branch — without it there is no room
    // number to show. Log loudly, with the actual schema, then fail.
    log.error(`[dorm] Bed-assignment query FAILED for user ${userId}: ${err.message}`);
    log.error('[dorm] Actual deployed schema:');
    logTableColumns('bed_assignments');
    logTableColumns('dorm_rooms');
    res._errMsg = `bed-assignment query: ${err.message}`;
    return res.status(500).json({
      error: 'Could not read your room assignment.',
      // Surfaced in development only — never leak SQL details in production.
      detail: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }

  // ── 2. Billing history (degrade gracefully) ───────────────────────────
  let billing = [];
  try {
    billing = db.prepare(
      'SELECT id, status, month, amount, paid_at, notes, user_comment, receipt_url ' +
      'FROM dorm_billing WHERE user_id=? ORDER BY month DESC LIMIT 12'
    ).all(userId);
  } catch (err) {
    log.error(`[dorm] Billing query failed for user ${userId}: ${err.message}`);
    logTableColumns('dorm_billing');
    warnings.push('billing');
  }

  const hasBills    = billing.length > 0;
  const unpaidCount = billing.filter(b => b.status === 'unpaid' || b.status === 'overdue').length;

  // ── 3. GCash payment info set by admin (degrade gracefully) ───────────
  let gcashQr = '', gcashNumber = '';
  try {
    const { getSetting } = require('../utils/db');
    gcashQr     = getSetting('gcash_qr_url', '') || '';
    gcashNumber = getSetting('gcash_number', '') || '';
  } catch (err) {
    log.error(`[dorm] GCash settings lookup failed: ${err.message}`);
    warnings.push('payment-info');
  }

  if (warnings.length) {
    log.warn(`[dorm] /me/dormitory served with degraded sections for user ${userId}: ${warnings.join(', ')}`);
  }

  if (!assignment) {
    // Not an error — the resident simply has no bed yet. Logged so an
    // "admin says it's assigned but the widget says no" report is checkable.
    log.dorm(`/me/dormitory — user ${userId} has NO bed_assignments row`);
    return res.json({ assigned: false, billing, hasBills, unpaidCount, gcashQr, gcashNumber, warnings });
  }

  log.dorm(`/me/dormitory — user ${userId} → room ${assignment.room_number} bed ${assignment.bed_number} (${billing.length} bill(s), ${unpaidCount} unpaid)`);

  res.json({
    assigned: true,
    roomNumber: assignment.room_number,
    bedNumber: assignment.bed_number,
    gender: assignment.gender,
    assignedAt: assignment.assigned_at,
    notes: assignment.notes,
    billing,
    hasBills,
    unpaidCount,
    gcashQr,
    gcashNumber,
    warnings,
  });
});

// GET /api/users/dormitory/residents — all assigned residents (visible to authenticated users)
router.get('/api/users/dormitory/residents', requireAuth, (req, res) => {
  try {
    const residents = db.prepare(`
      SELECT u.id, u.first_name, u.last_name, u.username, u.avatar, u.course, u.year_level, u.sex,
             dr.room_number, dr.gender as room_gender,
             ba.bed_number, ba.assigned_at
      FROM bed_assignments ba
      JOIN users u ON u.id = ba.user_id
      JOIN dorm_rooms dr ON dr.id = ba.room_id
      WHERE u.is_active = 1
      ORDER BY dr.room_number, ba.bed_number
    `).all();
    res.json({ residents });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/users/me/billing/:billId/comment — resident adds/updates a dispute note
router.put('/api/users/me/billing/:billId/comment', requireAuth, (req, res) => {
  try {
    const { comment } = req.body;
    if (comment === undefined) return res.status(400).json({ error: 'comment is required' });
    const result = setBillComment(req.params.billId, req.user.id, comment);
    if (!result.changes) return res.status(404).json({ error: 'Bill not found or does not belong to you' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════
// REPUTATION VOTING   POST /api/users/:username/reputation
// Body: { value: 1 | -1 }   Anonymous to the target.
// ════════════════════════════════════════════════════
router.post('/api/users/:username/reputation', requireAuth, (req, res) => {
  const target = findUserByUsername(req.params.username);
  if (!target || target.accountStatus !== 'approved') return res.status(404).json({ error: 'User not found.' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot vote on your own reputation.' });

  const value = parseInt(req.body.value, 10);
  if (![1, -1].includes(value)) return res.status(400).json({ error: 'value must be 1 or -1.' });

  const result = setRepVote(req.user.id, target.id, value);

  // Notify target anonymously (no actor name exposed in message)
  const action = result.action; // 'added', 'removed', 'changed'
  if (action !== 'removed') {
    const label = value === 1 ? 'a positive' : 'a negative';
    createNotification({
      userId:  target.id,
      type:    'reputation',
      actorId: req.user.id,   // stored in DB but not shown in UI message
      message: `Someone gave you ${label} reputation point.`,
    });
    const io = req.app.get('io');
    if (io) io.to(`user:${target.id}`).emit('new-notification', { userId: target.id });
  }

  log.info(`Reputation vote: @${req.user.username} → @${target.username} (${value > 0 ? '+' : ''}${value}) [${action}]`);
  res.json({ success: true, action, score: getReputationScore(target.id), myVote: getMyRepVote(req.user.id, target.id) });
});

// ════════════════════════════════════════════════════
// REPORT USER   POST /api/users/:username/report
// Body: { reason, details }   Anonymous.
// ════════════════════════════════════════════════════
router.post('/api/users/:username/report', requireAuth, (req, res) => {
  const target = findUserByUsername(req.params.username);
  if (!target || target.accountStatus !== 'approved') return res.status(404).json({ error: 'User not found.' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot report yourself.' });

  const { reason, details } = req.body;
  if (!reason?.trim()) return res.status(400).json({ error: 'A reason is required.' });

  createUserReport({ reporterId: req.user.id, targetId: target.id, reason: reason.trim(), details: details?.trim() || '' });

  log.info(`User report: @${req.user.username} reported @${target.username} — reason: "${reason}"`);
  res.json({ success: true, message: 'Report submitted. Thank you for helping keep the community safe.' });
});

// ── Maintenance Requests (user side) ──────────────────────────────────────────

// Submit a new maintenance request
// ── Submit a maintenance request (optionally with a photo) ───────────────────
router.post('/api/maintenance/requests', requireAuth, multerUpload.single('image'), async (req, res) => {
  const { category, title, description, location, priority } = req.body;
  if (!title?.trim() || !description?.trim()) return res.status(400).json({ error: 'Title and description are required.' });
  try {
    let imageUrl = '';
    if (req.file) {
      const buf = await resizeImage(req.file.buffer, { width: 1200, quality: 80 });
      imageUrl = hasCloudinary
        ? (await toCloudinary(buf, 'damis/maintenance')).secure_url
        : `data:${req.file.mimetype};base64,${buf.toString('base64')}`;
    }
    const id = createMaintenanceRequest({
      userId: req.user.id,
      category: category || 'general',
      title: title.trim(),
      description: description.trim(),
      location: location?.trim() || '',
      priority: priority || 'normal',
      imageUrl,
    });
    log.info(`Maintenance request submitted by @${req.user.username}: "${title.trim()}" [${category}]${imageUrl ? ' +photo' : ''}`);
    res.json({ success: true, id });
  } catch (e) {
    log.error('createMaintenanceRequest error:', e.message);
    res.status(500).json({ error: 'Failed to submit request.' });
  }
});

// ── Upload GCash receipt for a billing record ────────────────────────────────
// POST /api/billing/:billId/receipt   multipart: image field "receipt"
router.post('/api/billing/:billId/receipt', requireAuth, multerUpload.single('receipt'), async (req, res) => {
  const { billId } = req.params;
  if (!req.file) return res.status(400).json({ error: 'No receipt image uploaded.' });
  try {
    // Verify the bill belongs to this user
    const bill = require('../utils/db').db.prepare(
      'SELECT id, user_id, status FROM dorm_billing WHERE id=? AND user_id=?'
    ).get(billId, req.user.id);
    if (!bill) return res.status(404).json({ error: 'Billing record not found.' });

    const buf = await resizeImage(req.file.buffer, { width: 1600, quality: 85 });
    const receiptUrl = hasCloudinary
      ? (await toCloudinary(buf, 'damis/receipts')).secure_url
      : `data:${req.file.mimetype};base64,${buf.toString('base64')}`;

    setBillReceipt(billId, req.user.id, receiptUrl);
    log.info(`[billing] Receipt uploaded by @${req.user.username} for bill ${billId}`);
    res.json({ success: true, receiptUrl });
  } catch (e) {
    log.error('setBillReceipt error:', e.message);
    res.status(500).json({ error: 'Failed to upload receipt.' });
  }
});

// Get own maintenance requests
router.get('/api/maintenance/requests/mine', requireAuth, (req, res) => {
  const { status } = req.query;
  const requests = getMaintenanceRequests({ userId: req.user.id, status: status || 'all' });
  res.json(requests);
});

// ── Incident Reports (user side) ──────────────────────────────────────────────
// Kept as a separate resource from maintenance requests — incidents are safety/
// conduct/security concerns, not repair requests, and admins triage them differently.

// Submit a new incident report (optionally with a photo)
router.post('/api/incidents', requireAuth, multerUpload.single('image'), async (req, res) => {
  const { category, title, description, location, severity } = req.body;
  if (!title?.trim() || !description?.trim()) return res.status(400).json({ error: 'Title and description are required.' });
  try {
    let imageUrl = '';
    if (req.file) {
      const buf = await resizeImage(req.file.buffer, { width: 1200, quality: 80 });
      imageUrl = hasCloudinary
        ? (await toCloudinary(buf, 'damis/incidents')).secure_url
        : `data:${req.file.mimetype};base64,${buf.toString('base64')}`;
    }
    const id = createIncidentReport({
      userId: req.user.id,
      category: category || 'other',
      title: title.trim(),
      description: description.trim(),
      location: location?.trim() || '',
      severity: severity || 'medium',
      imageUrl,
    });
    log.info(`Incident report submitted by @${req.user.username}: "${title.trim()}" [${category || 'other'}]${imageUrl ? ' +photo' : ''}`);

    // Real-time nudge for admins — incidents (safety/security) warrant faster
    // visibility than routine maintenance items, which don't push over sockets.
    const io = req.app.get('io');
    if (io) io.to('admins').emit('new-incident', { id, title: title.trim(), severity: severity || 'medium' });

    res.json({ success: true, id });
  } catch (e) {
    log.error('createIncidentReport error:', e.message);
    res.status(500).json({ error: 'Failed to submit report.' });
  }
});

// Get own incident reports
router.get('/api/incidents/mine', requireAuth, (req, res) => {
  const { status } = req.query;
  const reports = getIncidentReports({ userId: req.user.id, status: status || 'all' });
  res.json(reports);
});


module.exports = router;
