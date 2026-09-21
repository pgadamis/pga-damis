/**
 * server.js — PGA-DAMIS Entry Point
 *
 * Provincial Government of Aurora — Dormitory Application &
 * Management Information System
 *
 * Features:
 *   - Admin account management & approval workflow
 *   - Post moderation queue (pending → approved/rejected)
 *   - AI-assisted content moderation (Gemini pool)
 *   - ID verification workflow with document uploads
 *   - Dormitory bed assignment & billing management
 *   - Maintenance requests & utility bill tracking
 *   - User ban/unban, audit logging, real-time via Socket.IO
 *   - Student Residents Questionnaire (ISO/IEC 25010 research instrument)
 */

require('dotenv').config();

const http      = require('http');
const express   = require('express');
const morgan    = require('morgan');
const session   = require('express-session');
const passport  = require('passport');
const flash     = require('connect-flash');
const helmet    = require('helmet');
const cors      = require('cors');
const path      = require('path');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const log       = require('./utils/logger');
const { seedAdmin } = require('./utils/seedAdmin');
const { seedTestUsers } = require('./utils/seedTestUsers');

// ── Routes ────────────────────────────────────────────
const authRoutes         = require('./routes/auth');
const postsRoutes        = require('./routes/posts');
const usersRoutes        = require('./routes/users');
const notifRoutes        = require('./routes/notifications');
const messagesRoutes     = require('./routes/messages');
const adminRoutes        = require('./routes/admin');
const aiRoutes           = require('./routes/ai');
const researchRoutes     = require('./routes/research');

const app        = express();
const httpServer = http.createServer(app);
const io         = new Server(httpServer);

// Make io available inside routes via req.app.get('io')
app.set('io', io);

// ── Security headers ──────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false,
  // CDN resources (Tailwind, Font Awesome, jsDelivr, Google Fonts) are cross-origin.
  // Helmet v7 defaults crossOriginResourcePolicy to 'same-origin', which blocks them.
  // 'cross-origin' restores the pre-Helmet-v7 behaviour for resource loads.
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(cors());

// ── Rate limiting ─────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  message: { error: 'Too many attempts. Please wait 15 minutes and try again.' },
  standardHeaders: true, legacyHeaders: false,
});
// OTP sends are expensive (hit email provider API) — limit tightly to prevent
// abuse that gets our email provider accounts flagged / blocked.
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 5,
  message: { error: 'Too many verification code requests. Please wait 15 minutes and try again.' },
  standardHeaders: true, legacyHeaders: false,
  skipSuccessfulRequests: false,
});
const checkLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, max: 60,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true, legacyHeaders: false,
});
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, max: 120,
  message: { error: 'Too many requests. Slow down!' },
  standardHeaders: true, legacyHeaders: false,
});
// AI support chat rate limiting is handled at the Gemini API level (20 RPD)

app.use('/api/auth/send-otp',              otpLimiter);
app.use('/api/auth/resend-otp',            otpLimiter);
app.use('/api/auth/verify-otp',            authLimiter);
app.use('/api/auth/complete-registration', authLimiter);
app.use('/api/auth/login',                 authLimiter);
app.use('/api/auth/forgot-password',       authLimiter);
app.use('/api/auth/verify-reset-otp',      authLimiter);
app.use('/api/auth/reset-password',        authLimiter);
app.use('/api/auth/check-username',        checkLimiter);
app.use('/api/auth/check-phone',           checkLimiter);
app.use('/api/',                           apiLimiter);

// ── Request logging (morgan) ──────────────────────────
// Skip high-frequency polling endpoints that flood the terminal.
// The custom request-logger below handles errors/mutations on these routes anyway.
const MORGAN_SKIP_RE = /^\/api\/admin\/(maintenance\/stats|users\/[^/]+\/reputation)$/;
const morganSkip = (req) =>
  req.method === 'GET' && MORGAN_SKIP_RE.test(req.path);

if (process.env.NODE_ENV !== 'production') {
  app.use(morgan('dev', { skip: morganSkip }));
} else {
  app.use(morgan('combined', { skip: morganSkip }));
}

// ── Body parsers ──────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Trust Railway's reverse proxy ────────────────────
app.set('trust proxy', 1);

// ── Sessions ──────────────────────────────────────────
// better-sqlite3-session-store already lives in package.json and shares the
// same DB file as the rest of the app.  The 'sessions' table is created
// automatically on first boot.  TTL matches cookie maxAge; expired rows are
// pruned on the interval below so the table doesn't grow unboundedly.
const SqliteStore       = require('better-sqlite3-session-store')(session);
const { db: sessionDb } = require('./utils/db');

app.use(session({
  store: new SqliteStore({
    client: sessionDb,
    expired: {
      clear:      true,
      intervalMs: 15 * 60 * 1000, // prune expired rows every 15 min
    },
  }),
  secret: process.env.SESSION_SECRET || 'fallback-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure:   process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge:   24 * 60 * 60 * 1000,
  }
}));

// ── Passport ──────────────────────────────────────────
require('./utils/passport-setup');
app.use(passport.initialize());
app.use(passport.session());

// ── Flash ─────────────────────────────────────────────
app.use(flash());
app.use((req, res, next) => {
  res.locals.user    = req.user || null;
  res.locals.success = req.flash('success');
  res.locals.error   = req.flash('error');
  next();
});

// ── Admin HTML guard (BEFORE static so the file is never served raw) ──
// Session + passport run first above, so req.user is fully populated here.
app.get('/admin.html', (req, res) => {
  // Admin access guard — requires authenticated admin/superadmin role
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    return res.redirect('/?unauthorized=admin');
  }
  if (req.user?.role !== 'admin' && req.user?.role !== 'superadmin') {
    return res.status(403).send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>403 – Forbidden</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{display:flex;align-items:center;justify-content:center;min-height:100vh;
       background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
  .card{text-align:center;padding:48px 40px;background:#fff;border-radius:24px;
        box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:400px;width:90%}
  .icon{font-size:56px;margin-bottom:16px}
  h1{font-size:20px;font-weight:700;color:#0f172a;margin-bottom:8px}
  p{color:#64748b;font-size:14px;margin-bottom:24px;line-height:1.6}
  a{display:inline-block;padding:10px 24px;background:#0070e0;color:#fff;
    border-radius:12px;text-decoration:none;font-size:14px;font-weight:600}
  a:hover{background:#0058b0}
  .code{font-size:11px;color:#94a3b8;margin-top:20px}
</style></head>
<body><div class="card">
  <div class="icon">🚫</div>
  <h1>Access Denied</h1>
  <p>Your account does not have admin privileges.<br>This attempt has been logged.</p>
  <a href="/feed.html">← Back to PGA-DAMIS</a>
  <p class="code">HTTP 403 Forbidden</p>
</div></body></html>`);
  }
  // Admin confirmed — serve the file
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ── Static files (after guard so admin.html route wins) ───────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Request logger ────────────────────────────────────────────────
const _reqLog = require('./utils/logger');

// Attach a short 6-char hex request ID to every request for cross-line correlation.
// e.g. ERROR and its matching request line share the same [a1b2c3] tag.
app.use((req, _res, next) => {
  req._id = require('crypto').randomBytes(3).toString('hex');
  next();
});

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms    = Date.now() - start;
    const s     = res.statusCode;
    const user  = req.user ? `@${req.user.username}` : 'anon';
    const rawIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '?';
    const ip    = rawIp.split(',')[0].trim().replace(/^::ffff:/, '').replace('::1', 'localhost');
    const isApi = req.path.startsWith('/api/');
    const isDorm = req.path.startsWith('/api/admin/dormitory');
    const isFileRoute = /upload|avatar|document|complete.registration/i.test(req.path);

    // Short request ID for correlation with domain-log lines emitted by route handlers
    const rid = `\x1b[2m[${req._id}]\x1b[0m`;

    // Colour-code status
    const statusStr = s >= 500 ? `\x1b[1m\x1b[31m${s}\x1b[0m`
                    : s >= 400 ? `\x1b[33m${s}\x1b[0m`
                    : s >= 300 ? `\x1b[36m${s}\x1b[0m`
                    :            `\x1b[32m${s}\x1b[0m`;

    // Timing colour (raised thresholds for file-upload routes)
    const slowLimit = isFileRoute ? 15000 : 2000;
    const warnLimit = isFileRoute ?  6000 :  500;
    const msStr = ms > slowLimit ? `\x1b[1m\x1b[31m${ms}ms\x1b[0m`
                : ms > warnLimit ? `\x1b[33m${ms}ms\x1b[0m`
                :                  `${ms}ms`;

    // Include query string for GET requests (helps debug wrong filter values)
    const qs = req.method === 'GET' && req.query && Object.keys(req.query).length
      ? `\x1b[2m?${new URLSearchParams(req.query).toString().slice(0, 80)}\x1b[0m`
      : '';

    // Inline body snippet for mutations in dev (passwords etc. scrubbed)
    let bodyHint = '';
    if (process.env.NODE_ENV !== 'production' && req.body && req.method !== 'GET') {
      const SENSITIVE = /password|passwd|secret|token|otp|code|key|auth|credential/i;
      const scrubbed  = Object.fromEntries(
        Object.entries(req.body).map(([k, v]) => [k, SENSITIVE.test(k) ? '[redacted]' : v])
      );
      const snippet = JSON.stringify(scrubbed).slice(0, 160);
      bodyHint = `\n   \x1b[2m↳ body: ${snippet}${snippet.length >= 160 ? '…' : ''}\x1b[0m`;
    }

    // For 500s, show the error message that the route handler stashed on res._errMsg
    const errHint = s >= 500 && res._errMsg
      ? `\n   \x1b[31m↳ error: ${res._errMsg}\x1b[0m`
      : '';

    const base = `${rid} ${req.method.padEnd(6)} ${req.path}${qs} → ${statusStr} ${msStr} [${user}]  ip=${ip}`;

    if (s >= 500) {
      _reqLog.error(`${base} 🔴 SERVER ERROR${errHint}${bodyHint}`);
    } else if (s === 409 && isApi) {
      _reqLog.warn(`${base} ⚡ CONFLICT`);
    } else if (s === 404 && isApi) {
      _reqLog.warn(`${base} ⚠ NOT FOUND`);
    } else if (s === 403 && isApi) {
      _reqLog.warn(`${base} 🚫 FORBIDDEN`);
    } else if (s === 401 && isApi) {
      _reqLog.warn(`${base} 🔒 UNAUTHORIZED`);
    } else if (s === 400 && isApi) {
      _reqLog.warn(`${base} ✗ BAD REQUEST${bodyHint}`);
    } else if (s === 429 && isApi) {
      _reqLog.warn(`${base} 🛑 RATE LIMITED`);
    } else if (s >= 400 && isApi) {
      _reqLog.warn(`${base} ⚠ CLIENT ERROR`);
    } else if (!isFileRoute && ms > slowLimit && isApi) {
      _reqLog.warn(`${base} 🐌 VERY SLOW (>${ms}ms)`);
    } else if (!isFileRoute && ms > warnLimit && isApi) {
      _reqLog.warn(`${base} ⏱ SLOW (>${ms}ms)`);
    } else if (isFileRoute && ms > slowLimit) {
      _reqLog.warn(`${base} 🐌 VERY SLOW — file upload${bodyHint}`);
    } else if (isDorm && s < 400) {
      // Always log dormitory API calls (GET + mutations) — helps debug room/billing issues
      _reqLog.dorm(`${base}${bodyHint}`);
    } else if (isApi && req.method !== 'GET' && req.method !== 'OPTIONS' && s < 300) {
      _reqLog.info(`${base}${bodyHint}`);
    }
    // Suppress: 2xx/3xx GETs for non-admin APIs and static assets
  });
  next();
});

// ── Routes ────────────────────────────────────────────
app.use('/', authRoutes);
app.use('/', postsRoutes);
app.use('/', usersRoutes);
app.use('/', notifRoutes);
app.use('/', messagesRoutes);
app.use('/', adminRoutes);
app.use('/', aiRoutes);
app.use('/', researchRoutes);

// ── Socket.io ─────────────────────────────────────────
const onlineUsers = new Map(); // userId → socketId

io.on('connection', (socket) => {
  // Client joins their own room + broadcasts online
  socket.on('join', (userId) => {
    if (!userId) return;
    socket.join(`user:${userId}`);
    socket.userId = userId;
    onlineUsers.set(userId, socket.id);
    log.socket(`User connected: ${userId} (online: ${onlineUsers.size})`);
    socket.broadcast.emit('user-online', { userId });
  });

  // Admins join a special room to receive real-time registration/moderation alerts
  socket.on('join-admin', (userId) => {
    if (!userId) return;
    socket.join('admins');
    log.socket(`Admin joined monitoring room: ${userId}`);
  });

  // Join a specific DM room (both participants)
  socket.on('join-dm', ({ myId, theirId }) => {
    if (myId && theirId) {
      const room = [myId, theirId].sort().join(':');
      socket.join(`dm:${room}`);
    }
  });

  // Send a DM via socket (complementary to REST POST)
  socket.on('send-dm', ({ toUserId, fromUserId, content }) => {
    if (!toUserId || !fromUserId || !content) return;
    io.to(`user:${toUserId}`).emit('receive-dm', {
      fromUserId,
      content,
      createdAt: new Date().toISOString(),
    });
  });

  // Typing indicators
  socket.on('typing-start', ({ toUserId, fromUserId }) => {
    io.to(`user:${toUserId}`).emit('user-typing', {
      fromUserId,
    });
  });

  socket.on('typing-stop', ({ toUserId, fromUserId }) => {
    io.to(`user:${toUserId}`).emit('user-stopped-typing', { fromUserId });
  });

  socket.on('disconnect', () => {
    if (socket.userId) {
      onlineUsers.delete(socket.userId);
      socket.broadcast.emit('user-offline', { userId: socket.userId });
    }
  });
});

// ── Fallback: serve index.html for client-side routes only ────
app.get('*', (req, res) => {
  // Don't intercept static .html files or API routes — those 404 naturally
  if (req.path.startsWith('/api/') || req.path.includes('.')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Global error handler ──────────────────────────────
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE')
    return res.status(400).json({ error: 'File too large. Maximum size is 5 MB.' });
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Server error. Please try again.' });
});

// ── Start ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, async () => {
  const env = process.env.NODE_ENV || 'development';
  console.log('\x1b[36m\x1b[1m');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║    PGA-DAMIS  —  Dormitory Application & Management  🏛️  ║');
  console.log('║         Provincial Government of Aurora                  ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('\x1b[0m');
  log.success(`Server listening on http://localhost:${PORT}`);
  log.success(`Admin panel    →  http://localhost:${PORT}/admin.html`);
  log.success(`Resident portal→  http://localhost:${PORT}/`);
  log.info(`Environment  : ${env} | Node ${process.version}`);
  log.info(`Sessions     : ✔ SQLite store (connecthub.db → sessions table)`);
  log.info(`Cloudinary   : ${process.env.CLOUDINARY_CLOUD_NAME ? '✔ configured' : '✖ NOT configured (base64 fallback)'}`);
  log.info(`Google OAuth : ${process.env.GOOGLE_CLIENT_ID      ? '✔ configured' : '✖ NOT configured'}`);
  const geminiPool   = require('./utils/geminiPool');
  const poolStatus   = geminiPool.getStatus();
  const hasGithub = !!process.env.GITHUB_TOKEN;
  const aiStatus = poolStatus.keyCount > 0
    ? `✔ Gemini (free) · ${poolStatus.keyCount} key${poolStatus.keyCount>1?'s':''} · ${poolStatus.keyCount*poolStatus.rpdLimit} req/day total${hasGithub ? ' · DeepSeek fallback ✔' : ''}`
    : hasGithub ? '✔ DeepSeek-V3 (GitHub Models)' : '✖ NOT configured';
  log.info(`AI Moderation: ${aiStatus}`);
  const { getDriver } = require('./utils/emailService');
  const emailDriverLabel = {
    sendgrid: `✔ SendGrid API (${process.env.SENDGRID_FROM || process.env.EMAIL_USER || '?'})`,
    smtp:     `✔ Gmail SMTP (${process.env.EMAIL_USER || '?'})`,
    console:  '⚠ Console/dev — no real delivery (set SENDGRID_API_KEY + SENDGRID_FROM for production)',
  }[getDriver()] || '?';
  log.info(`Email        : ${emailDriverLabel}`);
  log.divider();

  // Auto-create admin account from .env if not already present
  await seedAdmin();
  await seedTestUsers();

  // ── Security status announcement ────────────────────────────────────
  log.divider();
  if (env === 'production') {
    log.success('Security     : ✔ Production mode — all access guards active');
  } else {
    log.success('Security     : ✔ Guards active — /admin.html and /api/admin/* require admin role');
    log.info('Testing tip  : Use two different browsers (e.g. Brave + Firefox) to test admin + resident simultaneously');
  }
  log.divider();
});


// ── Auto-remind billing scheduler ────────────────────────────────────────
// Runs every 6 hours; sends reminders in the last 5 days of month if bills unpaid.
(function startBillingRemindScheduler() {
  const { db: dbRaw, getSetting, setSetting, createNotification } = require('./utils/db');
  const { sendDormReminderEmail } = require('./utils/emailService');

  // Guard: if a run is already in progress (e.g. slow email sends),
  // skip the next interval tick rather than stacking executions.
  let _isRunning = false;

  async function runAutoRemind() {
    if (_isRunning) {
      log.warn('[AutoRemind] Previous run still in progress — skipping this tick.');
      return;
    }
    _isRunning = true;
    try {
      const enabled = getSetting('auto_billing_remind', '1');
      if (enabled === '0') { return; }
      const now = new Date();
      const day = now.getDate();
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const daysLeft = daysInMonth - day;
      if (daysLeft > 5) { return; } // Only trigger last 5 days of month
      const month = now.toISOString().slice(0, 7);
      const lastRan = getSetting('auto_remind_last_month', '');
      if (lastRan === month) { return; } // Already ran this month
      const unpaidBills = dbRaw.prepare(
        "SELECT b.*, u.first_name, u.last_name, u.email, u.username, u.id as user_id " +
        "FROM dorm_billing b JOIN users u ON u.id=b.user_id " +
        "WHERE b.month=? AND b.status='unpaid'"
      ).all(month);
      if (!unpaidBills.length) {
        setSetting('auto_remind_last_month', month);
        return;
      }
      let sent = 0;
      for (const bill of unpaidBills) {
        try {
          createNotification({
            userId: bill.user_id, type: 'billing_reminder',
            actorId: null, targetId: null,
            message: `Auto-reminder: Your dorm bill of \u20b1${bill.amount} for ${bill.month} is due soon. Please settle before month-end.`,
          });
          io.to(`user:${bill.user_id}`).emit('new-notification', { userId: bill.user_id });
          await sendDormReminderEmail(bill.email, bill.first_name, bill.month, bill.amount);
          sent++;
        } catch (e) {
          log.warn(`[AutoRemind] Failed for @${bill.username || bill.email}: ${e.message}`);
        }
      }
      setSetting('auto_remind_last_month', month);
      log.billing(`🤖 Auto-remind ran for ${month} — ${sent} student${sent !== 1 ? 's' : ''} notified (${daysLeft} day${daysLeft !== 1 ? 's' : ''} left in month)`);
    } catch (e) {
      log.warn(`[AutoRemind] Scheduler error: ${e.message}`);
    } finally {
      _isRunning = false;
    }
  }

  setInterval(runAutoRemind, 6 * 60 * 60 * 1000);
  setTimeout(runAutoRemind, 30_000);
  log.info('Billing auto-remind scheduler started (checks every 6h, triggers last 5 days of month)');
})();

// ── Graceful shutdown ─────────────────────────────────
function shutdown(signal) {
  log.warn(`${signal} received — shutting down gracefully…`);
  httpServer.close(() => {
    log.success('HTTP server closed cleanly.');
    process.exit(0);
  });
  setTimeout(() => { log.error('Forced exit after timeout.'); process.exit(1); }, 10000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

module.exports = app;
