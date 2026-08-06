/**
 * utils/db.js — SQLite Database Layer
 *
 * Replaces the old in-memory userStore.js.
 * Uses better-sqlite3 — synchronous, fast, zero config.
 * All data is saved to connecthub.db in your project root.
 *
 * Tables:
 *   users         — all registered accounts
 *   posts         — feed posts
 *   comments      — comments on posts
 *   likes         — likes on posts
 *   follows       — follow relationships
 *   notifications — activity alerts
 *   otp_store     — pending email OTPs (registration)
 *   reset_store   — pending password reset OTPs
 *   login_attempts— brute-force tracking
 */

const Database = require('better-sqlite3');
const path     = require('path');
const { randomUUID } = require('crypto');
const log      = require('./logger');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
const db = new Database(path.join(DATA_DIR, 'connecthub.db'));

// ── Performance: WAL mode makes reads faster ──────────
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// 16 MB page cache (negative = KiB). Dramatically speeds up complex JOINs
// on tables like users + posts + notifications without extra memory pressure.
db.pragma('cache_size = -16384');
// NORMAL durability: fsync only at checkpoints, not every commit.
// Safe for Railway's hosted filesystem; trades theoretical crash-recovery
// window (milliseconds) for ~3× write throughput. WAL already provides
// crash safety for readers.
db.pragma('synchronous = NORMAL');

// ══════════════════════════════════════════════════════
// SCHEMA
// ══════════════════════════════════════════════════════
db.exec(`
  CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS users (
    id             TEXT PRIMARY KEY,
    google_id      TEXT UNIQUE,
    email          TEXT UNIQUE NOT NULL,
    password       TEXT,
    first_name     TEXT NOT NULL,
    middle_name    TEXT DEFAULT '',
    last_name      TEXT NOT NULL,
    suffix         TEXT DEFAULT '',
    username       TEXT UNIQUE NOT NULL,
    birthday       TEXT,
    sex            TEXT,
    civil_status   TEXT DEFAULT '',
    phone          TEXT UNIQUE,
    bio            TEXT DEFAULT '',
    location       TEXT DEFAULT '',
    present_address  TEXT DEFAULT '',
    permanent_address TEXT DEFAULT '',
    school_name    TEXT DEFAULT '',
    course         TEXT DEFAULT '',
    year_level     TEXT DEFAULT '',
    school_address TEXT DEFAULT '',
    father_info    TEXT DEFAULT '',
    mother_info    TEXT DEFAULT '',
    monthly_income TEXT DEFAULT '',
    avatar         TEXT DEFAULT '',
    cover_photo    TEXT DEFAULT '',
    email_verified INTEGER DEFAULT 0,
    id_verified    INTEGER DEFAULT 0,
    auth_provider  TEXT DEFAULT 'local',
    role           TEXT DEFAULT 'user',
    is_active      INTEGER DEFAULT 1,
    created_at     TEXT DEFAULT (datetime('now')),
    updated_at     TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS posts (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content    TEXT NOT NULL,
    image_url  TEXT DEFAULT '',
    privacy    TEXT DEFAULT 'public',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS comments (
    id         TEXT PRIMARY KEY,
    post_id    TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_id  TEXT REFERENCES comments(id) ON DELETE CASCADE,
    content    TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Reactions: replace simple likes with typed reactions on posts/comments/messages
  CREATE TABLE IF NOT EXISTS reactions (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_id   TEXT NOT NULL,
    target_type TEXT NOT NULL,   -- 'post' | 'comment' | 'message'
    emoji       TEXT NOT NULL DEFAULT 'like',
    created_at  TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, target_id, target_type)
  );

  -- Follow requests (for private/friend-request style follows)
  CREATE TABLE IF NOT EXISTS follow_requests (
    id           TEXT PRIMARY KEY,
    from_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status       TEXT DEFAULT 'pending',  -- 'pending' | 'accepted' | 'declined'
    created_at   TEXT DEFAULT (datetime('now')),
    UNIQUE(from_id, to_id)
  );

  -- Facebook-style mutual friendship (accepted = both see each other as friends)
  CREATE TABLE IF NOT EXISTS friendships (
    id           TEXT PRIMARY KEY,
    user_a       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_b       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status       TEXT DEFAULT 'pending',  -- 'pending' | 'friends'
    requester    TEXT NOT NULL,           -- who sent the request
    created_at   TEXT DEFAULT (datetime('now')),
    UNIQUE(user_a, user_b)
  );

  -- Message reactions
  CREATE TABLE IF NOT EXISTS message_reactions (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    emoji       TEXT NOT NULL DEFAULT 'like',
    created_at  TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, message_id)
  );

  CREATE TABLE IF NOT EXISTS likes (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_id   TEXT NOT NULL,
    target_type TEXT NOT NULL DEFAULT 'post',
    created_at  TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, target_id, target_type)
  );

  CREATE TABLE IF NOT EXISTS follows (
    id           TEXT PRIMARY KEY,
    follower_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    following_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   TEXT DEFAULT (datetime('now')),
    UNIQUE(follower_id, following_id)
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type       TEXT NOT NULL,
    actor_id   TEXT REFERENCES users(id) ON DELETE CASCADE,
    target_id  TEXT,
    message    TEXT,
    is_read    INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS otp_store (
    email      TEXT PRIMARY KEY,
    otp        TEXT NOT NULL,
    first_name TEXT DEFAULT '',
    expires_at TEXT NOT NULL,
    attempts   INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS reset_store (
    email      TEXT PRIMARY KEY,
    otp        TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    attempts   INTEGER DEFAULT 0,
    verified   INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS login_attempts (
    email        TEXT PRIMARY KEY,
    count        INTEGER DEFAULT 0,
    locked_until TEXT
  );

  CREATE TABLE IF NOT EXISTS messages (
    id          TEXT PRIMARY KEY,
    sender_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    receiver_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content     TEXT DEFAULT '',
    image_url   TEXT DEFAULT '',
    is_read     INTEGER DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_messages_sender   ON messages(sender_id);
  CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_id);
  CREATE INDEX IF NOT EXISTS idx_messages_created  ON messages(created_at DESC);

  -- ID verification requests
  CREATE TABLE IF NOT EXISTS id_verification_requests (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id_front_url TEXT NOT NULL,
    id_back_url  TEXT DEFAULT '',
    selfie_url   TEXT DEFAULT '',
    id_type      TEXT DEFAULT 'school_id',
    cert_residency_url   TEXT DEFAULT '',
    cert_low_income_url  TEXT DEFAULT '',
    cert_enrollment_url  TEXT DEFAULT '',
    status       TEXT DEFAULT 'pending',
    ai_score     REAL DEFAULT NULL,
    ai_notes     TEXT DEFAULT '',
    admin_notes  TEXT DEFAULT '',
    reviewed_by  TEXT REFERENCES users(id),
    created_at   TEXT DEFAULT (datetime('now')),
    reviewed_at  TEXT DEFAULT NULL
  );

  -- Admin action logs
  CREATE TABLE IF NOT EXISTS admin_logs (
    id         TEXT PRIMARY KEY,
    admin_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action     TEXT NOT NULL,
    target_type TEXT,
    target_id  TEXT,
    details    TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_id_verif_user   ON id_verification_requests(user_id);
  CREATE INDEX IF NOT EXISTS idx_id_verif_status ON id_verification_requests(status);
  CREATE INDEX IF NOT EXISTS idx_admin_logs      ON admin_logs(created_at DESC);

  -- AI moderation action log — every AI review decision recorded here
  CREATE TABLE IF NOT EXISTS ai_moderation_log (
    id          TEXT PRIMARY KEY,
    post_id     TEXT NOT NULL,
    post_content TEXT DEFAULT '',
    author_username TEXT DEFAULT '',
    verdict     TEXT NOT NULL,
    score       INTEGER DEFAULT NULL,
    flags       TEXT DEFAULT '',
    summary     TEXT DEFAULT '',
    action_taken TEXT DEFAULT 'none',
    reviewed_by TEXT DEFAULT 'ai',
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_ai_mod_log ON ai_moderation_log(created_at DESC);

  -- Rejected registration archive — stores full snapshot so admins can review/restore
  CREATE TABLE IF NOT EXISTS rejected_registrations (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    first_name      TEXT NOT NULL,
    middle_name     TEXT DEFAULT '',
    last_name       TEXT NOT NULL,
    suffix          TEXT DEFAULT '',
    username        TEXT NOT NULL,
    email           TEXT NOT NULL,
    phone           TEXT DEFAULT '',
    birthday        TEXT DEFAULT '',
    sex             TEXT DEFAULT '',
    bio             TEXT DEFAULT '',
    location        TEXT DEFAULT '',
    avatar          TEXT DEFAULT '',
    auth_provider   TEXT DEFAULT 'local',
    id_front_url    TEXT DEFAULT '',
    id_back_url     TEXT DEFAULT '',
    selfie_url      TEXT DEFAULT '',
    id_type         TEXT DEFAULT '',
    rejection_reason TEXT DEFAULT '',
    rejected_by     TEXT NOT NULL,
    rejected_at     TEXT DEFAULT (datetime('now')),
    original_created_at TEXT DEFAULT '',
    password_hash   TEXT DEFAULT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_rejected_reg_email ON rejected_registrations(email);

  CREATE TABLE IF NOT EXISTS deleted_users (
    id                  TEXT PRIMARY KEY,
    original_id         TEXT NOT NULL,
    first_name          TEXT NOT NULL,
    middle_name         TEXT DEFAULT '',
    last_name           TEXT NOT NULL,
    suffix              TEXT DEFAULT '',
    username            TEXT NOT NULL,
    email               TEXT NOT NULL,
    phone               TEXT DEFAULT '',
    birthday            TEXT DEFAULT '',
    sex                 TEXT DEFAULT '',
    civil_status        TEXT DEFAULT '',
    bio                 TEXT DEFAULT '',
    location            TEXT DEFAULT '',
    avatar              TEXT DEFAULT '',
    auth_provider       TEXT DEFAULT 'local',
    role                TEXT DEFAULT 'user',
    present_address     TEXT DEFAULT '',
    permanent_address   TEXT DEFAULT '',
    school_name         TEXT DEFAULT '',
    course              TEXT DEFAULT '',
    year_level          TEXT DEFAULT '',
    school_address      TEXT DEFAULT '',
    father_info         TEXT DEFAULT '',
    mother_info         TEXT DEFAULT '',
    monthly_income      TEXT DEFAULT '',
    id_front_url        TEXT DEFAULT '',
    id_back_url         TEXT DEFAULT '',
    selfie_url          TEXT DEFAULT '',
    cert_residency_url  TEXT DEFAULT '',
    cert_low_income_url TEXT DEFAULT '',
    cert_enrollment_url TEXT DEFAULT '',
    original_created_at TEXT DEFAULT '',
    deleted_by          TEXT DEFAULT '',
    deleted_at          TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_deleted_users_email ON deleted_users(email);

  CREATE INDEX IF NOT EXISTS idx_posts_user    ON posts(user_id);
  CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
  CREATE INDEX IF NOT EXISTS idx_likes_target  ON likes(target_id, target_type);
  CREATE INDEX IF NOT EXISTS idx_follows_follower  ON follows(follower_id);
  CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);
  CREATE INDEX IF NOT EXISTS idx_notif_user    ON notifications(user_id, is_read);
  CREATE INDEX IF NOT EXISTS idx_users_phone   ON users(phone);
  CREATE INDEX IF NOT EXISTS idx_users_email   ON users(email);
`);

// ── Safe migrations (ALTER TABLE is idempotent via try/catch) ─────────
// SQLite throws "duplicate column name" when a column already exists — that is
// the expected case on every restart after the first.  Any *other* error
// (wrong SQL, disk full, corrupt DB) is unexpected and logged as a warning so
// it doesn't silently swallow a real problem.
function migrate(sql) {
  try { db.prepare(sql).run(); } catch (e) {
    const msg = e.message || '';
    const expected = msg.includes('duplicate column name') ||
                     msg.includes('already exists') ||
                     msg.includes('no such table: sqlite_master'); // harmless race
    if (!expected) log.warn(`[db] Migration warning — ${msg} | SQL: ${sql.slice(0, 80)}`);
  }
}

migrate(`ALTER TABLE posts ADD COLUMN status TEXT DEFAULT 'approved'`);
// account_status: 'pending'=awaiting approval, 'approved'=active, 'rejected'=declined
// Existing users default to 'approved' so nothing breaks on upgrade
migrate(`ALTER TABLE users ADD COLUMN account_status TEXT DEFAULT 'approved'`);
migrate(`ALTER TABLE rejected_registrations ADD COLUMN password_hash TEXT DEFAULT NULL`);
migrate(`ALTER TABLE rejected_registrations ADD COLUMN cert_residency_url  TEXT DEFAULT ''`);
migrate(`ALTER TABLE rejected_registrations ADD COLUMN cert_low_income_url TEXT DEFAULT ''`);
migrate(`ALTER TABLE rejected_registrations ADD COLUMN cert_enrollment_url TEXT DEFAULT ''`);
// ── Fields that were missing from rejected_registrations snapshot ──
migrate(`ALTER TABLE rejected_registrations ADD COLUMN civil_status      TEXT DEFAULT ''`);
migrate(`ALTER TABLE rejected_registrations ADD COLUMN present_address   TEXT DEFAULT ''`);
migrate(`ALTER TABLE rejected_registrations ADD COLUMN permanent_address TEXT DEFAULT ''`);
migrate(`ALTER TABLE rejected_registrations ADD COLUMN school_name       TEXT DEFAULT ''`);
migrate(`ALTER TABLE rejected_registrations ADD COLUMN school_address    TEXT DEFAULT ''`);
migrate(`ALTER TABLE rejected_registrations ADD COLUMN year_level        TEXT DEFAULT ''`);
migrate(`ALTER TABLE rejected_registrations ADD COLUMN course            TEXT DEFAULT ''`);
migrate(`ALTER TABLE rejected_registrations ADD COLUMN avatar_face_x     INTEGER DEFAULT 50`);
migrate(`ALTER TABLE rejected_registrations ADD COLUMN avatar_face_y     INTEGER DEFAULT 50`);
migrate(`ALTER TABLE rejected_registrations ADD COLUMN father_info       TEXT DEFAULT ''`);
migrate(`ALTER TABLE rejected_registrations ADD COLUMN mother_info       TEXT DEFAULT ''`);
migrate(`ALTER TABLE rejected_registrations ADD COLUMN monthly_income    TEXT DEFAULT ''`);
migrate(`ALTER TABLE rejected_registrations ADD COLUMN specialization    TEXT DEFAULT ''`);
migrate(`ALTER TABLE posts ADD COLUMN moderated_by TEXT DEFAULT NULL`);    // 'ai' | 'admin' | NULL
migrate(`ALTER TABLE posts ADD COLUMN ai_reviewed_at TEXT DEFAULT NULL`);  // set when AI reviews (even if no action taken)
migrate(`ALTER TABLE comments ADD COLUMN parent_id TEXT DEFAULT NULL`);
migrate(`ALTER TABLE messages ADD COLUMN image_url TEXT DEFAULT ''`);
migrate(`ALTER TABLE dorm_billing ADD COLUMN user_comment TEXT DEFAULT ''`);
migrate(`CREATE TABLE IF NOT EXISTS friendships (id TEXT PRIMARY KEY, user_a TEXT NOT NULL, user_b TEXT NOT NULL, status TEXT DEFAULT 'pending', requester TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), UNIQUE(user_a, user_b))`);

// ── PGA-DAMIS v1 migrations — new resident application fields ─────────
migrate(`ALTER TABLE users ADD COLUMN civil_status       TEXT DEFAULT ''`);

// ── Dormitory Management Tables ────────────────────────────────────
// CREATE TABLE IF NOT EXISTS never throws "already exists" in SQLite — the
// try/catch here guards only the seeder logic inside, not the DDL itself.
try {
  db.prepare(`CREATE TABLE IF NOT EXISTS dorm_rooms (
    id          INTEGER PRIMARY KEY,
    room_number INTEGER NOT NULL UNIQUE,
    gender      TEXT NOT NULL CHECK(gender IN ('female','male')),
    capacity    INTEGER NOT NULL DEFAULT 4,
    created_at  TEXT DEFAULT (datetime('now'))
  )`).run();

  // Seed default rooms ONLY on first run (table completely empty).
  // Skipped on subsequent restarts so admin deletions/additions persist.
  const roomCount = db.prepare('SELECT COUNT(*) as n FROM dorm_rooms').get().n;
  if (roomCount === 0) {
    const seedRoom = db.prepare('INSERT INTO dorm_rooms (room_number, gender) VALUES (?, ?)');
    db.transaction(() => {
      for (let i = 1;  i <= 13; i++) seedRoom.run(i, 'female');
      for (let i = 14; i <= 26; i++) seedRoom.run(i, 'male');
    })();
    log.info('[db] Seeded 26 default dorm rooms (first-run only).');
  }
} catch (e) {
  log.warn(`[db] dorm_rooms setup error: ${e.message}`);
}

db.prepare(`CREATE TABLE IF NOT EXISTS bed_assignments (
  id          TEXT PRIMARY KEY,
  room_id     INTEGER NOT NULL REFERENCES dorm_rooms(id),
  bed_number  INTEGER NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id),
  assigned_at TEXT DEFAULT (datetime('now')),
  assigned_by TEXT,
  notes       TEXT DEFAULT '',
  UNIQUE(room_id, bed_number),
  UNIQUE(user_id)
)`).run();

db.prepare(`CREATE TABLE IF NOT EXISTS dorm_billing (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  month       TEXT NOT NULL,
  amount      REAL NOT NULL DEFAULT 200,
  status      TEXT NOT NULL DEFAULT 'unpaid' CHECK(status IN ('unpaid','paid','waived')),
  paid_at     TEXT,
  created_at  TEXT DEFAULT (datetime('now')),
  notes       TEXT DEFAULT '',
  UNIQUE(user_id, month)
)`).run();
migrate(`ALTER TABLE users ADD COLUMN present_address    TEXT DEFAULT ''`);
migrate(`ALTER TABLE users ADD COLUMN permanent_address  TEXT DEFAULT ''`);
migrate(`ALTER TABLE users ADD COLUMN school_name        TEXT DEFAULT ''`);
migrate(`ALTER TABLE users ADD COLUMN course             TEXT DEFAULT ''`);
migrate(`ALTER TABLE users ADD COLUMN year_level         TEXT DEFAULT ''`);
migrate(`ALTER TABLE users ADD COLUMN school_address     TEXT DEFAULT ''`);
migrate(`ALTER TABLE users ADD COLUMN father_info        TEXT DEFAULT ''`);
migrate(`ALTER TABLE users ADD COLUMN mother_info        TEXT DEFAULT ''`);
migrate(`ALTER TABLE users ADD COLUMN monthly_income     TEXT DEFAULT ''`);
migrate(`ALTER TABLE users ADD COLUMN avatar_face_x      INTEGER DEFAULT 50`);
migrate(`ALTER TABLE users ADD COLUMN avatar_face_y      INTEGER DEFAULT 50`);
migrate(`ALTER TABLE users ADD COLUMN specialization     TEXT DEFAULT ''`);
// ── PGA-DAMIS cert doc columns on id_verification_requests ────────────
migrate(`ALTER TABLE id_verification_requests ADD COLUMN cert_residency_url   TEXT DEFAULT ''`);
migrate(`ALTER TABLE id_verification_requests ADD COLUMN cert_low_income_url  TEXT DEFAULT ''`);
migrate(`ALTER TABLE id_verification_requests ADD COLUMN cert_enrollment_url  TEXT DEFAULT ''`);
migrate(`CREATE TABLE IF NOT EXISTS message_reactions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, message_id TEXT NOT NULL, emoji TEXT NOT NULL DEFAULT 'like', created_at TEXT DEFAULT (datetime('now')), UNIQUE(user_id, message_id))`);

// ── Reputation votes (one vote per voter per target, can be +1 or -1) ──
db.prepare(`CREATE TABLE IF NOT EXISTS reputation_votes (
  id         TEXT PRIMARY KEY,
  voter_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  value      INTEGER NOT NULL CHECK(value IN (1, -1)),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(voter_id, target_id)
)`).run();

// ── User reports (anonymous reports against a user) ─────────────────
db.prepare(`CREATE TABLE IF NOT EXISTS user_reports (
  id          TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason      TEXT NOT NULL,
  details     TEXT DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','reviewed','dismissed')),
  admin_note  TEXT DEFAULT '',
  created_at  TEXT DEFAULT (datetime('now')),
  reviewed_at TEXT
)`).run();

// ══════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ── OTP CLEANUP (every 5 minutes) ─────────────────────
setInterval(() => {
  db.prepare(`DELETE FROM otp_store WHERE expires_at < datetime('now')`).run();
  db.prepare(`DELETE FROM reset_store WHERE expires_at < datetime('now') AND verified = 0`).run();
}, 5 * 60 * 1000);

// ══════════════════════════════════════════════════════
// USER FUNCTIONS  (drop-in replacements for userStore.js)
// ══════════════════════════════════════════════════════

function findUserByEmail(email) {
  const row = db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(email);
  return row ? dbRowToUser(row) : undefined;
}

function findUserById(id) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return row ? dbRowToUser(row) : undefined;
}

function findUserByUsername(username) {
  const row = db.prepare('SELECT * FROM users WHERE lower(username) = lower(?)').get(username);
  return row ? dbRowToUser(row) : undefined;
}

function findUserByPhone(phone) {
  // Normalize any input format → +63XXXXXXXXXX (the canonical storage format)
  const digits = String(phone).replace(/\D/g, '');
  let ten;
  if      (digits.length === 10 && digits[0] === '9')  ten = digits;
  else if (digits.length === 11 && digits[0] === '0')  ten = digits.slice(1);
  else if (digits.length === 12 && digits.startsWith('63')) ten = digits.slice(2);
  else ten = digits; // pass through for unusual formats
  const normalized = '+63' + ten;

  // Direct indexed lookup — phones are stored as +63XXXXXXXXXX
  const row = db.prepare('SELECT * FROM users WHERE phone = ?').get(normalized);
  return row ? dbRowToUser(row) : undefined;
}

function createUser(userData) {
  const id = userData.id || genId();
  // account_status: explicitly pass 'approved' for admin accounts; defaults to 'pending' for normal users
  const accountStatus = userData.accountStatus || 'pending';
  db.prepare(`
    INSERT INTO users (id, google_id, email, password, first_name, middle_name, last_name,
      suffix, username, birthday, sex, civil_status, phone, bio, location,
      present_address, permanent_address, school_name, course, year_level, school_address,
      father_info, mother_info, monthly_income, specialization,
      avatar, avatar_face_x, avatar_face_y, email_verified, id_verified, auth_provider, role, account_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    userData.googleId || null,
    userData.email,
    userData.password || null,
    userData.firstName,
    userData.middleName || '',
    userData.lastName,
    userData.suffix || '',
    userData.username,
    userData.birthday || null,
    userData.sex || null,
    userData.civilStatus || '',
    userData.phone || null,
    userData.bio || '',
    userData.location || '',
    userData.presentAddress || '',
    userData.permanentAddress || '',
    userData.schoolName || '',
    userData.course || '',
    userData.yearLevel || '',
    userData.schoolAddress || '',
    userData.fatherInfo || '',
    userData.motherInfo || '',
    userData.monthlyIncome || '',
    userData.specialization || '',
    userData.avatar || '',
    userData.avatarFaceX ?? 50,
    userData.avatarFaceY ?? 50,
    userData.emailVerified ? 1 : 0,
    userData.idVerified ? 1 : 0,
    userData.authProvider || 'local',
    userData.role || 'user',
    accountStatus
  );
  return findUserById(id);
}

function updateUser(id, fields) {
  const allowed = ['first_name','last_name','middle_name','suffix','username','bio',
                   'location','avatar','cover_photo','password','id_verified','is_active'];
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    const col = camelToSnake(k);
    if (allowed.includes(col)) { sets.push(`${col} = ?`); vals.push(v); }
  }
  if (!sets.length) return;
  sets.push(`updated_at = datetime('now')`);
  vals.push(id);
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

function camelToSnake(str) {
  return str.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
}

// Convert DB snake_case row → camelCase user object (same shape as old userStore)
function dbRowToUser(row) {
  return {
    id:            row.id,
    googleId:      row.google_id,
    email:         row.email,
    password:      row.password,
    firstName:     row.first_name,
    middleName:    row.middle_name,
    lastName:      row.last_name,
    suffix:        row.suffix,
    username:      row.username,
    birthday:      row.birthday,
    sex:           row.sex,
    phone:         row.phone,
    bio:           row.bio,
    location:      row.location,
    avatar:        row.avatar,
    coverPhoto:    row.cover_photo,
    emailVerified: !!row.email_verified,
    idVerified:    !!row.id_verified,
    authProvider:  row.auth_provider,
    role:          row.role,
    isActive:      !!row.is_active,
    accountStatus: row.account_status || 'approved',
    createdAt:     toUTC(row.created_at),
    // ── Registration fields ──
    civilStatus:      row.civil_status      || '',
    presentAddress:   row.present_address   || '',
    permanentAddress: row.permanent_address || '',
    schoolName:       row.school_name       || '',
    course:           row.course            || '',
    yearLevel:        row.year_level        || '',
    schoolAddress:    row.school_address    || '',
    fatherInfo:       row.father_info       || '',
    motherInfo:       row.mother_info       || '',
    monthlyIncome:    row.monthly_income    || '',
    avatarFaceX:      row.avatar_face_x     ?? 50,
    avatarFaceY:      row.avatar_face_y     ?? 50,
    specialization:   row.specialization    || '',
  };
}

// ── Compatibility: passport needs a plain users array for deserializeUser
// We replace this with a findUserById call in passport-setup.js
const users = { push: (u) => createUser(u) };

// ══════════════════════════════════════════════════════
// OTP FUNCTIONS
// ══════════════════════════════════════════════════════

function saveOTP(email, otp, firstName) {
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO otp_store (email, otp, first_name, expires_at, attempts)
    VALUES (lower(?), ?, ?, ?, 0)
    ON CONFLICT(email) DO UPDATE SET otp=excluded.otp, first_name=excluded.first_name,
      expires_at=excluded.expires_at, attempts=0
  `).run(email.trim(), otp, firstName || 'there', expiresAt);
}

function verifyOTP(email, enteredOtp) {
  const record = db.prepare('SELECT * FROM otp_store WHERE email = lower(?)').get(email.trim());
  if (!record) return { valid: false, reason: 'No verification code found. Please request a new one.' };
  if (new Date() > new Date(record.expires_at)) {
    db.prepare('DELETE FROM otp_store WHERE email = lower(?)').run(email.trim());
    return { valid: false, reason: 'Your code has expired. Please request a new one.' };
  }
  if (record.attempts >= 5) return { valid: false, reason: 'Too many wrong attempts. Please request a new code.' };
  if (record.otp !== enteredOtp) {
    db.prepare('UPDATE otp_store SET attempts = attempts + 1 WHERE email = lower(?)').run(email.trim());
    const left = 5 - (record.attempts + 1);
    return { valid: false, reason: `Incorrect code. ${left} attempt${left !== 1 ? 's' : ''} remaining.` };
  }
  db.prepare('DELETE FROM otp_store WHERE email = lower(?)').run(email.trim());
  return { valid: true };
}

// ── Password Reset OTP ─────────────────────────────────
function saveResetOTP(email, otp) {
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO reset_store (email, otp, expires_at, attempts, verified)
    VALUES (lower(?), ?, ?, 0, 0)
    ON CONFLICT(email) DO UPDATE SET otp=excluded.otp, expires_at=excluded.expires_at, attempts=0, verified=0
  `).run(email.trim(), otp, expiresAt);
}

function verifyResetOTP(email, enteredOtp) {
  const record = db.prepare('SELECT * FROM reset_store WHERE email = lower(?)').get(email.trim());
  if (!record) return { valid: false, reason: 'No reset code found. Please request a new one.' };
  if (new Date() > new Date(record.expires_at)) {
    db.prepare('DELETE FROM reset_store WHERE email = lower(?)').run(email.trim());
    return { valid: false, reason: 'Reset code has expired. Please request a new one.' };
  }
  if (record.attempts >= 5) return { valid: false, reason: 'Too many attempts. Please request a new code.' };
  if (record.otp !== enteredOtp) {
    db.prepare('UPDATE reset_store SET attempts = attempts + 1 WHERE email = lower(?)').run(email.trim());
    const left = 5 - (record.attempts + 1);
    return { valid: false, reason: `Incorrect code. ${left} attempt${left !== 1 ? 's' : ''} remaining.` };
  }
  db.prepare('UPDATE reset_store SET verified = 1 WHERE email = lower(?)').run(email.trim());
  return { valid: true };
}

function consumeResetOTP(email) {
  const record = db.prepare('SELECT * FROM reset_store WHERE email = lower(?) AND verified = 1').get(email.trim());
  if (!record) return false;
  db.prepare('DELETE FROM reset_store WHERE email = lower(?)').run(email.trim());
  return true;
}

// ── Login Attempt Tracking ────────────────────────────
const LOGIN_MAX  = 5;
const LOGIN_LOCK = 15 * 60 * 1000;

function recordFailedLogin(email) {
  const key = email.toLowerCase();
  const now = Date.now();
  const rec = db.prepare('SELECT * FROM login_attempts WHERE email = ?').get(key);
  if (!rec) {
    db.prepare('INSERT INTO login_attempts (email, count, locked_until) VALUES (?,1,NULL)').run(key);
    return;
  }
  // Expired lock → reset
  if (rec.locked_until && now > new Date(rec.locked_until).getTime()) {
    db.prepare('UPDATE login_attempts SET count=1, locked_until=NULL WHERE email=?').run(key);
    return;
  }
  const newCount = rec.count + 1;
  const locked   = newCount >= LOGIN_MAX ? new Date(now + LOGIN_LOCK).toISOString() : null;
  db.prepare('UPDATE login_attempts SET count=?, locked_until=? WHERE email=?').run(newCount, locked, key);
}

function checkLoginLock(email) {
  const key = email.toLowerCase();
  const rec = db.prepare('SELECT * FROM login_attempts WHERE email = ?').get(key);
  if (!rec) return { locked: false };
  const now = Date.now();
  if (rec.locked_until && now < new Date(rec.locked_until).getTime()) {
    const minsLeft = Math.ceil((new Date(rec.locked_until).getTime() - now) / 60000);
    return { locked: true, minsLeft };
  }
  if (rec.locked_until) db.prepare('UPDATE login_attempts SET count=0, locked_until=NULL WHERE email=?').run(key);
  return { locked: false, attemptsLeft: Math.max(0, LOGIN_MAX - (rec.count || 0)) };
}

function clearLoginAttempts(email) {
  db.prepare('DELETE FROM login_attempts WHERE email = ?').run(email.toLowerCase());
}

// ══════════════════════════════════════════════════════
// POSTS
// ══════════════════════════════════════════════════════

function createPost({ userId, content, imageUrl = '', privacy = 'public', status = null }) {
  const id = genId();
  // If status not explicitly set, check user role — admins bypass moderation
  let postStatus = status;
  if (!postStatus) {
    const user = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
    postStatus = (user?.role === 'admin' || user?.role === 'superadmin') ? 'approved' : 'pending';
  }
  db.prepare(`
    INSERT INTO posts (id, user_id, content, image_url, privacy, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, userId, content, imageUrl, privacy, postStatus);
  return getPostById(id, userId);
}

function getPostById(postId, viewerId = null) {
  const row = db.prepare(`
    SELECT p.*,
      u.first_name, u.middle_name, u.last_name, u.suffix, u.username, u.avatar,
      (SELECT COUNT(*) FROM likes WHERE target_id = p.id AND target_type = 'post') AS like_count,
      (SELECT COUNT(*) FROM comments WHERE post_id = p.id) AS comment_count,
      ${viewerId ? `(SELECT COUNT(*) FROM likes WHERE target_id = p.id AND target_type='post' AND user_id=?) AS viewer_liked` : '0 AS viewer_liked'}
    FROM posts p JOIN users u ON p.user_id = u.id
    WHERE p.id = ?
  `).get(...(viewerId ? [viewerId, postId] : [postId]));
  return row ? formatPost(row) : null;
}

function getFeedPosts({ viewerId, page = 1, limit = 10 }) {
  const offset = (page - 1) * limit;
  // Show posts from people viewer follows + their own posts
  const rows = db.prepare(`
    SELECT p.*,
      u.first_name, u.last_name, u.username, u.avatar,
      (SELECT COUNT(*) FROM likes WHERE target_id = p.id AND target_type = 'post') AS like_count,
      (SELECT COUNT(*) FROM comments WHERE post_id = p.id) AS comment_count,
      (SELECT COUNT(*) FROM likes WHERE target_id = p.id AND target_type='post' AND user_id=?) AS viewer_liked
    FROM posts p
    JOIN users u ON p.user_id = u.id
    WHERE (p.user_id = ?
       OR p.user_id IN (SELECT following_id FROM follows WHERE follower_id = ?))
      AND (p.status = 'approved' OR p.status IS NULL)
    ORDER BY p.created_at DESC
    LIMIT ? OFFSET ?
  `).all(viewerId, viewerId, viewerId, limit, offset);
  return rows.map(formatPost);
}

function getPublicPosts({ viewerId = null, page = 1, limit = 10 }) {
  const offset = (page - 1) * limit;
  const rows = db.prepare(`
    SELECT p.*,
      u.first_name, u.last_name, u.username, u.avatar,
      (SELECT COUNT(*) FROM likes WHERE target_id = p.id AND target_type = 'post') AS like_count,
      (SELECT COUNT(*) FROM comments WHERE post_id = p.id) AS comment_count,
      ${viewerId ? `(SELECT COUNT(*) FROM likes WHERE target_id=p.id AND target_type='post' AND user_id=?) AS viewer_liked` : '0 AS viewer_liked'}
    FROM posts p JOIN users u ON p.user_id = u.id
    WHERE p.privacy = 'public' AND (p.status = 'approved' OR p.status IS NULL)
    ORDER BY p.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...(viewerId ? [viewerId, limit, offset] : [limit, offset]));
  return rows.map(formatPost);
}

function getUserPosts({ userId, viewerId = null, page = 1, limit = 10 }) {
  const offset = (page - 1) * limit;
  // Show all post statuses to the author; only approved to others
  const isOwner = viewerId === userId;
  const statusFilter = isOwner ? '' : `AND (p.status = 'approved' OR p.status IS NULL)`;
  const rows = db.prepare(`
    SELECT p.*,
      u.first_name, u.last_name, u.username, u.avatar,
      (SELECT COUNT(*) FROM likes WHERE target_id = p.id AND target_type = 'post') AS like_count,
      (SELECT COUNT(*) FROM comments WHERE post_id = p.id) AS comment_count,
      ${viewerId ? `(SELECT COUNT(*) FROM likes WHERE target_id=p.id AND target_type='post' AND user_id=?) AS viewer_liked` : '0 AS viewer_liked'}
    FROM posts p JOIN users u ON p.user_id = u.id
    WHERE p.user_id = ? ${statusFilter}
    ORDER BY p.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...(viewerId ? [viewerId, userId, limit, offset] : [userId, limit, offset]));
  return rows.map(formatPost);
}

function updatePost(postId, userId, { content, privacy }) {
  db.prepare(`UPDATE posts SET content=?, privacy=?, updated_at=datetime('now') WHERE id=? AND user_id=?`)
    .run(content, privacy, postId, userId);
  return getPostById(postId, userId);
}

function deletePost(postId, userId) {
  const info = db.prepare('DELETE FROM posts WHERE id=? AND user_id=?').run(postId, userId);
  return info.changes > 0;
}

function formatPost(row) {
  return {
    id:           row.id,
    userId:       row.user_id,
    content:      row.content,
    imageUrl:     row.image_url,
    privacy:      row.privacy,
    status:       row.status || 'approved',
    moderatedBy:  row.moderated_by || null,
    aiReviewedAt: row.ai_reviewed_at || null,
    createdAt:    toUTC(row.created_at),
    updatedAt:    row.updated_at,
    likeCount:    row.like_count,
    commentCount: row.comment_count,
    viewerLiked:  !!row.viewer_liked,
    author: {
      firstName:  row.first_name,
      middleName: row.middle_name || '',
      lastName:   row.last_name,
      suffix:     row.suffix || '',
      username:   row.username,
      avatar:     row.avatar,
    }
  };
}

// ══════════════════════════════════════════════════════
// LIKES
// ══════════════════════════════════════════════════════

function toggleLike(userId, targetId, targetType = 'post') {
  const existing = db.prepare('SELECT id FROM likes WHERE user_id=? AND target_id=? AND target_type=?')
    .get(userId, targetId, targetType);
  if (existing) {
    db.prepare('DELETE FROM likes WHERE user_id=? AND target_id=? AND target_type=?')
      .run(userId, targetId, targetType);
    const count = db.prepare('SELECT COUNT(*) as c FROM likes WHERE target_id=? AND target_type=?')
      .get(targetId, targetType).c;
    return { liked: false, count };
  } else {
    db.prepare('INSERT INTO likes (id, user_id, target_id, target_type) VALUES (?,?,?,?)')
      .run(genId(), userId, targetId, targetType);
    const count = db.prepare('SELECT COUNT(*) as c FROM likes WHERE target_id=? AND target_type=?')
      .get(targetId, targetType).c;
    return { liked: true, count };
  }
}

// ══════════════════════════════════════════════════════
// COMMENTS
// ══════════════════════════════════════════════════════

function addComment(postId, userId, content, parentId = null) {
  const id = genId();
  db.prepare('INSERT INTO comments (id, post_id, user_id, content, parent_id) VALUES (?,?,?,?,?)').run(id, postId, userId, content, parentId || null);
  return getCommentById(id);
}

function getCommentById(id) {
  return db.prepare(`
    SELECT c.*, u.first_name, u.middle_name, u.last_name, u.suffix, u.username, u.avatar
    FROM comments c JOIN users u ON c.user_id = u.id
    WHERE c.id = ?
  `).get(id);
}

function getComments(postId) {
  const rows = db.prepare(`
    SELECT c.*, u.first_name, u.middle_name, u.last_name, u.suffix, u.username, u.avatar
    FROM comments c JOIN users u ON c.user_id = u.id
    WHERE c.post_id = ? ORDER BY c.created_at ASC
  `).all(postId);
  // Build tree: top-level first, then nest replies
  const byId = {};
  const roots = [];
  for (const r of rows) {
    r.replies = [];
    byId[r.id] = r;
  }
  for (const r of rows) {
    if (r.parent_id && byId[r.parent_id]) {
      byId[r.parent_id].replies.push(r);
    } else {
      roots.push(r);
    }
  }
  return roots;
}

function deleteComment(commentId, userId) {
  const info = db.prepare('DELETE FROM comments WHERE id=? AND user_id=?').run(commentId, userId);
  return info.changes > 0;
}

// ══════════════════════════════════════════════════════
// FOLLOWS
// ══════════════════════════════════════════════════════

function toggleFollow(followerId, followingId) {
  const existing = db.prepare('SELECT id FROM follows WHERE follower_id=? AND following_id=?')
    .get(followerId, followingId);
  if (existing) {
    db.prepare('DELETE FROM follows WHERE follower_id=? AND following_id=?').run(followerId, followingId);
    return { following: false };
  } else {
    db.prepare('INSERT INTO follows (id, follower_id, following_id) VALUES (?,?,?)').run(genId(), followerId, followingId);
    return { following: true };
  }
}

function isFollowing(followerId, followingId) {
  return !!db.prepare('SELECT 1 FROM follows WHERE follower_id=? AND following_id=?').get(followerId, followingId);
}

function getFollowerCount(userId) {
  return db.prepare('SELECT COUNT(*) as c FROM follows WHERE following_id=?').get(userId).c;
}

function getFollowingCount(userId) {
  return db.prepare('SELECT COUNT(*) as c FROM follows WHERE follower_id=?').get(userId).c;
}

function getSuggestedUsers(viewerId, limit = 5) {
  const users = db.prepare(`
    SELECT u.id, u.first_name, u.last_name, u.username, u.avatar, u.bio,
      (SELECT COUNT(*) FROM follows WHERE following_id = u.id) AS follower_count
    FROM users u
    WHERE u.id != ?
      AND u.is_active = 1
      AND u.account_status = 'approved'
      AND u.role != 'admin'
    ORDER BY follower_count DESC, u.created_at DESC
    LIMIT ?
  `).all(viewerId, limit * 3); // fetch more so we can filter

  // Annotate each with friendship status
  return users.map(u => ({
    ...u,
    friendshipStatus: getFriendshipStatus(viewerId, u.id),
    areFriends: areFriends(viewerId, u.id),
  })).filter(u => !u.areFriends).slice(0, limit);
}

// ══════════════════════════════════════════════════════
// NOTIFICATIONS
// ══════════════════════════════════════════════════════

function createNotification({ userId, type, actorId, targetId, message }) {
  if (userId === actorId && actorId != null) return; // skip self-notifications except system (null)
  // Dedup: for friend_request, don't create if one already exists from same actor
  if (type === 'friend_request' && actorId) {
    const existing = db.prepare("SELECT id FROM notifications WHERE user_id=? AND type='friend_request' AND actor_id=? AND is_read=0").get(userId, actorId);
    if (existing) return; // already has an unread friend_request notification
  }
  const id = genId();
  db.prepare('INSERT INTO notifications (id, user_id, type, actor_id, target_id, message) VALUES (?,?,?,?,?,?)')
    .run(id, userId, type, actorId, targetId || null, message || null);
}

function getNotifications(userId, limit = 30) {
  return db.prepare(`
    SELECT n.*, u.first_name, u.middle_name, u.last_name, u.suffix, u.username, u.avatar
    FROM notifications n
    LEFT JOIN users u ON n.actor_id = u.id
    WHERE n.user_id = ?
    ORDER BY n.created_at DESC
    LIMIT ?
  `).all(userId, limit);
}

function getUnreadCount(userId) {
  return db.prepare('SELECT COUNT(*) as c FROM notifications WHERE user_id=? AND is_read=0').get(userId).c;
}

function markAllRead(userId) {
  db.prepare('UPDATE notifications SET is_read=1 WHERE user_id=?').run(userId);
}

function markOneRead(notifId, userId) {
  db.prepare('UPDATE notifications SET is_read=1 WHERE id=? AND user_id=?').run(notifId, userId);
}

// ══════════════════════════════════════════════════════
// SEARCH
// ══════════════════════════════════════════════════════

function searchUsers(query, viewerId = null, limit = 20) {
  const q = `%${query}%`;
  const users = db.prepare(`
    SELECT u.id, u.first_name, u.last_name, u.username, u.avatar, u.bio,
      (SELECT COUNT(*) FROM follows WHERE following_id = u.id) AS follower_count
    FROM users u
    WHERE u.is_active = 1
      AND u.account_status = 'approved'
      AND u.role != 'admin'
      AND (lower(u.first_name) LIKE lower(?) OR lower(u.last_name) LIKE lower(?)
           OR lower(u.username) LIKE lower(?) OR lower(u.email) LIKE lower(?))
    ORDER BY follower_count DESC
    LIMIT ?
  `).all(q, q, q, q, limit);
  if (!viewerId) return users;
  return users.map(u => ({
    ...u,
    friendshipStatus: getFriendshipStatus(viewerId, u.id),
    areFriends: areFriends(viewerId, u.id),
    is_following: !!db.prepare('SELECT 1 FROM follows WHERE follower_id=? AND following_id=?').get(viewerId, u.id),
  }));
}

// ── Rejected Registrations Archive ───────────────────
function archiveRejectedRegistration({ user, idDocs, reason, rejectedBy }) {
  const id = genId();
  db.prepare(`
    INSERT INTO rejected_registrations
      (id, user_id, first_name, middle_name, last_name, suffix, username, email, phone,
       birthday, sex, bio, location, avatar, auth_provider,
       civil_status, present_address, permanent_address,
       school_name, school_address, year_level, course, specialization,
       father_info, mother_info, monthly_income,
       id_front_url, id_back_url, selfie_url, id_type,
       cert_residency_url, cert_low_income_url, cert_enrollment_url,
       rejection_reason, rejected_by, original_created_at, password_hash,
       avatar_face_x, avatar_face_y)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, user.id, user.firstName, user.middleName||'', user.lastName, user.suffix||'',
    user.username, user.email, user.phone||'', user.birthday||'', user.sex||'',
    user.bio||'', user.location||'', user.avatar||'', user.authProvider||'local',
    // ── Full registration fields ──
    user.civilStatus||'', user.presentAddress||'', user.permanentAddress||'',
    user.schoolName||'', user.schoolAddress||'', user.yearLevel||'', user.course||'', user.specialization||'',
    user.fatherInfo||'', user.motherInfo||'', user.monthlyIncome||'',
    // ── Documents ──
    idDocs?.id_front_url||'', idDocs?.id_back_url||'', idDocs?.selfie_url||'', idDocs?.id_type||'',
    idDocs?.cert_residency_url||'', idDocs?.cert_low_income_url||'', idDocs?.cert_enrollment_url||'',
    reason||'', rejectedBy, user.createdAt||'',
    user.password||null,
    user.avatarFaceX ?? 50, user.avatarFaceY ?? 50
  );
  return id;
}

function getRejectedRegistrations() {
  return db.prepare(`
    SELECT r.*, a.username as admin_username
    FROM rejected_registrations r
    LEFT JOIN users a ON r.rejected_by = a.id
    ORDER BY r.rejected_at DESC
  `).all();
}

function deleteRejectedRegistration(id) {
  db.prepare('DELETE FROM rejected_registrations WHERE id = ?').run(id);
}

// ── Full user profile for admin review ────────────────
function getFullUserProfile(userId) {
  const row = db.prepare(`
    SELECT u.*,
      ivr.id as verif_id, ivr.id_front_url, ivr.id_back_url, ivr.selfie_url, ivr.id_type,
      ivr.status as verif_status, ivr.created_at as verif_submitted_at,
      ivr.cert_residency_url, ivr.cert_low_income_url, ivr.cert_enrollment_url
    FROM users u
    LEFT JOIN id_verification_requests ivr ON ivr.user_id = u.id
      AND ivr.id = (SELECT id FROM id_verification_requests WHERE user_id = u.id ORDER BY created_at DESC LIMIT 1)
    WHERE u.id = ?
  `).get(userId);
  if (!row) return null;
  return {
    ...dbRowToUser(row),
    verifId:           row.verif_id            || null,
    idFrontUrl:        row.id_front_url         || '',
    idBackUrl:         row.id_back_url          || '',
    selfieUrl:         row.selfie_url           || '',
    idType:            row.id_type              || '',
    verifStatus:       row.verif_status         || null,
    verifSubmittedAt:  row.verif_submitted_at   || null,
    certResidencyUrl:  row.cert_residency_url   || '',
    certLowIncomeUrl:  row.cert_low_income_url  || '',
    certEnrollmentUrl: row.cert_enrollment_url  || '',
  };
}

// ── AI Moderation Log ────────────────────────────────────────────────
function logAiModerationAction({ postId, postContent, authorUsername, verdict, score, flags, summary, actionTaken }) {
  db.prepare(`
    INSERT INTO ai_moderation_log
      (id, post_id, post_content, author_username, verdict, score, flags, summary, action_taken)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(
    genId(), postId,
    (postContent || '').slice(0, 300),
    authorUsername || '',
    verdict || 'review',
    score !== undefined && score !== null ? score : null,
    Array.isArray(flags) ? flags.join(',') : (flags || ''),
    (summary || '').slice(0, 500),
    actionTaken || 'none'
  );
}

function getAiModerationLog({ limit = 100 } = {}) {
  return db.prepare(`
    SELECT * FROM ai_moderation_log ORDER BY created_at DESC LIMIT ?
  `).all(limit);
}

// ══════════════════════════════════════════════════════
// FRIENDSHIPS (Facebook-style mutual friends)
// ══════════════════════════════════════════════════════
function _friendKey(a, b) { return [a, b].sort(); }

function sendFriendRequest(fromId, toId) {
  const [a, b] = _friendKey(fromId, toId);
  const existing = db.prepare('SELECT * FROM friendships WHERE user_a=? AND user_b=?').get(a, b);
  if (existing) {
    // If declined, allow re-sending
    if (existing.status === 'declined') {
      db.prepare("UPDATE friendships SET status='pending', requester=? WHERE user_a=? AND user_b=?").run(fromId, a, b);
      return { status: 'pending', existing: false };
    }
    return { status: existing.status, existing: true };
  }
  db.prepare('INSERT INTO friendships (id,user_a,user_b,status,requester) VALUES (?,?,?,?,?)').run(genId(),a,b,'pending',fromId);
  return { status: 'pending' };
}

function acceptFriendRequest(fromId, toId) {
  const [a, b] = _friendKey(fromId, toId);
  db.prepare("UPDATE friendships SET status='friends' WHERE user_a=? AND user_b=?").run(a, b);
  // Also create follow both ways
  const ensureFollow = (fId, tId) => {
    if (!db.prepare('SELECT 1 FROM follows WHERE follower_id=? AND following_id=?').get(fId,tId))
      db.prepare('INSERT INTO follows (id,follower_id,following_id) VALUES (?,?,?)').run(genId(),fId,tId);
  };
  ensureFollow(fromId, toId); ensureFollow(toId, fromId);
}

function declineFriendRequest(fromId, toId) {
  const [a, b] = _friendKey(fromId, toId);
  db.prepare('DELETE FROM friendships WHERE user_a=? AND user_b=?').run(a, b);
}

function removeFriend(userId, otherId) {
  const [a, b] = _friendKey(userId, otherId);
  db.prepare('DELETE FROM friendships WHERE user_a=? AND user_b=?').run(a, b);
  db.prepare('DELETE FROM follows WHERE (follower_id=? AND following_id=?) OR (follower_id=? AND following_id=?)').run(userId,otherId,otherId,userId);
}

function getFriendshipStatus(userA, userB) {
  const [a, b] = _friendKey(userA, userB);
  const row = db.prepare('SELECT status, requester FROM friendships WHERE user_a=? AND user_b=?').get(a, b);
  if (!row) return null;
  return { status: row.status, iRequested: row.requester === userA };
}

function areFriends(userA, userB) {
  const [a, b] = _friendKey(userA, userB);
  return !!db.prepare("SELECT 1 FROM friendships WHERE user_a=? AND user_b=? AND status='friends'").get(a, b);
}

function getPendingFriendRequests(userId) {
  // Incoming requests (someone sent to me)
  const incoming = db.prepare(`
    SELECT f.*, u.first_name, u.last_name, u.username, u.avatar, 'incoming' as direction
    FROM friendships f JOIN users u ON f.requester = u.id
    WHERE (f.user_a=? OR f.user_b=?) AND f.requester!=? AND f.status='pending'
    ORDER BY f.created_at DESC
  `).all(userId, userId, userId);
  // Deduplicate by requester id
  const seen = new Set();
  return incoming.filter(r => { if (seen.has(r.requester)) return false; seen.add(r.requester); return true; });
}

function getOutgoingFriendRequests(userId) {
  return db.prepare(`
    SELECT f.*, u.first_name, u.last_name, u.username, u.avatar
    FROM friendships f JOIN users u ON (CASE WHEN f.user_a=? THEN f.user_b ELSE f.user_a END) = u.id
    WHERE (f.user_a=? OR f.user_b=?) AND f.requester=? AND f.status='pending'
    ORDER BY f.created_at DESC
  `).all(userId, userId, userId, userId);
}

function getFriendCount(userId) {
  return db.prepare("SELECT COUNT(*) as c FROM friendships WHERE (user_a=? OR user_b=?) AND status='friends'").get(userId,userId).c;
}

// ══════════════════════════════════════════════════════
// MESSAGE REACTIONS
// ══════════════════════════════════════════════════════
function toggleMsgReaction(userId, messageId, emoji) {
  if (!['like','love','haha','wow','sad','angry'].includes(emoji)) emoji = 'like';
  const existing = db.prepare('SELECT * FROM message_reactions WHERE user_id=? AND message_id=?').get(userId, messageId);
  if (existing) {
    if (existing.emoji === emoji) {
      db.prepare('DELETE FROM message_reactions WHERE user_id=? AND message_id=?').run(userId, messageId);
      return { reacted: false, emoji: null };
    }
    db.prepare("UPDATE message_reactions SET emoji=? WHERE user_id=? AND message_id=?").run(emoji, userId, messageId);
    return { reacted: true, emoji, changed: true };
  }
  db.prepare('INSERT INTO message_reactions (id,user_id,message_id,emoji) VALUES (?,?,?,?)').run(genId(),userId,messageId,emoji);
  return { reacted: true, emoji };
}

function getMsgReactions(messageId) {
  return db.prepare('SELECT emoji, COUNT(*) as count FROM message_reactions WHERE message_id=? GROUP BY emoji').all(messageId);
}

function getUserMsgReaction(userId, messageId) {
  const r = db.prepare('SELECT emoji FROM message_reactions WHERE user_id=? AND message_id=?').get(userId, messageId);
  return r ? r.emoji : null;
}

// ══════════════════════════════════════════════════════
// REACTIONS (post / comment / message)
// ══════════════════════════════════════════════════════
const VALID_EMOJIS = new Set(['like','love','haha','wow','sad','angry']);

function toggleReaction(userId, targetId, targetType, emoji) {
  if (!VALID_EMOJIS.has(emoji)) emoji = 'like';
  const existing = db.prepare('SELECT * FROM reactions WHERE user_id=? AND target_id=? AND target_type=?').get(userId, targetId, targetType);
  if (existing) {
    if (existing.emoji === emoji) {
      // Same emoji — remove reaction
      db.prepare('DELETE FROM reactions WHERE user_id=? AND target_id=? AND target_type=?').run(userId, targetId, targetType);
      return { reacted: false, emoji: null };
    } else {
      // Different emoji — update
      db.prepare("UPDATE reactions SET emoji=?, created_at=datetime('now') WHERE user_id=? AND target_id=? AND target_type=?").run(emoji, userId, targetId, targetType);
      return { reacted: true, emoji, changed: true };
    }
  }
  db.prepare('INSERT INTO reactions (id, user_id, target_id, target_type, emoji) VALUES (?,?,?,?,?)').run(genId(), userId, targetId, targetType, emoji);
  return { reacted: true, emoji };
}

function getReactions(targetId, targetType) {
  const rows = db.prepare('SELECT emoji, COUNT(*) as count FROM reactions WHERE target_id=? AND target_type=? GROUP BY emoji').all(targetId, targetType);
  const totals = { like:0, love:0, haha:0, wow:0, sad:0, angry:0 };
  for (const r of rows) totals[r.emoji] = (totals[r.emoji]||0) + r.count;
  return totals;
}

function getUserReaction(userId, targetId, targetType) {
  const r = db.prepare('SELECT emoji FROM reactions WHERE user_id=? AND target_id=? AND target_type=?').get(userId, targetId, targetType);
  return r ? r.emoji : null;
}

function getBulkReactions(targetIds, targetType, viewerId = null) {
  if (!targetIds.length) return {};
  const placeholders = targetIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT target_id, emoji, COUNT(*) as count FROM reactions WHERE target_id IN (${placeholders}) AND target_type=? GROUP BY target_id, emoji`).all(...targetIds, targetType);
  const result = {};
  for (const id of targetIds) result[id] = { like:0, love:0, haha:0, wow:0, sad:0, angry:0, total:0, userReaction:null };
  for (const r of rows) {
    if (result[r.target_id]) { result[r.target_id][r.emoji] = r.count; result[r.target_id].total += r.count; }
  }
  if (viewerId) {
    const vRows = db.prepare(`SELECT target_id, emoji FROM reactions WHERE user_id=? AND target_id IN (${placeholders}) AND target_type=?`).all(viewerId, ...targetIds, targetType);
    for (const r of vRows) { if (result[r.target_id]) result[r.target_id].userReaction = r.emoji; }
  }
  return result;
}

// ══════════════════════════════════════════════════════
// FOLLOW REQUESTS
// ══════════════════════════════════════════════════════
function sendFollowRequest(fromId, toId) {
  const existing = db.prepare('SELECT * FROM follow_requests WHERE from_id=? AND to_id=?').get(fromId, toId);
  if (existing) return { status: existing.status, existing: true };
  const alreadyFollowing = db.prepare('SELECT 1 FROM follows WHERE follower_id=? AND following_id=?').get(fromId, toId);
  if (alreadyFollowing) return { status: 'following', existing: true };
  db.prepare('INSERT OR REPLACE INTO follow_requests (id, from_id, to_id, status) VALUES (?,?,?,?)').run(genId(), fromId, toId, 'pending');
  return { status: 'pending' };
}

function acceptFollowRequest(fromId, toId) {
  db.prepare('UPDATE follow_requests SET status=? WHERE from_id=? AND to_id=?').run('accepted', fromId, toId);
  // Create the actual follow
  const existingFollow = db.prepare('SELECT 1 FROM follows WHERE follower_id=? AND following_id=?').get(fromId, toId);
  if (!existingFollow) db.prepare('INSERT INTO follows (id, follower_id, following_id) VALUES (?,?,?)').run(genId(), fromId, toId);
}

function declineFollowRequest(fromId, toId) {
  db.prepare('UPDATE follow_requests SET status=? WHERE from_id=? AND to_id=?').run('declined', fromId, toId);
}

function cancelFollowRequest(fromId, toId) {
  db.prepare('DELETE FROM follow_requests WHERE from_id=? AND to_id=?').run(fromId, toId);
}

function getPendingFollowRequests(userId) {
  return db.prepare(`
    SELECT fr.*, u.first_name, u.last_name, u.username, u.avatar
    FROM follow_requests fr
    JOIN users u ON fr.from_id = u.id
    WHERE fr.to_id = ? AND fr.status = 'pending'
    ORDER BY fr.created_at DESC
  `).all(userId);
}

function getReactors(targetId, targetType) {
  return db.prepare(`
    SELECT r.emoji, r.user_id, u.first_name, u.last_name, u.username, u.avatar
    FROM reactions r JOIN users u ON r.user_id = u.id
    WHERE r.target_id=? AND r.target_type=?
    ORDER BY r.created_at DESC
  `).all(targetId, targetType);
}

function getFollowRequestStatus(fromId, toId) {
  const r = db.prepare('SELECT status FROM follow_requests WHERE from_id=? AND to_id=?').get(fromId, toId);
  return r ? r.status : null;
}

// ══════════════════════════════════════════════════════
// EXPORTS
// ══════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════
// MESSAGES (Direct Messages)
// ══════════════════════════════════════════════════════

function createMessage({ senderId, receiverId, content = '', imageUrl = '' }) {
  const id = genId();
  db.prepare('INSERT INTO messages (id, sender_id, receiver_id, content, image_url) VALUES (?,?,?,?,?)')
    .run(id, senderId, receiverId, content, imageUrl || '');
  return {
    id, senderId, receiverId,
    content,
    imageUrl: imageUrl || '',
    isRead: false,
    createdAt: new Date().toISOString(),
  };
}

function getMessages(userAId, userBId, limit = 100) {
  const msgs = db.prepare(`
    SELECT m.*, 
      su.first_name as sender_first, su.last_name as sender_last, su.avatar as sender_avatar,
      ru.first_name as recv_first,   ru.last_name as recv_last,   ru.avatar as recv_avatar
    FROM messages m
    JOIN users su ON m.sender_id   = su.id
    JOIN users ru ON m.receiver_id = ru.id
    WHERE (m.sender_id = ? AND m.receiver_id = ?)
       OR (m.sender_id = ? AND m.receiver_id = ?)
    ORDER BY m.created_at ASC
    LIMIT ?
  `).all(userAId, userBId, userBId, userAId, limit);

  // Fetch reactions for all messages in one query
  const ids = msgs.map(m => m.id);
  let reactionsMap = {};
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT message_id, emoji, COUNT(*) as count
      FROM message_reactions WHERE message_id IN (${placeholders})
      GROUP BY message_id, emoji
    `).all(...ids);
    rows.forEach(r => {
      if (!reactionsMap[r.message_id]) reactionsMap[r.message_id] = [];
      reactionsMap[r.message_id].push({ emoji: r.emoji, count: r.count });
    });
  }

  return msgs.map(r => ({
    id:         r.id,
    senderId:   r.sender_id,
    receiverId: r.receiver_id,
    content:    r.content,
    imageUrl:   r.image_url || '',
    isRead:     !!r.is_read,
    createdAt:  toUTC(r.created_at),
    reactions:  reactionsMap[r.id] || [],
  }));
}

function getConversations(userId) {
  // Correct approach: use MAX(rowid) in a subquery to get the latest message
  // per partner, then JOIN back for full row data.
  // The old GROUP BY … HAVING m.created_at = MAX(m.created_at) pattern is a
  // SQLite ambiguity anti-pattern — non-aggregated columns take an arbitrary
  // row value, not the row where created_at is maximum.
  const rows = db.prepare(`
    SELECT m.id, m.content, m.created_at, m.is_read,
           m.sender_id, m.receiver_id, latest.partner_id,
           u.first_name, u.last_name, u.username, u.avatar
    FROM (
      SELECT
        CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END AS partner_id,
        MAX(rowid) AS latest_rowid
      FROM messages
      WHERE sender_id = ? OR receiver_id = ?
      GROUP BY CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END
    ) latest
    JOIN messages m ON m.rowid = latest.latest_rowid
    JOIN users u ON u.id = latest.partner_id
    ORDER BY m.created_at DESC
  `).all(userId, userId, userId, userId);

  return rows.map(r => ({
    userId:      r.partner_id,
    firstName:   r.first_name,
    lastName:    r.last_name,
    username:    r.username,
    avatar:      r.avatar,
    lastMessage: r.content,
    lastAt:      r.created_at,
    unread:      !r.is_read && r.receiver_id === userId,
  }));
}

function markMessagesRead(fromUserId, toUserId) {
  db.prepare('UPDATE messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ?')
    .run(fromUserId, toUserId);
}

function getUnreadMessageCount(userId) {
  return db.prepare('SELECT COUNT(*) as c FROM messages WHERE receiver_id = ? AND is_read = 0').get(userId).c;
}

// ══════════════════════════════════════════════════════
// POST MODERATION
// ══════════════════════════════════════════════════════

function getPendingPosts({ page = 1, limit = 20, forBulk = false } = {}) {
  const offset = (page - 1) * limit;
  // forBulk: skip posts already reviewed by AI (to avoid re-wasting quota on borderline posts)
  const aiFilter = forBulk ? 'AND p.ai_reviewed_at IS NULL' : '';
  const rows = db.prepare(`
    SELECT p.*, u.first_name, u.last_name, u.middle_name, u.suffix, u.username, u.avatar,
      (SELECT COUNT(*) FROM likes WHERE target_id = p.id AND target_type = 'post') AS like_count,
      (SELECT COUNT(*) FROM comments WHERE post_id = p.id) AS comment_count
    FROM posts p JOIN users u ON p.user_id = u.id
    WHERE p.status = 'pending' ${aiFilter}
    ORDER BY p.created_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);
  return rows.map(formatPost);
}

function moderatePost(postId, status, adminId, source = 'admin') {
  db.prepare(`UPDATE posts SET status = ?, moderated_by = ?, ai_reviewed_at = COALESCE(ai_reviewed_at, datetime('now')), updated_at = datetime('now') WHERE id = ?`)
    .run(status, source, postId);
  logAdminAction(adminId, `post_${status}`, 'post', postId, `Post ${status} by ${source}`);
}

// Mark a post as AI-reviewed without changing its status (used when verdict=review)
function markPostAiReviewed(postId) {
  db.prepare(`UPDATE posts SET ai_reviewed_at = datetime('now') WHERE id = ? AND ai_reviewed_at IS NULL`).run(postId);
}

// ══════════════════════════════════════════════════════
// ID VERIFICATION REQUESTS
// ══════════════════════════════════════════════════════

function submitIdVerification({ userId, idFrontUrl, idBackUrl = '', selfieUrl = '', idType = 'school_id', certResidencyUrl = '', certLowIncomeUrl = '', certEnrollmentUrl = '' }) {
  // Cancel any previous pending request from this user
  db.prepare(`DELETE FROM id_verification_requests WHERE user_id = ? AND status = 'pending'`).run(userId);
  const id = genId();
  db.prepare(`
    INSERT INTO id_verification_requests (id, user_id, id_front_url, id_back_url, selfie_url, id_type, cert_residency_url, cert_low_income_url, cert_enrollment_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, idFrontUrl, idBackUrl, selfieUrl, idType, certResidencyUrl, certLowIncomeUrl, certEnrollmentUrl);
  return id;
}

function getPendingVerifications({ page = 1, limit = 20 } = {}) {
  const offset = (page - 1) * limit;
  return db.prepare(`
    SELECT v.*, u.first_name, u.last_name, u.username, u.avatar, u.email
    FROM id_verification_requests v JOIN users u ON v.user_id = u.id
    WHERE v.status = 'pending'
    ORDER BY v.created_at ASC
    LIMIT ? OFFSET ?
  `).all(limit, offset);
}

function getAllVerifications({ page = 1, limit = 20 } = {}) {
  const offset = (page - 1) * limit;
  return db.prepare(`
    SELECT v.*, u.first_name, u.last_name, u.username, u.avatar, u.email
    FROM id_verification_requests v JOIN users u ON v.user_id = u.id
    ORDER BY v.created_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);
}

function reviewVerification(verificationId, { status, adminNotes = '', aiScore = null, aiNotes = '', adminId }) {
  db.prepare(`
    UPDATE id_verification_requests
    SET status = ?, admin_notes = ?, ai_score = ?, ai_notes = ?,
        reviewed_by = ?, reviewed_at = datetime('now')
    WHERE id = ?
  `).run(status, adminNotes, aiScore, aiNotes, adminId, verificationId);
  
  if (status === 'approved') {
    const req = db.prepare(`SELECT user_id FROM id_verification_requests WHERE id = ?`).get(verificationId);
    if (req) db.prepare(`UPDATE users SET id_verified = 1, updated_at = datetime('now') WHERE id = ?`).run(req.user_id);
  }
  logAdminAction(adminId, `verification_${status}`, 'verification', verificationId, adminNotes);
}

function setVerificationAiResult(verificationId, { aiScore, aiNotes }) {
  db.prepare(`UPDATE id_verification_requests SET ai_score = ?, ai_notes = ? WHERE id = ?`)
    .run(aiScore, aiNotes, verificationId);
}

// ══════════════════════════════════════════════════════
// ADMIN LOGS
// ══════════════════════════════════════════════════════

function logAdminAction(adminId, action, targetType, targetId, details = '') {
  db.prepare(`INSERT INTO admin_logs (id, admin_id, action, target_type, target_id, details) VALUES (?,?,?,?,?,?)`)
    .run(genId(), adminId, action, targetType || null, targetId || null, details);
}

function getAdminLogs({ limit = 50 } = {}) {
  return db.prepare(`
    SELECT l.*, u.first_name, u.last_name, u.username
    FROM admin_logs l JOIN users u ON l.admin_id = u.id
    ORDER BY l.created_at DESC LIMIT ?
  `).all(limit);
}

// ══════════════════════════════════════════════════════
// ADMIN USER MANAGEMENT (extended)
// ══════════════════════════════════════════════════════

// ── Account Approval ──────────────────────────────────
function getPendingAccounts() {
  return db.prepare(`
    SELECT u.id, u.first_name, u.middle_name, u.last_name, u.suffix,
           u.username, u.email, u.phone, u.avatar,
           u.birthday, u.sex, u.civil_status, u.bio, u.location,
           u.present_address, u.permanent_address,
           u.school_name, u.course, u.year_level, u.school_address, u.specialization,
           u.father_info, u.mother_info, u.monthly_income,
           u.created_at, u.auth_provider,
           u.avatar_face_x, u.avatar_face_y,
           ivr.id as verif_id, ivr.id_front_url, ivr.id_back_url, ivr.selfie_url, ivr.id_type,
           ivr.cert_residency_url, ivr.cert_low_income_url, ivr.cert_enrollment_url
    FROM users u
    LEFT JOIN id_verification_requests ivr ON ivr.user_id = u.id
      AND ivr.id = (SELECT id FROM id_verification_requests WHERE user_id = u.id ORDER BY created_at DESC LIMIT 1)
    WHERE u.account_status = 'pending'
    ORDER BY u.created_at ASC
  `).all();
}

function approveAccount(userId) {
  db.prepare(`UPDATE users SET account_status = 'approved', updated_at = datetime('now') WHERE id = ?`).run(userId);
}

function rejectAccount(userId) {
  db.prepare(`UPDATE users SET account_status = 'rejected', updated_at = datetime('now') WHERE id = ?`).run(userId);
}

function banUser(userId, adminId) {
  db.prepare(`UPDATE users SET is_active = 0, updated_at = datetime('now') WHERE id = ?`).run(userId);
  logAdminAction(adminId, 'user_banned', 'user', userId);
}

function unbanUser(userId, adminId) {
  db.prepare(`UPDATE users SET is_active = 1, updated_at = datetime('now') WHERE id = ?`).run(userId);
  logAdminAction(adminId, 'user_unbanned', 'user', userId);
}

// ── Post Status Management ───────────────────────────────────────
function updatePostStatus(postId, status) {
  return db.prepare("UPDATE posts SET status=? WHERE id=?").run(status, postId);
}

// ── Timestamp UTC normalization ──────────────────────────────────
// SQLite datetime('now') returns "YYYY-MM-DD HH:MM:SS" without timezone.
// Appending 'Z' tells the browser it's UTC so it converts to local time correctly.
function toUTC(ts) {
  if (!ts) return ts;
  if (ts.endsWith('Z') || ts.includes('+')) return ts; // already has TZ
  return ts.replace(' ', 'T') + 'Z'; // "2026-03-22 14:14:16" → "2026-03-22T14:14:16Z"
}

// ── App Settings ─────────────────────────────────────────────────
function getSetting(key, defaultValue = null) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key=?').get(key);
  return row ? row.value : defaultValue;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO app_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
}

// ── Dormitory Management Functions ────────────────────────────────
function getDormRooms() {
  const rooms = db.prepare(`
    SELECT r.*,
      COUNT(b.id) as occupied,
      GROUP_CONCAT(b.user_id||':'||b.bed_number||':'||u.first_name||' '||u.last_name, '|') as assignments_raw
    FROM dorm_rooms r
    LEFT JOIN bed_assignments b ON b.room_id = r.id
    LEFT JOIN users u ON u.id = b.user_id
    GROUP BY r.id
    ORDER BY r.room_number
  `).all();
  return rooms.map(r => {
    const assignments = [];
    if (r.assignments_raw) {
      r.assignments_raw.split('|').forEach(a => {
        const parts = a.split(':');
        const userId = parts[0], bedNum = parts[1], name = parts.slice(2).join(':');
        if (userId) assignments.push({ userId, bedNumber: parseInt(bedNum), name });
      });
    }
    delete r.assignments_raw;
    r.assignments = assignments;
    r.available = r.capacity - r.occupied;
    return r;
  });
}

function assignBed(roomId, bedNumber, userId, assignedBy, notes) {
  return db.prepare(
    'INSERT INTO bed_assignments (id, room_id, bed_number, user_id, assigned_by, notes) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(randomUUID(), roomId, bedNumber, userId, assignedBy, notes||'');
}

function unassignBed(userId) {
  return db.prepare('DELETE FROM bed_assignments WHERE user_id = ?').run(userId);
}

const BILLING_SELECT =
  'SELECT b.*, u.first_name, u.last_name, u.email, u.username, u.avatar, ba.bed_number, dr.room_number ' +
  'FROM dorm_billing b JOIN users u ON u.id=b.user_id ' +
  'LEFT JOIN bed_assignments ba ON ba.user_id=b.user_id ' +
  'LEFT JOIN dorm_rooms dr ON dr.id=ba.room_id ';

function getDormBilling(month) {
  if (month) {
    return db.prepare(BILLING_SELECT + 'WHERE b.month=? ORDER BY dr.room_number, ba.bed_number').all(month);
  }
  return db.prepare(BILLING_SELECT + 'ORDER BY b.month DESC, dr.room_number, ba.bed_number').all();
}

function generateMonthlyBills(month, { updateExisting = false } = {}) {
  const rate = parseInt(getSetting('dorm_rate', '200'), 10) || 200;
  const assigned = db.prepare('SELECT user_id FROM bed_assignments').all();
  let created = 0, updated = 0, skipped = 0;

  const insertStmt = db.prepare(
    'INSERT OR IGNORE INTO dorm_billing (id, user_id, month, amount) VALUES (?, ?, ?, ?)'
  );
  const updateStmt = db.prepare(
    "UPDATE dorm_billing SET amount=? WHERE user_id=? AND month=? AND status='unpaid'"
  );
  const checkStmt = db.prepare(
    'SELECT id, status FROM dorm_billing WHERE user_id=? AND month=?'
  );

  for (const row of assigned) {
    const existing = checkStmt.get(row.user_id, month);
    if (!existing) {
      insertStmt.run(randomUUID(), row.user_id, month, rate);
      created++;
    } else if (updateExisting && existing.status === 'unpaid') {
      const upd = updateStmt.run(rate, row.user_id, month);
      if (upd.changes) updated++; else skipped++;
    } else {
      skipped++;
    }
  }
  return { created, updated, skipped, rate };
}

// Auto-generate a single bill for one user (called on bed assignment)
function generateBillForUser(userId, month) {
  const rate = parseInt(getSetting('dorm_rate', '200'), 10) || 200;
  const result = db.prepare(
    'INSERT OR IGNORE INTO dorm_billing (id, user_id, month, amount) VALUES (?, ?, ?, ?)'
  ).run(randomUUID(), userId, month, rate);
  return { created: result.changes > 0, rate };
}

function markBillPaid(billId) {
  return db.prepare("UPDATE dorm_billing SET status='paid', paid_at=datetime('now') WHERE id=?").run(billId);
}

function markBillUnpaid(billId) {
  return db.prepare("UPDATE dorm_billing SET status='unpaid', paid_at=NULL WHERE id=?").run(billId);
}

function waiveBill(billId) {
  return db.prepare("UPDATE dorm_billing SET status='waived' WHERE id=?").run(billId);
}

// Allow a resident to annotate their own bill (dispute note / payment claim)
function setBillComment(billId, userId, comment) {
  const MAX = 500;
  const trimmed = (comment || '').trim().slice(0, MAX);
  return db.prepare(
    'UPDATE dorm_billing SET user_comment=? WHERE id=? AND user_id=?'
  ).run(trimmed, billId, userId);
}



// ══════════════════════════════════════════════════════
// REPUTATION FUNCTIONS
// ══════════════════════════════════════════════════════

function getReputationScore(targetId) {
  const row = db.prepare('SELECT COALESCE(SUM(value),0) as score FROM reputation_votes WHERE target_id=?').get(targetId);
  return row?.score ?? 0;
}

function getMyRepVote(voterId, targetId) {
  const row = db.prepare('SELECT value FROM reputation_votes WHERE voter_id=? AND target_id=?').get(voterId, targetId);
  return row?.value ?? 0; // 0 = no vote
}

function setRepVote(voterId, targetId, value) {
  // value: 1, -1, or 0 (remove vote)
  if (value === 0) {
    db.prepare('DELETE FROM reputation_votes WHERE voter_id=? AND target_id=?').run(voterId, targetId);
    return { action: 'removed' };
  }
  const existing = db.prepare('SELECT value FROM reputation_votes WHERE voter_id=? AND target_id=?').get(voterId, targetId);
  if (existing) {
    if (existing.value === value) {
      // Same vote → toggle off
      db.prepare('DELETE FROM reputation_votes WHERE voter_id=? AND target_id=?').run(voterId, targetId);
      return { action: 'removed' };
    }
    db.prepare('UPDATE reputation_votes SET value=? WHERE voter_id=? AND target_id=?').run(value, voterId, targetId);
    return { action: 'changed' };
  }
  db.prepare('INSERT INTO reputation_votes (id, voter_id, target_id, value) VALUES (?,?,?,?)').run(genId(), voterId, targetId, value);
  return { action: 'added' };
}

// ══════════════════════════════════════════════════════
// USER REPORT FUNCTIONS
// ══════════════════════════════════════════════════════

function createUserReport({ reporterId, targetId, reason, details }) {
  const id = genId();
  db.prepare('INSERT INTO user_reports (id, reporter_id, target_id, reason, details) VALUES (?,?,?,?,?)').run(id, reporterId, targetId, reason, details || '');
  return id;
}

function getUserReports({ targetId, status } = {}) {
  let sql = `
    SELECT r.*, 
      ru.first_name as reporter_first, ru.last_name as reporter_last, ru.username as reporter_username,
      tu.first_name as target_first, tu.last_name as target_last, tu.username as target_username, tu.avatar as target_avatar
    FROM user_reports r
    JOIN users ru ON ru.id = r.reporter_id
    JOIN users tu ON tu.id = r.target_id
  `;
  const params = [];
  const where = [];
  if (targetId) { where.push('r.target_id=?'); params.push(targetId); }
  if (status)   { where.push('r.status=?');    params.push(status); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY r.created_at DESC';
  return db.prepare(sql).all(...params);
}

function getAllUserReports() {
  return db.prepare(`
    SELECT r.*,
      ru.first_name as reporter_first, ru.last_name as reporter_last, ru.username as reporter_username,
      tu.first_name as target_first, tu.last_name as target_last, tu.username as target_username, tu.avatar as target_avatar
    FROM user_reports r
    JOIN users ru ON ru.id = r.reporter_id
    JOIN users tu ON tu.id = r.target_id
    ORDER BY r.created_at DESC
  `).all();
}

function updateReportStatus(reportId, status, adminNote) {
  db.prepare("UPDATE user_reports SET status=?, admin_note=?, reviewed_at=datetime('now') WHERE id=?").run(status, adminNote || '', reportId);
}

function getReportCountByUser() {
  return db.prepare('SELECT target_id, COUNT(*) as count FROM user_reports GROUP BY target_id').all();
}

// ── Maintenance Requests ────────────────────────────────────────────────────
db.prepare(`CREATE TABLE IF NOT EXISTS maintenance_requests (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category    TEXT NOT NULL DEFAULT 'general',
  title       TEXT NOT NULL,
  description TEXT NOT NULL,
  location    TEXT,
  priority    TEXT NOT NULL DEFAULT 'normal',  -- low | normal | high | urgent
  status      TEXT NOT NULL DEFAULT 'open',    -- open | in_progress | resolved | closed
  admin_note  TEXT,
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now')),
  resolved_at TEXT
)`).run();

// ── Utility Bills ─────────────────────────────────────────────────────────────
db.prepare(`CREATE TABLE IF NOT EXISTS utility_bills (
  id          TEXT PRIMARY KEY,
  month       TEXT NOT NULL,               -- YYYY-MM
  type        TEXT NOT NULL,               -- electricity | water
  amount      REAL NOT NULL DEFAULT 0,
  unit_used   REAL,                        -- kWh or cubic meters
  note        TEXT,
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now'))
)`).run();
db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_utility_month_type ON utility_bills(month, type)`).run();

// ── DB Archives (full .db snapshots — the "closet" of old databases) ───────────
// One row per saved snapshot. The actual file lives in Cloudinary (raw resource)
// so it survives Railway redeploys; falls back to local disk under DATA_DIR if
// Cloudinary isn't configured (dev mode). Auto-created on every semester
// rollover; admins can also trigger one manually from the Archive DB tab.
db.prepare(`CREATE TABLE IF NOT EXISTS db_archives (
  id                    TEXT PRIMARY KEY,
  label                 TEXT NOT NULL,               -- e.g. "1st Semester 2026"
  semester_tag          TEXT DEFAULT '',
  reason                TEXT NOT NULL DEFAULT 'semester_rollover', -- semester_rollover | manual
  resident_count        INTEGER DEFAULT 0,
  file_size_bytes       INTEGER DEFAULT 0,
  file_name             TEXT DEFAULT '',
  storage               TEXT NOT NULL DEFAULT 'cloudinary', -- cloudinary | local
  file_url              TEXT DEFAULT '',              -- Cloudinary secure_url OR local path
  cloudinary_public_id  TEXT DEFAULT '',
  created_by            TEXT DEFAULT '',
  created_at            TEXT DEFAULT (datetime('now'))
)`).run();
db.prepare(`CREATE INDEX IF NOT EXISTS idx_db_archives_created ON db_archives(created_at DESC)`).run();

// ── v2 feature migrations ─────────────────────────────────────────────────────
// maintenance image attachment
migrate(`ALTER TABLE maintenance_requests ADD COLUMN image_url TEXT DEFAULT ''`);
// GCash receipt attached by resident to a billing record
migrate(`ALTER TABLE dorm_billing ADD COLUMN receipt_url TEXT DEFAULT ''`);
// Utility bill scan / proof-of-billing image
migrate(`ALTER TABLE utility_bills ADD COLUMN image_url TEXT DEFAULT ''`);

// ── v3 semester / admission slip migrations ────────────────────────────────────
// Semester tag on deleted_users so we can filter by semester for re-enrollment
migrate(`ALTER TABLE deleted_users ADD COLUMN semester_tag TEXT DEFAULT ''`);
// Per-user admission slip serial counter (reset each semester rollover)
migrate(`ALTER TABLE users ADD COLUMN admission_no TEXT DEFAULT ''`);

// idx_users_status depends on account_status, which is only guaranteed to exist
// once the migration above (and the account_status migration earlier in this
// file) has run — so this index is created here, after migrations, instead of
// in the initial db.exec() schema block. Creating it earlier breaks on a fresh
// database where the users table hasn't been ALTERed yet.
db.exec(`CREATE INDEX IF NOT EXISTS idx_users_status ON users(account_status, is_active);`);

// Seed default app_settings for semester management (only if not already set)
db.prepare(`INSERT OR IGNORE INTO app_settings (key, value) VALUES ('current_semester', '1st Semester')`).run();
db.prepare(`INSERT OR IGNORE INTO app_settings (key, value) VALUES ('school_year', '${new Date().getFullYear()}')`).run();
db.prepare(`INSERT OR IGNORE INTO app_settings (key, value) VALUES ('slip_valid_to', '')`).run();
db.prepare(`INSERT OR IGNORE INTO app_settings (key, value) VALUES ('admission_counter', '0')`).run();


function createMaintenanceRequest({ userId, category, title, description, location, priority, imageUrl = '' }) {
  const id = genId();
  db.prepare(`INSERT INTO maintenance_requests (id, user_id, category, title, description, location, priority, image_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, userId, category || 'general', title, description, location || '', priority || 'normal', imageUrl || '');
  return id;
}

function getMaintenanceRequests({ status, userId, limit = 100, offset = 0 } = {}) {
  let q = `SELECT mr.*, u.first_name, u.last_name, u.username, u.avatar,
    COALESCE(ba.room_id, '') as room_id,
    dr.room_number,
    ba.bed_number
    FROM maintenance_requests mr
    JOIN users u ON u.id = mr.user_id
    LEFT JOIN bed_assignments ba ON ba.user_id = mr.user_id
    LEFT JOIN dorm_rooms dr ON dr.id = ba.room_id
    WHERE 1=1`;
  const params = [];
  if (status && status !== 'all') { q += ' AND mr.status = ?'; params.push(status); }
  if (userId) { q += ' AND mr.user_id = ?'; params.push(userId); }
  q += " ORDER BY CASE mr.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, mr.created_at DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);
  return db.prepare(q).all(...params);
}

function updateMaintenanceRequest(id, { status, adminNote, resolvedAt }) {
  const now = "datetime('now')";
  db.prepare(`UPDATE maintenance_requests SET
    status = COALESCE(?, status),
    admin_note = COALESCE(?, admin_note),
    resolved_at = CASE WHEN ? IN ('resolved','closed') THEN datetime('now') ELSE resolved_at END,
    updated_at = datetime('now')
    WHERE id = ?`).run(status || null, adminNote ?? null, status || null, id);
}

function getMaintenanceStats() {
  return {
    open:        db.prepare("SELECT COUNT(*) as n FROM maintenance_requests WHERE status='open'").get().n,
    in_progress: db.prepare("SELECT COUNT(*) as n FROM maintenance_requests WHERE status='in_progress'").get().n,
    resolved:    db.prepare("SELECT COUNT(*) as n FROM maintenance_requests WHERE status='resolved' OR status='closed'").get().n,
  };
}

// ── Utility Bill Functions ─────────────────────────────────────────────────────
/**
 * Insert or update a utility bill row.
 *
 * @param {object}  opts
 * @param {string}  opts.month             - YYYY-MM
 * @param {string}  opts.type              - 'electricity' | 'water'
 * @param {number}  opts.amount
 * @param {number}  [opts.unitUsed]
 * @param {string}  [opts.note]
 * @param {string}  [opts.imageUrl='']    - New image URL; empty string = no change (keeps existing)
 * @param {boolean} [opts.removeImage=false] - When true, explicitly sets image_url to ''.
 *   Without this flag an empty imageUrl is treated as "no change" (the CASE WHEN guard)
 *   so a normal save-without-image doesn't accidentally wipe a stored bill photo.
 */
function upsertUtilityBill({ month, type, amount, unitUsed, note, imageUrl = '', removeImage = false }) {
  const id = genId();
  if (removeImage) {
    // Explicit removal — bypass the preserve-image guard, always write empty string.
    db.prepare(`INSERT INTO utility_bills (id, month, type, amount, unit_used, note, image_url)
      VALUES (?, ?, ?, ?, ?, ?, '')
      ON CONFLICT(month, type) DO UPDATE SET
        amount     = excluded.amount,
        unit_used  = excluded.unit_used,
        note       = excluded.note,
        image_url  = '',
        updated_at = datetime('now')`).run(id, month, type, amount, unitUsed ?? null, note ?? null);
  } else {
    // Normal upsert — keep the existing image when no new image is provided.
    db.prepare(`INSERT INTO utility_bills (id, month, type, amount, unit_used, note, image_url)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(month, type) DO UPDATE SET
        amount     = excluded.amount,
        unit_used  = excluded.unit_used,
        note       = excluded.note,
        image_url  = CASE WHEN excluded.image_url = '' THEN image_url ELSE excluded.image_url END,
        updated_at = datetime('now')`).run(id, month, type, amount, unitUsed ?? null, note ?? null, imageUrl || '');
  }
}

/** Set GCash / payment receipt uploaded by a resident against their billing record. */
function setBillReceipt(billId, userId, receiptUrl) {
  return db.prepare(`UPDATE dorm_billing SET receipt_url=? WHERE id=? AND user_id=?`)
    .run(receiptUrl, billId, userId);
}

/** Admin: clear a billing receipt (e.g. false upload). */
function clearBillReceipt(billId) {
  return db.prepare(`UPDATE dorm_billing SET receipt_url='' WHERE id=?`).run(billId);
}

function getUtilityBills({ month, type, from, to } = {}) {
  let q = 'SELECT * FROM utility_bills WHERE 1=1';
  const params = [];
  // Single-month filter (existing behaviour)
  if (month) { q += ' AND month = ?'; params.push(month); }
  // Date-range filter: from (inclusive) and/or to (inclusive), format YYYY-MM
  if (from)  { q += ' AND month >= ?'; params.push(from); }
  if (to)    { q += ' AND month <= ?'; params.push(to); }
  if (type)  { q += ' AND type = ?';  params.push(type); }
  q += ' ORDER BY month DESC, type ASC';
  return db.prepare(q).all(...params);
}

function getUtilityTrend(months = 12) {
  return db.prepare(`SELECT month, type, amount, unit_used FROM utility_bills
    ORDER BY month DESC, type ASC LIMIT ?`).all(months * 2);
}

// ── Admission Slip helpers ─────────────────────────────────────────────────────

/**
 * Atomically increment admission_counter and return the new zero-padded number.
 * Stored in app_settings so it survives restarts and resets cleanly each semester.
 */
function nextAdmissionNo() {
  const current = parseInt(getSetting('admission_counter', '0'), 10) || 0;
  const next    = current + 1;
  setSetting('admission_counter', String(next));
  return String(next).padStart(4, '0');
}

/**
 * Semester rollover: archive all current approved residents to deleted_users,
 * reset the admission counter, and update the semester setting.
 * Called by the admin "New Semester" action.
 * Returns { archived, skipped } counts.
 */
function semesterRollover(newSemester, schoolYear, newSlipValidTo, adminId) {
  const { randomUUID } = require('crypto');
  const semesterTag = `${newSemester} ${schoolYear}`;
  const residents = db.prepare(
    `SELECT u.*, ivr.id_front_url, ivr.id_back_url, ivr.selfie_url,
      ivr.cert_residency_url, ivr.cert_low_income_url, ivr.cert_enrollment_url
     FROM users u
     LEFT JOIN id_verification_requests ivr ON ivr.user_id = u.id
       AND ivr.id = (SELECT id FROM id_verification_requests WHERE user_id = u.id ORDER BY created_at DESC LIMIT 1)
     WHERE u.account_status = 'approved' AND u.role = 'user'`
  ).all();

  let archived = 0, skipped = 0;

  const insertArchive = db.prepare(`
    INSERT OR IGNORE INTO deleted_users
      (id, original_id, first_name, middle_name, last_name, suffix, username, email, phone,
       birthday, sex, civil_status, bio, location, avatar, auth_provider, role,
       present_address, permanent_address, school_name, course, year_level, school_address,
       father_info, mother_info, monthly_income,
       id_front_url, id_back_url, selfie_url,
       cert_residency_url, cert_low_income_url, cert_enrollment_url,
       original_created_at, deleted_by, semester_tag)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  db.transaction(() => {
    for (const u of residents) {
      try {
        insertArchive.run(
          randomUUID(), u.id,
          u.first_name, u.middle_name || '', u.last_name, u.suffix || '',
          u.username, u.email, u.phone || '',
          u.birthday || '', u.sex || '', u.civil_status || '', u.bio || '', u.location || '',
          u.avatar || '', u.auth_provider || 'local', u.role || 'user',
          u.present_address || '', u.permanent_address || '',
          u.school_name || '', u.course || '', u.year_level || '', u.school_address || '',
          u.father_info || '', u.mother_info || '', u.monthly_income || '',
          u.id_front_url || '', u.id_back_url || '', u.selfie_url || '',
          u.cert_residency_url || '', u.cert_low_income_url || '', u.cert_enrollment_url || '',
          u.created_at || '', adminId, semesterTag
        );
        // Clear FK-constrained rows, then hard-delete
        db.prepare('DELETE FROM bed_assignments WHERE user_id = ?').run(u.id);
        db.prepare('DELETE FROM dorm_billing WHERE user_id = ?').run(u.id);
        db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
        archived++;
      } catch (e) {
        skipped++;
      }
    }
  })();

  // Update settings for new semester
  setSetting('current_semester', newSemester);
  setSetting('school_year', String(schoolYear));
  setSetting('slip_valid_to', newSlipValidTo || '');
  setSetting('admission_counter', '0'); // reset counter for new semester

  return { archived, skipped };
}

// ── DB Archives (full-db snapshot metadata) ────────────────────────────────
// The actual file I/O (backup, Cloudinary upload/fetch, restore) lives in
// routes/admin.js next to the existing Backup & Restore endpoints — this
// layer only tracks the metadata row so the "Archive DB" tab can list,
// download, restore, and purge saved snapshots.

function createDbArchive({
  label, semesterTag = '', reason = 'semester_rollover', residentCount = 0,
  fileSizeBytes = 0, fileName = '', storage = 'cloudinary', fileUrl = '',
  cloudinaryPublicId = '', createdBy = '',
}) {
  const id = genId();
  db.prepare(`
    INSERT INTO db_archives
      (id, label, semester_tag, reason, resident_count, file_size_bytes,
       file_name, storage, file_url, cloudinary_public_id, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, label, semesterTag, reason, residentCount, fileSizeBytes,
    fileName, storage, fileUrl, cloudinaryPublicId, createdBy
  );
  return id;
}

function getDbArchives() {
  return db.prepare(`
    SELECT d.*, u.username AS created_by_username
    FROM db_archives d
    LEFT JOIN users u ON u.id = d.created_by
    ORDER BY d.created_at DESC
  `).all();
}

function getDbArchiveById(id) {
  return db.prepare('SELECT * FROM db_archives WHERE id = ?').get(id);
}

function deleteDbArchiveById(id) {
  return db.prepare('DELETE FROM db_archives WHERE id = ?').run(id);
}

module.exports = {
  db, genId,
  // User
  users, findUserByEmail, findUserById, findUserByUsername, findUserByPhone,
  createUser, updateUser,
  // OTP
  saveOTP, verifyOTP, saveResetOTP, verifyResetOTP, consumeResetOTP,
  // Login
  recordFailedLogin, checkLoginLock, clearLoginAttempts,
  // Posts
  createPost, getPostById, getFeedPosts, getPublicPosts, getUserPosts, updatePost, deletePost,
  // Likes
  toggleLike,
  // Comments
  addComment, getComments, deleteComment,
  toggleReaction, getReactions, getUserReaction, getBulkReactions,
  sendFollowRequest, acceptFollowRequest, declineFollowRequest, cancelFollowRequest, getPendingFollowRequests, getFollowRequestStatus,
  sendFriendRequest, acceptFriendRequest, declineFriendRequest, removeFriend, getFriendshipStatus, areFriends, getPendingFriendRequests, getOutgoingFriendRequests, getFriendCount,
  toggleMsgReaction, getMsgReactions, getUserMsgReaction,
  getReactors,
  // Follows
  toggleFollow, isFollowing, getFollowerCount, getFollowingCount, getSuggestedUsers,
  // Notifications
  createNotification, getNotifications, getUnreadCount, markAllRead, markOneRead,
  // Messages
  createMessage, getMessages, getConversations, markMessagesRead, getUnreadMessageCount,
  // Search
  searchUsers,
  getSetting,
  setSetting,
  toUTC,
  updatePostStatus,
  // Post Moderation
  getPendingPosts, moderatePost, markPostAiReviewed,
  logAiModerationAction, getAiModerationLog,
  // ID Verification
  submitIdVerification, getPendingVerifications, getAllVerifications, reviewVerification, setVerificationAiResult,
  // Admin Logs
  logAdminAction, getAdminLogs,
  // User Management
  banUser, unbanUser,
  // Account Approval
  getPendingAccounts, approveAccount, rejectAccount,
  archiveRejectedRegistration, getRejectedRegistrations, deleteRejectedRegistration,
  getFullUserProfile,
  // Dormitory Management
  getDormRooms, assignBed, unassignBed,
  getDormBilling, generateMonthlyBills, generateBillForUser, markBillPaid, markBillUnpaid, waiveBill, setBillComment,
  // Reputation
  getReputationScore, getMyRepVote, setRepVote,
  // Reports
  createUserReport, getUserReports, getAllUserReports, updateReportStatus, getReportCountByUser,
  // Maintenance Requests
  createMaintenanceRequest, getMaintenanceRequests, updateMaintenanceRequest, getMaintenanceStats,
  // Utility Bills
  upsertUtilityBill, getUtilityBills, getUtilityTrend,
  // GCash / billing receipts
  setBillReceipt, clearBillReceipt,
  // Admission Slip / Semester
  nextAdmissionNo, semesterRollover,
  // DB Archives (full snapshots)
  createDbArchive, getDbArchives, getDbArchiveById, deleteDbArchiveById,
};
