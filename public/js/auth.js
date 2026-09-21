// public/js/auth.js

'use strict';

// ═══════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════
const API = {
  SEND_OTP:       '/api/auth/send-otp',
  RESEND_OTP:     '/api/auth/resend-otp',
  VERIFY_OTP:     '/api/auth/verify-otp',
  COMPLETE_REG:   '/api/auth/complete-registration',
  CHECK_PHONE:    '/api/auth/check-phone',
  FORGOT_PASS:    '/api/auth/forgot-password',
  VERIFY_RESET:   '/api/auth/verify-reset-otp',
  RESET_PASS:     '/api/auth/reset-password',
  LOGIN:          '/api/auth/login',
  LOGOUT:         '/api/auth/logout',
  ME:             '/api/auth/me',
  GOOGLE:         '/auth/google',
  PENDING_GOOGLE: '/api/auth/pending-google',
};

// Philippine Standard Geographic Code API base

const PASSWORD_RULES = [
  { id: 'req-len',   test: p => p.length >= 8 },
  { id: 'req-upper', test: p => /[A-Z]/.test(p) },
  { id: 'req-lower', test: p => /[a-z]/.test(p) },
  { id: 'req-num',   test: p => /[0-9]/.test(p) },
  { id: 'req-sym',   test: p => /[^A-Za-z0-9]/.test(p) },
  { id: 'req-ns',    test: p => !/\s/.test(p) && p.length > 0 },
];
const SEG_COLORS = ['#ef4444','#f97316','#f59e0b','#10b981'];
const STR_LABELS = ['','Weak — keep going','Fair — almost there','Good — one more','Strong ✓'];
const STR_TW     = ['','#ef4444','#f97316','#f59e0b','#10b981'];

let countdownInterval = null;
let currentStep    = 1;
let isGoogleSignup = false;
let otpVerified    = false;     // locked true after successful OTP
let usernameCheckTimeout = null;
let phoneCheckTimeout    = null;
// Availability status: null=unchecked, true=available, false=taken
var usernameAvailableStatus = null;
var phoneAvailableStatus    = null;
// Last value that was actually sent to the server — so we don't re-check unchanged values
var usernameLastChecked = '';
var phoneLastChecked    = '';
let cameraStream = null;
let capturedPhotoData = null;   // base64 from camera capture
let avatarFileRef = null;       // File object for avatar upload (works for both picker + drag-drop)
let idFileRef = null;           // File object for ID upload (works for both picker + drag-drop)

// In-memory username registry for client-side dupe check
// (in production this hits the backend; here we track locally)
const registeredUsernames = new Set();

// ═══════════════════════════════════════════════════
// DOM UTILITIES
// ═══════════════════════════════════════════════════
const $ = id => document.getElementById(id);

function showStepError(step, msg) {
  const box = $('err-' + step);
  if (!box) return;
  $('err-' + step + '-txt').textContent = msg;
  box.classList.remove('hidden');
  box.classList.add('anim-shake');
  setTimeout(() => box.classList.remove('anim-shake'), 500);
}
function hideStepError(step) { $('err-' + step)?.classList.add('hidden'); }

function showToast(message, type) {
  type = type || 'success';
  document.querySelectorAll('.ch-toast').forEach(function(t){ t.remove(); });
  var toast = document.createElement('div');
  var bg = type === 'success' ? 'bg-green-600' : type === 'error' ? 'bg-red-600' : 'bg-slate-700';
  toast.className = 'ch-toast fixed bottom-6 right-6 z-50 ' + bg + ' text-white text-sm font-semibold px-5 py-3 rounded-xl shadow-xl anim-fade-up flex items-center gap-2';
  toast.innerHTML = (type === 'success' ? '✅ ' : type === 'error' ? '❌ ' : 'ℹ️ ') + message;
  document.body.appendChild(toast);
  setTimeout(function(){ toast.style.opacity='0'; toast.style.transition='opacity .3s'; setTimeout(function(){ toast.remove(); },300); }, 4000);
}

// ═══════════════════════════════════════════════════
// TAB SWITCHING
// ═══════════════════════════════════════════════════
function showTab(tab) {
  var isLogin = tab === 'login';
  $('panel-login').classList.toggle('hidden', !isLogin);
  $('panel-signup').classList.toggle('hidden', isLogin);
  var a = 'flex-1 py-4 text-sm font-bold text-brand-600 border-b-2 border-brand-600 transition-all';
  var i = 'flex-1 py-4 text-sm font-bold text-slate-400 border-b-2 border-transparent hover:text-slate-600 transition-all';
  $('tab-login').className  = isLogin ? a : i;
  $('tab-signup').className = !isLogin ? a : i;
}

// ═══════════════════════════════════════════════════
// MULTI-STEP NAVIGATION
// ═══════════════════════════════════════════════════
async function go(from) {
  // Show loading state on the Continue button during async server checks
  var continueBtn = from === 3 ? $('btn-step3') : (from === 1 ? $('btn-step1') : null);
  if (continueBtn) {
    continueBtn.disabled = true;
    continueBtn.innerHTML = '<span class="spinner mr-2"></span> Checking…';
  }
  var valid = await validateStep(from);
  if (continueBtn) {
    continueBtn.disabled = false;
    continueBtn.innerHTML = from === 1
      ? 'Continue <i class="fa-solid fa-arrow-right ml-1.5"></i>'
      : 'Continue <i class="fa-solid fa-arrow-right ml-1"></i>';
  }
  if (!valid) return;
  $('step-' + from).classList.add('hidden');
  currentStep = from + 1;
  var next = $('step-' + currentStep);
  if (next) next.classList.remove('hidden');
  updateProgress(currentStep);
  document.querySelector('.overflow-y-auto').scrollTop = 0;

  // When entering step 3, re-run availability checks on any pre-filled fields
  if (currentStep === 3) {
    initAddrDropdowns();
    // Auto-fill email display
    var emailSrc = $('reg-email');
    var emailDisp = $('reg-email-display');
    if (emailSrc && emailDisp) emailDisp.value = emailSrc.value;
    // Re-check username if field has a value (handles returning from Step 4/5)
    var uval = $('reg-uname') ? $('reg-uname').value.trim() : '';
    if (uval.length >= 3) {
      usernameLastChecked = ''; // force re-check
      checkUsernameAvailability(uval);
    } else {
      usernameAvailableStatus = null;
      usernameLastChecked = '';
    }
    // Re-check phone if field has a value
    var pval = $('reg-phone') ? $('reg-phone').value.replace(/\D/g,'') : '';
    if (pval.length === 10 && pval[0] === '9') {
      phoneLastChecked = ''; // force re-check
      checkPhoneAvailability(pval);
    } else {
      phoneAvailableStatus = null;
      phoneLastChecked = '';
    }
  }
}

function back(from) {
  // After OTP is verified, user CANNOT go back to step 2 from step 3+
  if (otpVerified && from <= 3) {
    showToast('Email already verified — you cannot go back to that step.', 'info');
    return;
  }
  stopCamera();
  stopSelfieCamera();
  $('step-' + from).classList.add('hidden');
  var prev = $('step-' + currentStep);
  if (prev) prev.classList.remove('hidden');
  updateProgress(currentStep);
  document.querySelector('.overflow-y-auto').scrollTop = 0;
  // Re-trigger availability checks when returning to step 3
  if (currentStep === 3) {
    var uval = $('reg-uname') ? $('reg-uname').value.trim() : '';
    if (uval.length >= 3) { usernameLastChecked = ''; checkUsernameAvailability(uval); }
    var pval = $('reg-phone') ? $('reg-phone').value.replace(/\D/g,'') : '';
    if (pval.length === 10 && pval[0] === '9') { phoneLastChecked = ''; checkPhoneAvailability(pval); }
  }
}

function updateProgress(s) {
  $('prog-bar').style.width = (s / 5 * 100) + '%';
  for (var i = 1; i <= 5; i++) {
    var dot = $('dot' + i), lbl = $('lbl' + i);
    if (!dot) continue;
    if (i < s) {
      dot.textContent = '✓';
      dot.className = 'w-6 h-6 rounded-full bg-green-500 text-white text-xs font-bold flex items-center justify-center';
      if (lbl) lbl.className = 'text-xs font-semibold text-green-500 hidden sm:inline';
    } else if (i === s) {
      dot.textContent = i;
      dot.className = 'w-6 h-6 rounded-full bg-blue-600 text-white text-xs font-bold flex items-center justify-center';
      if (lbl) lbl.className = 'text-xs font-bold text-blue-600 hidden sm:inline';
    } else {
      dot.textContent = i;
      dot.className = 'w-6 h-6 rounded-full bg-slate-200 text-slate-400 text-xs font-bold flex items-center justify-center';
      if (lbl) lbl.className = 'text-xs font-semibold text-slate-300 hidden sm:inline';
    }
  }
}

// ═══════════════════════════════════════════════════
// NAME INLINE VALIDATION
// ═══════════════════════════════════════════════════
function validateNameInline(inputId, errId) {
  var val = $(inputId).value.trim();
  var errEl = $(errId);
  if (!val) {
    $(inputId).classList.add('is-error');
    errEl.textContent = 'This field is required.';
    errEl.classList.remove('hidden');
    return false;
  }
  if (val.length < 2) {
    $(inputId).classList.add('is-error');
    errEl.textContent = 'Must be at least 2 characters.';
    errEl.classList.remove('hidden');
    return false;
  }
  if (val.length > 50) {
    $(inputId).classList.add('is-error');
    errEl.textContent = 'Must not exceed 50 characters.';
    errEl.classList.remove('hidden');
    return false;
  }
  if (/[0-9]/.test(val)) {
    $(inputId).classList.add('is-error');
    errEl.textContent = 'Name must not contain numbers.';
    errEl.classList.remove('hidden');
    return false;
  }
  // Production regex — letters (includes Filipino/Latin Extended: ñ, Ñ, accented),
  // spaces, hyphens, apostrophes, periods. No digits, no symbols.
  if (/[^\u0041-\u005A\u0061-\u007A\u00C0-\u00FF\u0100-\u024F\u1E00-\u1EFF '\-.]/.test(val)) {
    $(inputId).classList.add('is-error');
    errEl.textContent = 'Only letters, spaces, hyphens, and apostrophes are allowed.';
    errEl.classList.remove('hidden');
    return false;
  }
  if (/^[' \-.]/u.test(val) || /[' \-.]$/.test(val)) {
    $(inputId).classList.add('is-error');
    errEl.textContent = 'Name must start and end with a letter.';
    errEl.classList.remove('hidden');
    return false;
  }
  if (/['.\-]{2,}/.test(val)) {
    $(inputId).classList.add('is-error');
    errEl.textContent = 'Name must not have consecutive punctuation (e.g. --, \'\').';
    errEl.classList.remove('hidden');
    return false;
  }
  $(inputId).classList.remove('is-error');
  errEl.classList.add('hidden');
  return true;
}

function blockInvalidUsernameChars(input) {
  // Username: only a-z, A-Z, 0-9, underscore, period
  var val = input.value;
  var cleaned = val.replace(/[^a-zA-Z0-9_.]/g, '');
  if (cleaned !== val) {
    var pos = input.selectionStart - (val.length - cleaned.length);
    input.value = cleaned;
    input.setSelectionRange(Math.max(0, pos), Math.max(0, pos));
  }
}

function blockInvalidNameChars(input) {
  // Strip any character that can never be in a name: digits, symbols, etc.
  // Allowed: Unicode letters, space, hyphen, apostrophe, period
  var val = input.value;
  var cleaned = val.replace(/[0-9!@#$%^&*()_+=\[\]{};:"\\|<>,/?`~]/g, '');
  if (cleaned !== val) {
    var pos = input.selectionStart - (val.length - cleaned.length);
    input.value = cleaned;
    input.setSelectionRange(Math.max(0, pos), Math.max(0, pos));
  }
}

// ═══════════════════════════════════════════════════
// PHONE VALIDATION & FORMATTING
// ═══════════════════════════════════════════════════
function formatPhone(input) {
  // Input is the 10-digit field (after +63 prefix is locked)
  var raw = input.value.replace(/\D/g, '');
  if (raw.length > 10) raw = raw.slice(0, 10);
  input.value = raw;
  $('phone-err-msg').classList.add('hidden');
  $('phone-ok-icon').classList.add('hidden');
  // Live digit counter
  var counter = $('phone-digit-count');
  if (counter) {
    counter.textContent = raw.length + '/10';
    counter.className = raw.length === 10
      ? 'text-xs font-semibold text-green-500'
      : 'text-xs text-slate-400';
  }
}

function validatePhoneInline() {
  var digits = $('reg-phone').value.replace(/\D/g, '');
  var errEl  = $('phone-err-msg');
  var okIcon = $('phone-ok-icon');
  if (!digits) {
    $('reg-phone').classList.add('is-error');
    errEl.textContent = 'Phone number is required.';
    errEl.classList.remove('hidden');
    okIcon.classList.add('hidden');
    return false;
  }
  if (digits.length !== 10) {
    $('reg-phone').classList.add('is-error');
    errEl.textContent = 'Enter 10 digits after +63 (e.g. 9171234567).';
    errEl.classList.remove('hidden');
    okIcon.classList.add('hidden');
    return false;
  }
  // Must start with 9 (valid PH mobile)
  if (digits[0] !== '9') {
    $('reg-phone').classList.add('is-error');
    errEl.textContent = 'Mobile number must start with 9 (e.g. 9171234567).';
    errEl.classList.remove('hidden');
    okIcon.classList.add('hidden');
    return false;
  }
  $('reg-phone').classList.remove('is-error');
  errEl.classList.add('hidden');
  okIcon.classList.remove('hidden');
  // Format is valid — also kick off availability check
  checkPhoneAvailability(digits);
  return true;
}

// ═══════════════════════════════════════════════════
// USERNAME AVAILABILITY CHECK
// ═══════════════════════════════════════════════════
function checkUsernameAvailability(value) {
  clearTimeout(usernameCheckTimeout);
  var icon  = $('uname-status-icon');
  var msg   = $('uname-status-msg');
  var input = $('reg-uname');

  if (!value || value.length < 3) {
    icon.classList.add('hidden');
    msg.textContent = ''; msg.style.color = '';
    input.classList.remove('is-error');
    usernameAvailableStatus = null;
    usernameLastChecked = '';
    return;
  }

  if (!/^[a-zA-Z0-9_.]{3,20}$/.test(value)) {
    icon.textContent = '✗'; icon.style.color = '#ef4444'; icon.classList.remove('hidden');
    msg.textContent = '3–20 chars, letters / numbers / _ or . only.';
    msg.style.color = '#ef4444';
    input.classList.add('is-error');
    usernameAvailableStatus = false;
    usernameLastChecked = value;
    return;
  }

  // If we already have a definitive result for this exact value, keep it — don't re-show spinner
  if (value === usernameLastChecked && usernameAvailableStatus !== null) return;

  // Show spinner — but only reset status if value actually changed
  if (value !== usernameLastChecked) usernameAvailableStatus = null;
  icon.textContent = '…'; icon.style.color = '#94a3b8'; icon.classList.remove('hidden');
  msg.textContent = 'Checking availability…'; msg.style.color = '#94a3b8';

  usernameCheckTimeout = setTimeout(async function() {
    try {
      var res  = await fetch('/api/auth/check-username?username=' + encodeURIComponent(value));
      var data = await res.json();
      usernameLastChecked = value;

      if (!res.ok) {
        // 429 or server error — show neutral state, don't mark as available
        icon.textContent = '?'; icon.style.color = '#94a3b8';
        msg.textContent = 'Could not check availability. Will verify on Continue.';
        msg.style.color = '#94a3b8';
        usernameAvailableStatus = null; // unknown — validateStep will re-check
        return;
      }

      if (data.available) {
        icon.textContent = '✓'; icon.style.color = '#10b981';
        msg.textContent = '@' + value + ' is available!'; msg.style.color = '#10b981';
        input.classList.remove('is-error');
        usernameAvailableStatus = true;
      } else {
        icon.textContent = '✗'; icon.style.color = '#ef4444';
        msg.textContent = '@' + value + ' is already taken. Try another.'; msg.style.color = '#ef4444';
        input.classList.add('is-error');
        usernameAvailableStatus = false;
      }
    } catch(e) {
      usernameLastChecked = value;
      var taken = registeredUsernames.has(value.toLowerCase());
      usernameAvailableStatus = !taken;
      if (taken) {
        icon.textContent = '✗'; icon.style.color = '#ef4444';
        msg.textContent = '@' + value + ' is already taken. Try another.'; msg.style.color = '#ef4444';
        input.classList.add('is-error');
      } else {
        icon.textContent = '✓'; icon.style.color = '#10b981';
        msg.textContent = '@' + value + ' is available!'; msg.style.color = '#10b981';
        input.classList.remove('is-error');
      }
    }
  }, 500);
}

// ═══════════════════════════════════════════════════
// PHONE AVAILABILITY CHECK (live, like username)
// ═══════════════════════════════════════════════════
function checkPhoneAvailability(digits) {
  clearTimeout(phoneCheckTimeout);
  var errEl  = $('phone-err-msg');
  var okIcon = $('phone-ok-icon');
  var input  = $('reg-phone');

  // ⚠️ DEV MODE: live phone duplicate check disabled. Remove the next 6 lines to re-enable.
  phoneAvailableStatus = true; phoneLastChecked = digits;
  if (errEl)  { errEl.classList.add('hidden'); errEl.style.color = ''; }
  if (okIcon) okIcon.classList.remove('hidden');
  if (input)  input.classList.remove('is-error');
  return;
  // ── end dev bypass ──

  // Only check when format is valid
  if (!digits || digits.length !== 10 || digits[0] !== '9') return;

  // Already have a definitive answer for this exact number — keep it, no spinner
  if (digits === phoneLastChecked && phoneAvailableStatus !== null) return;

  // Value changed — mark as pending but DON'T wipe the old result yet (avoid flicker)
  if (digits !== phoneLastChecked) phoneAvailableStatus = null;

  // Show checking indicator
  if (errEl)  { errEl.textContent = 'Checking\u2026'; errEl.style.color = '#94a3b8'; errEl.classList.remove('hidden'); }
  if (okIcon) okIcon.classList.add('hidden');

  phoneCheckTimeout = setTimeout(async function() {
    try {
      var res  = await fetch(API.CHECK_PHONE + '?phone=' + encodeURIComponent(digits));
      var data = await res.json();
      phoneLastChecked = digits;

      if (!res.ok) {
        // 429 or server error — neutral state, don't show green checkmark
        if (errEl) { errEl.textContent = 'Could not verify. Will check on Continue.'; errEl.style.color = '#94a3b8'; errEl.classList.remove('hidden'); }
        if (okIcon) okIcon.classList.add('hidden');
        phoneAvailableStatus = null;
        return;
      }

      if (data.available) {
        phoneAvailableStatus = true;
        if (errEl)  { errEl.classList.add('hidden'); errEl.style.color = ''; }
        if (okIcon) okIcon.classList.remove('hidden');
        if (input)  input.classList.remove('is-error');
      } else {
        phoneAvailableStatus = false;
        if (okIcon) okIcon.classList.add('hidden');
        if (input)  input.classList.add('is-error');
        if (errEl)  {
          errEl.textContent = 'This number is already registered. Use a different number.';
          errEl.style.color = '';
          errEl.classList.remove('hidden');
        }
      }
    } catch(e) {
      // Network error — don't block the user
      phoneLastChecked = digits;
      phoneAvailableStatus = true;
      if (errEl) errEl.classList.add('hidden');
      if (okIcon) okIcon.classList.remove('hidden');
    }
  }, 600);
}

// ═══════════════════════════════════════════════════
// PASSWORD STRENGTH
// ═══════════════════════════════════════════════════
function evalPass(password) {
  var score = 0;
  PASSWORD_RULES.forEach(function(rule) {
    var ok = rule.test(password);
    var el = $(rule.id);
    if (!el) return;
    el.classList.toggle('ok', ok);
    el.classList.toggle('bad', !ok);
    el.querySelector('i').className = ok ? 'fa-solid fa-circle-check text-[10px]' : 'fa-solid fa-circle-dot text-[10px]';
    if (ok && PASSWORD_RULES.indexOf(rule) < 4) score++;
  });
  for (var i = 1; i <= 4; i++) $('seg' + i).style.background = i <= score ? SEG_COLORS[score-1] : '#e2e8f0';
  var lbl = $('str-lbl');
  lbl.textContent = password.length ? STR_LABELS[score] : '';
  lbl.style.color = STR_TW[score] || '#94a3b8';
  checkMatch();
}

function checkMatch() {
  var p1 = $('reg-pass').value, p2 = $('reg-conf').value, msg = $('match-msg');
  if (!p2) { msg.textContent = ''; return; }
  if (p1 === p2) { msg.textContent = '✓ Passwords match'; msg.style.color = '#10b981'; $('reg-conf').classList.remove('is-error'); }
  else           { msg.textContent = '✗ Passwords do not match'; msg.style.color = '#ef4444'; $('reg-conf').classList.add('is-error'); }
}

function toggleVis(inputId, btn) {
  var inp = $(inputId), ico = btn.querySelector('i');
  inp.type = inp.type === 'password' ? 'text' : 'password';
  ico.classList.toggle('fa-eye',       inp.type === 'password');
  ico.classList.toggle('fa-eye-slash', inp.type === 'text');
}

// ═══════════════════════════════════════════════════
// EMAIL TAKEN INLINE LABEL
// ═══════════════════════════════════════════════════
function showEmailTaken(msg) {
  $('email-taken-txt').textContent = msg;
  $('email-taken-msg').classList.remove('hidden');
  $('reg-email').classList.add('is-error');
}
function clearEmailTakenMsg() {
  $('email-taken-msg').classList.add('hidden');
  $('reg-email').classList.remove('is-error');
}

// ═══════════════════════════════════════════════════
// STEP VALIDATION
// ═══════════════════════════════════════════════════
async function validateStep(step) {

  if (step === 1) {
    var email = $('reg-email').value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showStepError(1, 'Please enter a valid email address.');
      return false;
    }
    if (!isGoogleSignup) {
      var pass = $('reg-pass').value, conf = $('reg-conf').value;
      var failed = PASSWORD_RULES.slice(0,5).filter(function(r){ return !r.test(pass); });
      if (failed.length) { showStepError(1, 'Your password must meet all 6 requirements above.'); return false; }
      if (pass !== conf) { showStepError(1, 'Passwords do not match.'); return false; }
    }
    hideStepError(1);
    return await sendOTP();
  }

  if (step === 3) {
    // Names
    var fOk = validateNameInline('reg-fname','fname-err');
    var lOk = validateNameInline('reg-lname','lname-err');
    if (!fOk) { showStepError(3, 'First name is required and must contain only letters.'); return false; }
    if (!lOk) { showStepError(3, 'Last name is required and must contain only letters.'); return false; }

    // Username removed — auto-generated server-side

    // Birthday
    var bday = $('reg-bday').value;
    if (!bday) { showStepError(3, 'Date of birth is required.'); return false; }
    var age = Math.floor((Date.now() - new Date(bday)) / (365.25 * 24 * 3600 * 1000));
    // Age check: applicants must be of appropriate age

    // Civil Status
    if (!$('reg-civil') || !$('reg-civil').value) { showStepError(3, 'Please select your civil status.'); return false; }

    // Sex
    var sex = document.querySelector('input[name="sex"]:checked');
    if (!sex) { showStepError(3, 'Please select your sex.'); return false; }

    // Phone
    if (!validatePhoneInline()) { showStepError(3, 'A valid Philippine phone number is required.'); $('reg-phone').focus(); return false; }
    // ⚠️ DEV MODE: submit-time phone check disabled. Uncomment the block below to re-enable.
    /* try {
      var phoneDigits = $('reg-phone').value.replace(/\D/g,'');
      var phoneRes  = await fetch(API.CHECK_PHONE + '?phone=' + encodeURIComponent(phoneDigits));
      var phoneData = await phoneRes.json();
      if (!phoneRes.ok) { showStepError(3, 'Could not verify phone number. Please try again.'); $('reg-phone').focus(); return false; }
      if (!phoneData.available) {
        var pErr = $('phone-err-msg');
        if (pErr) { pErr.textContent = 'This number is already registered.'; pErr.classList.remove('hidden'); }
        showStepError(3, 'This phone number is already registered. Please use a different number.');
        $('reg-phone').focus(); return false;
      }
      phoneAvailableStatus = true; phoneLastChecked = phoneDigits;
    } catch(e) {
      showStepError(3, 'Network error. Please check your connection and try again.');
      return false;
    } */

    // Permanent Address (required)
    if (!$('perm-region') || !$('perm-region').value) { showStepError(3, 'Please select your Permanent Address Region.'); return false; }
    if (!$('perm-city') || !$('perm-city').value)     { showStepError(3, 'Please select your Permanent Address City/Municipality.'); return false; }
    if (!$('perm-brgy') || !$('perm-brgy').value)     { showStepError(3, 'Please select your Permanent Address Barangay.'); return false; }
    buildAddrString('perm');

    // Present Address (required unless same-as-permanent checked)
    if (!$('same-as-permanent') || !$('same-as-permanent').checked) {
      if (!$('pres-region') || !$('pres-region').value) { showStepError(3, 'Please select your Present Address Region.'); return false; }
      if (!$('pres-city') || !$('pres-city').value)     { showStepError(3, 'Please select your Present Address City/Municipality.'); return false; }
      if (!$('pres-brgy') || !$('pres-brgy').value)     { showStepError(3, 'Please select your Present Address Barangay.'); return false; }
      buildAddrString('pres');
    } else {
      // Copy permanent to present
      if ($('pres-addr-hidden')) $('pres-addr-hidden').value = $('perm-addr-hidden') ? $('perm-addr-hidden').value : '';
    }

    // School Name / Address — required even in manual-entry mode
    if (!$('reg-school') || !$('reg-school').value.trim())       { showStepError(3, 'School Name is required.'); return false; }
    if (!$('reg-schooladdr') || !$('reg-schooladdr').value.trim()) { showStepError(3, 'School Address is required.'); return false; }

    // School — Year Level first, then Course, then optional Specialization.
    // Each has an independent "Not listed" checkbox — checked means the
    // dropdown is irrelevant and only its plain-text sibling is validated.
    var yearManualEl = $('reg-yearlevel-manual');
    var yearIsManual = !!($('yearlevel-manual-toggle') && $('yearlevel-manual-toggle').checked);
    if (yearIsManual) {
      if (!yearManualEl || !yearManualEl.value.trim()) { showStepError(3, 'Please type your year level.'); yearManualEl?.focus(); return false; }
    } else {
      if (!$('reg-yearlevel') || !$('reg-yearlevel').value) { showStepError(3, 'Please select your year level.'); return false; }
    }

    var courseManualEl = $('reg-course-manual');
    var courseIsManual = !!($('course-manual-toggle') && $('course-manual-toggle').checked);
    if (courseIsManual) {
      if (!courseManualEl || !courseManualEl.value.trim()) { showStepError(3, 'Please type your program / course.'); courseManualEl?.focus(); return false; }
    } else {
      if (!$('reg-course') || !$('reg-course').value) { showStepError(3, 'Please select your program / course.'); return false; }
    }

    // Specialization: required only when the row is visible. Manual course
    // entry forces specialization to optional free text (no cascade exists
    // for a course we don't recognize); otherwise it follows its own toggle.
    var specRow = $('specialization-row');
    if (specRow && !specRow.classList.contains('hidden') && !courseIsManual) {
      var specIsManual = !!($('specialization-manual-toggle') && $('specialization-manual-toggle').checked);
      if (specIsManual) {
        if (!$('reg-specialization-manual') || !$('reg-specialization-manual').value.trim()) {
          showStepError(3, 'Please type your major / specialization.'); return false;
        }
      } else if (!$('reg-specialization') || !$('reg-specialization').value) {
        showStepError(3, 'Please select your major / specialization.'); return false;
      }
    }

    // Monthly Income
    if (!$('reg-income') || !$('reg-income').value)    { showStepError(3, 'Please select your combined monthly income bracket.'); return false; }

    // ── Parent Information ─────────────────────────────────────────────────
    // Name is always required (it identifies the parent even if deceased);
    // contact/employer/address are skipped when the "deceased" box is checked.
    var fDeceased = !!($('father-deceased') && $('father-deceased').checked);
    var fFname    = ($('father-fname')||{}).value?.trim();
    var fLname    = ($('father-lname')||{}).value?.trim();
    if (!fFname) { showStepError(3, "Father's first name is required."); $('father-fname')?.focus(); return false; }
    if (!fLname) { showStepError(3, "Father's last name is required.");  $('father-lname')?.focus(); return false; }
    var fPhone = '', fEmployer = '', fAddr = '';
    if (!fDeceased) {
      fPhone    = ($('father-phone')||{}).value?.replace(/\D/g,'') || '';
      fEmployer = ($('father-employer')||{}).value?.trim();
      fAddr     = ($('father-addr-hidden')||{}).value?.trim();
      if (!fPhone || fPhone.length < 10) { showStepError(3, "Father's contact number must be 10 digits."); $('father-phone')?.focus(); return false; }
      if (fPhone[0] !== '9') { showStepError(3, "Father's contact number must start with 9."); $('father-phone')?.focus(); return false; }
      if (!fEmployer) { showStepError(3, "Father's employer / company is required."); $('father-employer')?.focus(); return false; }
      // Address required unless "Same as Permanent" is checked (which populates the hidden field)
      if (!fAddr) { showStepError(3, "Father's address is required. Select from the dropdowns or check \"Same as Permanent\"."); $('father-region')?.focus(); return false; }
    }

    var mDeceased = !!($('mother-deceased') && $('mother-deceased').checked);
    var mFname    = ($('mother-fname')||{}).value?.trim();
    var mLname    = ($('mother-lname')||{}).value?.trim();
    if (!mFname) { showStepError(3, "Mother's first name is required."); $('mother-fname')?.focus(); return false; }
    if (!mLname) { showStepError(3, "Mother's last name is required.");  $('mother-lname')?.focus(); return false; }
    var mPhone = '', mEmployer = '', mAddr = '';
    if (!mDeceased) {
      mPhone    = ($('mother-phone')||{}).value?.replace(/\D/g,'') || '';
      mEmployer = ($('mother-employer')||{}).value?.trim();
      mAddr     = ($('mother-addr-hidden')||{}).value?.trim();
      if (!mPhone || mPhone.length < 10) { showStepError(3, "Mother's contact number must be 10 digits."); $('mother-phone')?.focus(); return false; }
      if (mPhone[0] !== '9') { showStepError(3, "Mother's contact number must start with 9."); $('mother-phone')?.focus(); return false; }
      if (!mEmployer) { showStepError(3, "Mother's employer / company is required."); $('mother-employer')?.focus(); return false; }
      if (!mAddr) { showStepError(3, "Mother's address is required. Select from the dropdowns or check \"Same as Permanent\"."); $('mother-region')?.focus(); return false; }
    }

    // ── Guardian Information (required only when BOTH parents are deceased) ──
    if (fDeceased && mDeceased) {
      var gFname = ($('guardian-fname')||{}).value?.trim();
      var gLname = ($('guardian-lname')||{}).value?.trim();
      var gRel   = ($('guardian-relationship')||{}).value?.trim();
      var gPhone = ($('guardian-phone')||{}).value?.replace(/\D/g,'') || '';
      var gAddr  = ($('guardian-addr-hidden')||{}).value?.trim();
      if (!gFname) { showStepError(3, "Guardian's first name is required."); $('guardian-fname')?.focus(); return false; }
      if (!gLname) { showStepError(3, "Guardian's last name is required.");  $('guardian-lname')?.focus(); return false; }
      if (!gRel)   { showStepError(3, "Guardian's relationship to the resident is required."); $('guardian-relationship')?.focus(); return false; }
      if (!gPhone || gPhone.length < 10) { showStepError(3, "Guardian's contact number must be 10 digits."); $('guardian-phone')?.focus(); return false; }
      if (gPhone[0] !== '9') { showStepError(3, "Guardian's contact number must start with 9."); $('guardian-phone')?.focus(); return false; }
      if (!gAddr)  { showStepError(3, "Guardian's address is required. Select from the dropdowns or check \"Same as Permanent\"."); $('guardian-region')?.focus(); return false; }
    }

    hideStepError(3);
    return true;
  }

  if (step === 4) {
    // Profile photo only - required
    var hasPhoto = avatarFileRef || capturedPhotoData || ($('av-cropped-data') && $('av-cropped-data').value);
    if (!hasPhoto) { showStepError(4, 'Please upload or capture a profile photo.'); return false; }
    hideStepError(4);
    return true;
  }

  return true;
}

// ═══════════════════════════════════════════════════
// SEND OTP (step 1 Continue)
// ═══════════════════════════════════════════════════
async function sendOTP() {
  var btn = $('btn-step1');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner mr-2"></span> Sending code...';

  var email = $('reg-email').value.trim();
  var body = isGoogleSignup
    ? { email: email, isGoogleSignup: true }
    : { email: email, password: $('reg-pass').value, confirmPassword: $('reg-conf').value };

  try {
    var res  = await fetch(API.SEND_OTP, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    var data = await res.json();

    btn.disabled = false;
    btn.innerHTML = 'Continue <i class="fa-solid fa-arrow-right ml-1.5"></i>';

    if (!res.ok) {
      if (res.status === 409) { showEmailTaken(data.error); return false; }
      showStepError(1, data.error || 'Failed to send verification code.');
      return false;
    }

    $('otp-email').textContent = email;
    startCountdown();
    showToast('Code sent to ' + email + '!');
    return true;

  } catch(e) {
    btn.disabled = false;
    btn.innerHTML = 'Continue <i class="fa-solid fa-arrow-right ml-1.5"></i>';
    showStepError(1, 'Network error. Please check your connection.');
    return false;
  }
}

async function resendOTP() {
  var email = $('reg-email').value.trim();
  $('resend-btn').textContent = 'Sending...';
  $('resend-btn').disabled = true;
  try {
    var res  = await fetch(API.RESEND_OTP, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email: email }) });
    var data = await res.json();
    if (!res.ok) showStepError(2, data.error || 'Failed to resend code.');
    else { showToast('New code sent!'); startCountdown(); }
  } catch(e) { showStepError(2, 'Network error. Please try again.'); }
  $('resend-btn').disabled = false;
}

function startCountdown() {
  var secs = 60;
  clearInterval(countdownInterval);
  $('resend-timer').classList.remove('hidden');
  $('resend-btn').classList.add('hidden');
  $('cd').textContent = secs;
  countdownInterval = setInterval(function(){
    secs--;
    $('cd').textContent = secs;
    if (secs <= 0) { clearInterval(countdownInterval); $('resend-timer').classList.add('hidden'); $('resend-btn').classList.remove('hidden'); }
  }, 1000);
}

async function verifyOTP() {
  var otp = otpGetValue();
  if (otp.length < 6) {
    showStepError(2, 'Please enter all 6 digits.');
    return;
  }

  var btn = $('btn-verify');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner mr-2"></span> Verifying...';

  try {
    var res  = await fetch(API.VERIFY_OTP, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email: $('reg-email').value.trim(), otp: otp }) });
    var data = await res.json();

    if (!res.ok) {
      var errMsg2 = data.error || 'Incorrect code. Please try again.';
      // Mark all boxes red + shake
      OTP_IDS.forEach(function(id){ var el = $(id); if (el) el.classList.add('otp-error'); });
      setTimeout(function(){ otpClearError(); }, 1500);
      showStepError(2, errMsg2);

      // If locked out (5 attempts exhausted) — disable boxes and verify button
      var isLocked = errMsg2.toLowerCase().includes('too many') || errMsg2.toLowerCase().includes('new code');
      if (isLocked) {
        OTP_IDS.forEach(function(id){ var el=$(id); if(el){ el.disabled=true; el.classList.add('opacity-50'); } });
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-lock mr-2"></i> Code Expired — Restart Registration';
        // Show resend/restart option
        var resendRow = $('resend-locked-msg');
        if (!resendRow) {
          resendRow = document.createElement('p');
          resendRow.id = 'resend-locked-msg';
          resendRow.className = 'text-center mt-3 text-xs text-slate-500';
          resendRow.innerHTML = 'Too many wrong attempts. <button onclick="resendOTP()" class="text-blue-600 font-semibold hover:underline">Request a new code</button>.';
          btn.parentNode.insertBefore(resendRow, btn.nextSibling);
        }
        resendRow.classList.remove('hidden');
      } else {
        btn.disabled = false;
        btn.innerHTML = 'Verify &amp; Continue <i class="fa-solid fa-arrow-right ml-1"></i>';
      }
      return;
    }

    // ✅ Email verified — lock OTP step so user can't go back
    otpVerified = true;
    clearInterval(countdownInterval);
    hideStepError(2);

    // Disable the Back button on step 2 (and step 3 back will also be blocked)
    var step2BackBtn = $('step-2').querySelector('button:last-child');
    if (step2BackBtn) {
      step2BackBtn.disabled = true;
      step2BackBtn.title = 'Email already verified';
      step2BackBtn.classList.add('opacity-40', 'cursor-not-allowed');
    }

    // Disable step 3 back button
    setTimeout(function() {
      var s3back = $('btn-step3-back');
      if (s3back) {
        s3back.disabled = true;
        s3back.title = 'Email already verified — cannot return to OTP step';
        s3back.classList.add('opacity-40', 'cursor-not-allowed');
        s3back.innerHTML = '<i class="fa-solid fa-lock mr-1 text-xs"></i> Email Verified';
      }
    }, 100);

    $('step-2').classList.add('hidden');
    currentStep = 3;
    $('step-3').classList.remove('hidden');
    updateProgress(3);
    document.querySelector('.overflow-y-auto').scrollTop = 0;
    initAddrDropdowns(); // populate all address dropdowns on step 3

  } catch(e) {
    showStepError(2, 'Network error. Please try again.');
    btn.disabled = false;
    btn.innerHTML = 'Verify &amp; Continue <i class="fa-solid fa-arrow-right ml-1"></i>';
  }
}

// ═══════════════════════════════════════════════════
// OTP BOX HELPERS
// ═══════════════════════════════════════════════════
var OTP_IDS = ['o1','o2','o3','o4','o5','o6'];

function otpClearError() {
  OTP_IDS.forEach(function(id) {
    var el = $(id);
    if (el) el.classList.remove('otp-error');
  });
  hideStepError(2);
}

function otpMove(cur, prevId, nextId) {
  // Strip non-digits
  cur.value = cur.value.replace(/[^0-9]/g, '');
  otpClearError();
  if (cur.value && nextId) {
    var next = $(nextId);
    if (next) next.focus();
  }
  // Auto-submit when all 6 boxes filled
  otpCheckAutoSubmit();
}

function otpBack(e, prevId) {
  if (e.key === 'Backspace' && !e.target.value && prevId) {
    var prev = $(prevId);
    if (prev) { prev.value = ''; prev.focus(); }
  }
}

function otpPaste(e) {
  e.preventDefault();
  var pasted = (e.clipboardData || window.clipboardData).getData('text');
  // Extract only digits from the pasted string
  var digits = pasted.replace(/\D/g, '').slice(0, 6);
  if (!digits.length) return;

  // Find which box was the paste target, fill from there
  var targetId = e.target.id;
  var startIdx = OTP_IDS.indexOf(targetId);
  if (startIdx === -1) startIdx = 0;

  otpClearError();
  for (var i = 0; i < digits.length && (startIdx + i) < OTP_IDS.length; i++) {
    var box = $(OTP_IDS[startIdx + i]);
    if (box) box.value = digits[i];
  }

  // Focus last filled box (or last box if all filled)
  var lastFilled = Math.min(startIdx + digits.length - 1, OTP_IDS.length - 1);
  var focusBox = $(OTP_IDS[lastFilled]);
  if (focusBox) focusBox.focus();

  otpCheckAutoSubmit();
}

function otpCheckAutoSubmit() {
  var allFilled = OTP_IDS.every(function(id) {
    var el = $(id);
    return el && el.value.length === 1;
  });
  if (allFilled) {
    // Short delay so user sees all boxes filled before verify fires
    setTimeout(function() { verifyOTP(); }, 300);
  }
}

function otpGetValue() {
  return OTP_IDS.map(function(id) {
    var el = $(id);
    return el ? el.value : '';
  }).join('');
}

// ═══════════════════════════════════════════════════
// PROFILE PICTURE — UPLOAD & CAMERA
// ═══════════════════════════════════════════════════
// ── Photo mode: cleanly separate UI toggle from actions ─────────
function setPhotoModeUI(mode) {
  // Just updates button styles + camera panel visibility. No side effects.
  var uploadBtn   = $('btn-upload-photo');
  var cameraBtn   = $('btn-camera-photo');
  var cameraPanel = $('camera-panel');
  var active   = 'flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold bg-blue-600 text-white shadow-sm shadow-blue-200 transition-all';
  var inactive = 'flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold border border-slate-200 text-slate-600 hover:bg-slate-50 transition-all';
  if (mode === 'upload') {
    if (uploadBtn) uploadBtn.className = active;
    if (cameraBtn) cameraBtn.className = inactive;
    if (cameraPanel) cameraPanel.classList.add('hidden');
  } else {
    if (uploadBtn) uploadBtn.className = inactive;
    if (cameraBtn) cameraBtn.className = active;
    if (cameraPanel) cameraPanel.classList.remove('hidden');
  }
}

function doUploadPhoto() {
  // Stop camera if running, switch UI to upload, open file picker
  stopCamera();
  setPhotoModeUI('upload');
  var inp = $('av-input');
  if (inp) inp.click();
}

async function doCameraPhoto() {
  // Check camera availability first before changing UI
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showStepError(4, 'Your browser does not support camera access. Please upload a photo instead.');
    return;
  }
  // Test permission without committing to camera mode UI yet
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
    // Camera is available — now switch UI and show feed
    setPhotoModeUI('camera');
    var feed = $('camera-feed');
    if (feed) feed.srcObject = cameraStream;
  } catch(err) {
    var msg = (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')
      ? 'Camera permission denied. Please allow camera access in your browser settings, or upload a photo instead.'
      : 'Camera is unavailable on this device. Please upload a photo instead.';
    showStepError(4, msg);
    // Stay on upload mode — do not switch UI
    setPhotoModeUI('upload');
  }
}

function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(function(t){ t.stop(); });
    cameraStream = null;
  }
  setPhotoModeUI('upload');
}

function capturePhoto() {
  var video  = $('camera-feed');
  var canvas = $('camera-canvas');
  if (!video || !canvas) return;
  canvas.width  = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  var dataUrl = canvas.toDataURL('image/jpeg', 0.88);
  capturedPhotoData = dataUrl;
  avatarFileRef = null;  // camera capture path — no File object needed
  $('av-ph').classList.add('hidden');
  $('av-prev').src = dataUrl;
  $('av-prev').classList.remove('hidden');
  // Show thumbnail + progress info for captured photo
  var bytes = Math.round((dataUrl.length * 3) / 4);
  var wrap = $('av-progress');
  if (wrap) {
    wrap.classList.remove('hidden');
    var bar = $('av-bar');
    if (bar) { bar.style.transition='none'; bar.style.width='100%'; }
    var st = $('av-status');   if (st) st.textContent = 'Captured ✓';
    var ld = $('av-loaded');   if (ld) ld.textContent = formatBytes(bytes) + ' / ' + formatBytes(bytes);
    var sp = $('av-speed');    if (sp) sp.textContent = '';
  }
  var thumb = $('av-thumb'); var thumbImg = $('av-thumb-img');
  var thumbName = $('av-thumb-name'); var thumbSize = $('av-thumb-size');
  if (thumb && thumbImg) {
    thumbImg.src = dataUrl;
    if (thumbName) thumbName.textContent = 'Camera capture';
    if (thumbSize) thumbSize.textContent = formatBytes(bytes);
    thumb.classList.remove('hidden');
  }
  stopCamera();
  hideStepError(4);
}

function previewAvatar(event) {
  var file = event.target.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    showStepError(4, 'Image is too large. Maximum size is 5MB.');
    event.target.value = '';
    return;
  }
  hideStepError(4);
  readFileWithProgress(file, {
    wrapperId: 'av-progress',
    barId:     'av-bar',
    loadedId:  'av-loaded',
    speedId:   'av-speed',
    statusId:  'av-status',
    onDone: function(dataUrl) {
      // Store dataUrl so file-upload path uses the same reliable blob-conversion
      // path as camera capture during FormData submission
      capturedPhotoData = dataUrl;
      avatarFileRef = file;        // keep File ref as backup
      // Small circular preview (existing)
      $('av-ph').classList.add('hidden');
      $('av-prev').src = dataUrl;
      $('av-prev').classList.remove('hidden');
      // Large thumbnail card
      var thumb = $('av-thumb');
      var thumbImg = $('av-thumb-img');
      var thumbName = $('av-thumb-name');
      var thumbSize = $('av-thumb-size');
      if (thumb && thumbImg) {
        thumbImg.src = dataUrl;
        if (thumbName) thumbName.textContent = file.name.length > 28 ? file.name.slice(0,26)+'…' : file.name;
        if (thumbSize) thumbSize.textContent = formatBytes(file.size);
        thumb.classList.remove('hidden');
      }
    }
  });
}


// ═══════════════════════════════════════════════════
// UPLOAD HELPERS — real-time progress, speed, size
// ═══════════════════════════════════════════════════

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes < 1024)          return bytes + ' B';
  if (bytes < 1024 * 1024)   return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

// cfg = {
//   wrapperId   : 'av-progress' | 'id-progress'
//   loadedId    : 'av-loaded'   | 'id-loaded'    (e.g. "1.2 MB / 3.4 MB")
//   speedId     : 'av-speed'    | 'id-speed'     (e.g. "820 KB/s")
//   barId       : 'av-bar'      | 'id-bar'
//   statusId    : 'av-status'   | 'id-status'    ("Reading file…" / "Done ✓")
//   onDone      : function(dataUrl) called with result
// }
function readFileWithProgress(file, cfg) {
  var wrap = $(cfg.wrapperId);
  if (wrap) wrap.classList.remove('hidden');

  var bar      = $(cfg.barId);
  var loadedEl = $(cfg.loadedId);
  var speedEl  = $(cfg.speedId);
  var statusEl = $(cfg.statusId);

  var startTime  = Date.now();
  var lastLoaded = 0;
  var lastTime   = startTime;

  function setBar(pct) {
    if (bar) { bar.style.transition = 'width 0.1s linear'; bar.style.width = pct + '%'; }
  }
  function setStatus(txt) { if (statusEl) statusEl.textContent = txt; }
  function setLoaded(loaded, total) {
    if (loadedEl) loadedEl.textContent = formatBytes(loaded) + ' / ' + formatBytes(total);
  }
  function setSpeed(bps) {
    if (speedEl) speedEl.textContent = bps > 0 ? formatBytes(Math.round(bps)) + '/s' : '';
  }

  var reader = new FileReader();

  reader.onloadstart = function() {
    setBar(0);
    setStatus('Reading file…');
    setLoaded(0, file.size);
    setSpeed(0);
  };

  reader.onprogress = function(e) {
    if (!e.lengthComputable) return;
    var pct  = Math.round((e.loaded / e.total) * 95); // cap at 95 until done
    var now  = Date.now();
    var dt   = (now - lastTime) / 1000;  // seconds since last event
    var bps  = dt > 0 ? (e.loaded - lastLoaded) / dt : 0;
    lastLoaded = e.loaded;
    lastTime   = now;
    setBar(pct);
    setLoaded(e.loaded, e.total);
    setSpeed(bps);
  };

  reader.onload = function(e) {
    var elapsed = (Date.now() - startTime) / 1000;
    var avgSpeed = elapsed > 0 ? file.size / elapsed : file.size;
    setBar(100);
    // Turn bar green to signal completion
    if (bar) bar.style.background = 'linear-gradient(90deg,#10b981,#34d399)';
    setLoaded(file.size, file.size);
    setSpeed(avgSpeed);
    setStatus('Done ✓');
    if (speedEl) {
      // Fade out speed after 2s
      setTimeout(function() {
        if (speedEl) speedEl.style.opacity = '0';
        setTimeout(function() {
          if (speedEl) { speedEl.textContent = ''; speedEl.style.opacity = '1'; }
        }, 400);
      }, 2000);
    }
    if (cfg.onDone) cfg.onDone(e.target.result);
  };

  reader.onerror = function() {
    setStatus('Error reading file');
    if (bar) { bar.style.background = '#ef4444'; bar.style.width = '100%'; }
  };

  reader.readAsDataURL(file);
}

// ═══════════════════════════════════════════════════
// ═══════════════════════════════════════════════════
// DAMIS MULTI-ADDRESS CASCADE
// loadAddrCascade(prefix, next) — prefix: pres/perm/father/mother
// ═══════════════════════════════════════════════════
var _addrCache = {};

async function psgcFetchAddr(endpoint) {
  if (_addrCache[endpoint]) return _addrCache[endpoint];
  try {
    var r = await fetch('https://psgc.gitlab.io/api/' + endpoint + '.json');
    if (!r.ok) throw new Error('PSGC error');
    var data = await r.json();
    _addrCache[endpoint] = Array.isArray(data) ? data : [data];
    return _addrCache[endpoint];
  } catch(e) { return []; }
}

function resetAddrSelect(id, placeholder) {
  var el = $(id);
  if (!el) return;
  el.innerHTML = '<option value="">' + placeholder + '</option>';
  el.disabled = true;
}

function populateAddrSelect(id, items, placeholder) {
  var el = $(id);
  if (!el) return;
  el.innerHTML = '<option value="">' + placeholder + '</option>';
  items.sort(function(a,b){ return (a.name||'').localeCompare(b.name||''); }).forEach(function(item) {
    var o = document.createElement('option');
    o.value = item.code;
    o.textContent = item.name;
    el.appendChild(o);
  });
  el.disabled = false;
}

async function loadAddrCascade(prefix, next) {
  var regionEl   = $(prefix + '-region');
  var provinceEl = $(prefix + '-province');
  var cityEl     = $(prefix + '-city');
  var brgyEl     = $(prefix + '-brgy');

  if (next === 'province') {
    resetAddrSelect(prefix + '-province', '— Select Province —');
    resetAddrSelect(prefix + '-city',     '— Select City/Municipality —');
    resetAddrSelect(prefix + '-brgy',     '— Select Barangay —');
    if (!regionEl || !regionEl.value) return;
    var regionCode = regionEl.value;
    if (regionCode === '1300000000') {
      if (provinceEl) { provinceEl.innerHTML = '<option value="__ncr__">N/A — NCR</option>'; }
      var cities = await psgcFetchAddr('regions/' + regionCode + '/cities-municipalities');
      populateAddrSelect(prefix + '-city', cities, '— Select City —');
    } else {
      var provinces = await psgcFetchAddr('regions/' + regionCode + '/provinces');
      if (provinces.length > 0) {
        populateAddrSelect(prefix + '-province', provinces, '— Select Province —');
      } else {
        if (provinceEl) { provinceEl.innerHTML = '<option value="__none__">N/A</option>'; }
        var cities2 = await psgcFetchAddr('regions/' + regionCode + '/cities-municipalities');
        populateAddrSelect(prefix + '-city', cities2, '— Select City —');
      }
    }
  } else if (next === 'city') {
    resetAddrSelect(prefix + '-city', '— Select City/Municipality —');
    resetAddrSelect(prefix + '-brgy', '— Select Barangay —');
    if (!provinceEl) return;
    var provCode = provinceEl.value;
    if (!provCode || provCode === '__ncr__' || provCode === '__none__') return;
    var cities3 = await psgcFetchAddr('provinces/' + provCode + '/cities-municipalities');
    populateAddrSelect(prefix + '-city', cities3, '— Select City/Municipality —');
  } else if (next === 'brgy') {
    resetAddrSelect(prefix + '-brgy', '— Select Barangay —');
    if (!cityEl || !cityEl.value) return;
    var barangays = await psgcFetchAddr('cities-municipalities/' + cityEl.value + '/barangays');
    populateAddrSelect(prefix + '-brgy', barangays, '— Select Barangay —');
  }
  buildAddrString(prefix);
}

function buildAddrString(prefix) {
  function selTxt(id) {
    var el = $(id); if (!el || el.selectedIndex <= 0) return '';
    return el.options[el.selectedIndex].text.replace(/\s+\(\d{4}\)$/, '').trim();
  }
  var parts = [];
  var brgy = selTxt(prefix + '-brgy'), city = selTxt(prefix + '-city');
  var prov = selTxt(prefix + '-province'), reg = selTxt(prefix + '-region');
  if (brgy && !brgy.startsWith('—') && !brgy.startsWith('N/A')) parts.push(brgy);
  if (city) parts.push(city);
  if (prov && !prov.startsWith('N/A')) parts.push(prov);
  if (reg) parts.push(reg);
  parts.push('Philippines');
  var str = parts.join(', ');
  var hidden = $(prefix + '-addr-hidden');
  if (hidden) hidden.value = str;
}

function toggleSameAsPresent() {
  var chk = $('same-as-present');
  var fields = $('perm-addr-fields');
  if (!fields) return;
  if (chk && chk.checked) {
    fields.style.opacity = '0.4';
    fields.style.pointerEvents = 'none';
    var ph = $('perm-addr-hidden');
    if (ph) ph.value = $('pres-addr-hidden') ? $('pres-addr-hidden').value : '';
  } else {
    fields.style.opacity = '';
    fields.style.pointerEvents = '';
  }
}

// Initialize address dropdowns on page load
async function initAddrDropdowns() {
  var prefixes = ['pres', 'perm', 'father', 'mother', 'guardian'];
  var data = await psgcFetchAddr('regions');
  prefixes.forEach(function(prefix) {
    var el = $(prefix + '-region');
    if (!el) return;
    el.innerHTML = '<option value="">— Select Region —</option>';
    data.sort(function(a,b){ return (a.name||'').localeCompare(b.name||''); }).forEach(function(item) {
      var o = document.createElement('option'); o.value = item.code; o.textContent = item.name; el.appendChild(o);
    });
  });
}

// ═══════════════════════════════════════════════════
// DAMIS DOCUMENT UPLOAD (Step 5)
// ═══════════════════════════════════════════════════
window._damis_docs = {};

function handleDocFile(evt, key) {
  var file = evt.target.files && evt.target.files[0];
  if (!file) return;
  var isImage = file.type.startsWith('image/');
  var isPdf   = file.type === 'application/pdf';
  var isDocx  = file.name.toLowerCase().endsWith('.docx');
  if (!isImage && !isPdf && !isDocx) { showStepError(5, 'Accepted formats: JPG, PNG, WEBP, PDF, DOCX.'); return; }
  if (file.size > 10 * 1024 * 1024) { showStepError(5, 'File too large. Maximum 10MB per document.'); return; }
  hideStepError(5);
  window._damis_docs[key] = file;
  var def = $('doc-def-' + key), prev = $('doc-prev-' + key), fn = $('doc-fn-' + key);
  var sz  = $('doc-sz-' + key);
  var thumb = $('doc-thumb-' + key);
  if (def)  def.classList.add('hidden');
  if (prev) prev.classList.remove('hidden');
  if (fn)   fn.textContent = file.name.length > 32 ? file.name.slice(0, 30) + '\u2026' : file.name;
  // ── Show file size ───────────────────────────────
  if (sz)   sz.textContent = formatBytes(file.size);
  console.log('[DAMIS Doc] ' + key + ' uploaded: ' + file.name + ' (' + formatBytes(file.size) + ')');
  // Show thumbnail
  if (thumb) {
    thumb.innerHTML = '';
    if (isImage) {
      var reader = new FileReader();
      reader.onload = function(e) {
        var img = document.createElement('img');
        img.src = e.target.result;
        img.className = 'w-full object-contain max-h-48';
        thumb.appendChild(img);
      };
      reader.readAsDataURL(file);
    } else if (isPdf) {
      // Show embedded PDF preview with full-page open link
      var pdfObjUrl = URL.createObjectURL(file);
      thumb.dataset.pdfObjUrl = pdfObjUrl; // store for revoke on clear
      thumb.innerHTML =
        '<div style="position:relative;width:100%;height:440px;background:#f8fafc;">'
        + '<iframe src="' + pdfObjUrl + '#toolbar=0&navpanes=0&scrollbar=1&view=FitH" '
        + 'style="width:100%;height:100%;border:none;" title="' + file.name + '"></iframe>'
        + '<a href="' + pdfObjUrl + '" target="_blank" rel="noopener" '
        + 'onclick="event.stopPropagation()" '
        + 'style="position:absolute;top:8px;right:8px;background:rgba(0,0,0,0.6);color:#fff;'
        + 'font-size:11px;font-weight:700;padding:5px 11px;border-radius:7px;text-decoration:none;'
        + 'display:flex;align-items:center;gap:5px;z-index:10;box-shadow:0 2px 8px rgba(0,0,0,0.25);">'
        + '<i class="fa-solid fa-up-right-from-square" style="font-size:10px;"></i> Open Full Page</a>'
        + '</div>';
    } else if (isDocx) {
      // Convert DOCX → PDF on the server via LibreOffice for an accurate print-preview.
      // Mammoth's client-side HTML conversion drops most formatting; a server-side PDF
      // round-trip renders the document exactly as it looks when printed.
      thumb.innerHTML =
        '<div class="flex flex-col items-center justify-center py-6 gap-2 text-slate-400">'
        + '<i class="fa-solid fa-spinner fa-spin text-2xl"></i>'
        + '<p class="text-xs">Converting to PDF preview…</p>'
        + '</div>';
      (async () => {
        try {
          var arrayBuf = await file.arrayBuffer();
          var fd       = new FormData();
          fd.append('file', new Blob([arrayBuf], { type: file.type }), file.name);

          var resp = await fetch('/api/auth/convert-docx-to-pdf', { method: 'POST', body: fd });
          if (!resp.ok) {
            var errData = await resp.json().catch(function(){ return {}; });
            throw new Error(errData.error || ('Server error ' + resp.status));
          }

          var pdfBlob = await resp.blob();
          var pdfUrl  = URL.createObjectURL(pdfBlob);
          thumb.dataset.pdfObjUrl = pdfUrl; // reuse existing revoke logic in clearDocFile

          thumb.innerHTML =
            '<div style="position:relative;width:100%;height:440px;background:#f8fafc;">'
            + '<iframe src="' + pdfUrl + '#toolbar=0&navpanes=0&scrollbar=1&view=FitH" '
            + 'style="width:100%;height:100%;border:none;" title="' + file.name + '"></iframe>'
            + '<a href="' + pdfUrl + '" target="_blank" rel="noopener" '
            + 'onclick="event.stopPropagation()" '
            + 'style="position:absolute;top:8px;right:8px;background:rgba(0,0,0,0.6);color:#fff;'
            + 'font-size:11px;font-weight:700;padding:5px 11px;border-radius:7px;text-decoration:none;'
            + 'display:flex;align-items:center;gap:5px;z-index:10;box-shadow:0 2px 8px rgba(0,0,0,0.25);">'
            + '<i class="fa-solid fa-up-right-from-square" style="font-size:10px;"></i> Open Full Page</a>'
            + '</div>';

          console.log('[DAMIS Doc] ' + key + ' DOCX→PDF preview ready (' + Math.round(pdfBlob.size / 1024) + ' KB)');
        } catch (err) {
          console.error('[DAMIS Doc] DOCX→PDF error for ' + key + ':', err);
          thumb.innerHTML =
            '<div class="flex flex-col items-center justify-center py-6 gap-2">'
            + '<i class="fa-solid fa-file-word text-blue-500 text-4xl"></i>'
            + '<p class="text-sm font-semibold text-slate-600">Word Document</p>'
            + '<p class="text-xs text-slate-400">Preview unavailable — file will upload correctly.</p>'
            + '<p class="text-xs text-red-400">' + (err.message || 'Conversion error') + '</p>'
            + '</div>';
        }
      })();
    }
  }
}

function handleDocDrop(evt, key) {
  evt.preventDefault();
  var zone = $('doc-zone-' + key);
  if (zone) zone.classList.remove('drag-over');
  var file = evt.dataTransfer && evt.dataTransfer.files && evt.dataTransfer.files[0];
  if (!file) return;
  handleDocFile({ target: { files: [file] } }, key);
}

function clearDocFile(evt, key) {
  if (evt) evt.stopPropagation();
  delete window._damis_docs[key];
  var fileInput = $('doc-file-' + key), def = $('doc-def-' + key), prev = $('doc-prev-' + key);
  var thumb = $('doc-thumb-' + key);
  var sz    = $('doc-sz-' + key);
  if (fileInput) fileInput.value = '';
  if (def)  def.classList.remove('hidden');
  if (prev) prev.classList.add('hidden');
  if (sz)   sz.textContent = '';
  if (thumb) {
    if (thumb.dataset.pdfObjUrl)  { URL.revokeObjectURL(thumb.dataset.pdfObjUrl);  delete thumb.dataset.pdfObjUrl; }
    if (thumb.dataset.docxBlobUrl) { URL.revokeObjectURL(thumb.dataset.docxBlobUrl); delete thumb.dataset.docxBlobUrl; }
    thumb.innerHTML = '';
  }
  console.log('[DAMIS Doc] ' + key + ' cleared');
  hideStepError(5);
}

// ═══════════════════════════════════════════════════
// PSGC CASCADING ADDRESS
// psgc.cloud hierarchy endpoints — always correct child data
// Region → Province → City/Muni → Barangay
// NCR skips Province layer (no provinces)
// ═══════════════════════════════════════════════════

var _psgcCache = {};  // keyed by endpoint URL

async function psgcFetch(endpoint) {
  var url = 'https://psgc.cloud/api/' + endpoint;
  if (_psgcCache[url]) return _psgcCache[url];

  var loadEl = $('loc-loading');
  if (loadEl) loadEl.classList.remove('hidden');
  try {
    var res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var data = await res.json();
    _psgcCache[url] = data;
    return data;
  } catch(e) {
    console.warn('[PSGC] fetch failed:', url, e.message);
    showToast('Could not load address data. Check your connection.', 'error');
    return [];
  } finally {
    if (loadEl) loadEl.classList.add('hidden');
  }
}

function populateSelect(selId, items, placeholder, labelFn) {
  var sel = $(selId);
  if (!sel) return;
  sel.innerHTML = '<option value="">' + placeholder + '</option>';
  var sorted = items.slice().sort(function(a, b) {
    return a.name.trim().localeCompare(b.name.trim());
  });
  sorted.forEach(function(item) {
    var opt = document.createElement('option');
    opt.value = item.code;
    opt.textContent = labelFn ? labelFn(item) : item.name.trim();
    sel.appendChild(opt);
  });
  sel.disabled = false;
}

function resetSelect(selId, placeholder) {
  var sel = $(selId);
  if (!sel) return;
  sel.innerHTML = '<option value="">' + placeholder + '</option>';
  sel.disabled = true;
}

function hideSummary() {
  var s = $('loc-summary');
  if (s) s.classList.add('hidden');
}

// ── Step 1: Regions (loaded once on entering step 3) ──────────────
async function loadRegions() {
  var data = await psgcFetch('regions');
  populateSelect('loc-region', data, '— Select Region —');
  resetSelect('loc-province', '— Select Province —');
  resetSelect('loc-city',     '— Select City / Municipality —');
  resetSelect('loc-brgy',     '— Select Barangay —');
  $('reg-loc').value = '';
  hideSummary();
}

// ── Step 2: Provinces (or skip to cities for NCR) ─────────────────
async function loadProvinces() {
  var regionCode = $('loc-region').value;
  resetSelect('loc-province', '— Select Province —');
  resetSelect('loc-city',     '— Select City / Municipality —');
  resetSelect('loc-brgy',     '— Select Barangay —');
  $('reg-loc').value = '';
  hideSummary();
  if (!regionCode) return;

  // NCR (1300000000) has no provinces — jump straight to cities
  if (regionCode === '1300000000') {
    var provSel = $('loc-province');
    provSel.innerHTML = '<option value="__ncr__">N/A — NCR has no provinces</option>';
    provSel.disabled = true;
    var cities = await psgcFetch('regions/' + regionCode + '/cities-municipalities');
    populateSelect('loc-city', cities, '— Select City / Municipality —', function(c) {
      return c.name.trim();
    });
    return;
  }

  var provinces = await psgcFetch('regions/' + regionCode + '/provinces');
  if (provinces.length > 0) {
    populateSelect('loc-province', provinces, '— Select Province —');
  } else {
    // Some regions (BARMM special units) may have no provinces
    var provSel = $('loc-province');
    provSel.innerHTML = '<option value="__none__">N/A — No provinces</option>';
    provSel.disabled = true;
    var cities = await psgcFetch('regions/' + regionCode + '/cities-municipalities');
    populateSelect('loc-city', cities, '— Select City / Municipality —', function(c) {
      return c.name.trim();
    });
  }
}

// ── Step 3: Cities / Municipalities ───────────────────────────────
async function loadCities() {
  var provinceCode = $('loc-province').value;
  resetSelect('loc-city', '— Select City / Municipality —');
  resetSelect('loc-brgy', '— Select Barangay —');
  $('reg-loc').value = '';
  hideSummary();
  if (!provinceCode || provinceCode === '__ncr__' || provinceCode === '__none__') return;

  // Use hierarchy endpoint: /provinces/{code}/cities-municipalities
  // This returns ONLY the cities & municipalities in this exact province
  var cities = await psgcFetch('provinces/' + provinceCode + '/cities-municipalities');
  populateSelect('loc-city', cities, '— Select City / Municipality —', function(c) {
    return c.name.trim();
  });
}

// ── Step 4: Barangays ─────────────────────────────────────────────
async function loadBarangays() {
  var cityCode = $('loc-city').value;
  resetSelect('loc-brgy', '— Select Barangay —');
  $('reg-loc').value = '';
  hideSummary();
  if (!cityCode) return;

  // Use hierarchy endpoint: /cities-municipalities/{code}/barangays
  var barangays = await psgcFetch('cities-municipalities/' + cityCode + '/barangays');
  if (barangays.length > 0) {
    populateSelect('loc-brgy', barangays, '— Select Barangay —');
  } else {
    // NCR cities have sub-municipalities instead of direct barangays
    // Try sub-municipalities then list their barangays combined
    var submunis = await psgcFetch('cities-municipalities/' + cityCode + '/sub-municipalities');
    if (submunis.length > 0) {
      var allBrgy = [];
      for (var i = 0; i < submunis.length; i++) {
        var brgy = await psgcFetch('sub-municipalities/' + submunis[i].code + '/barangays');
        allBrgy = allBrgy.concat(brgy);
      }
      populateSelect('loc-brgy', allBrgy, '— Select Barangay —');
    } else {
      var el = $('loc-brgy');
      el.innerHTML = '<option value="">— No barangay data —</option>';
      el.disabled = false;
    }
  }
}

// ── Build final location string ────────────────────────────────────
function buildLocationString() {
  function selText(id) {
    var el = $(id);
    if (!el || el.selectedIndex <= 0) return '';
    var t = el.options[el.selectedIndex].text;
    // Strip zip code suffix added for display
    return t.replace(/\s+\(\d{4}\)$/, '').trim();
  }

  var brgy = selText('loc-brgy');
  var city = selText('loc-city');
  var prov = selText('loc-province');
  var reg  = selText('loc-region');

  var skipProv = !prov || prov.startsWith('N/A');
  var parts = [];
  if (brgy && !brgy.startsWith('—') && !brgy.startsWith('No barangay')) parts.push(brgy);
  if (city) parts.push(city);
  if (!skipProv) parts.push(prov);
  if (reg) parts.push(reg);
  parts.push('Philippines');

  var locStr = parts.join(', ');
  $('reg-loc').value = locStr;
  $('loc-summary-txt').textContent = locStr;
  $('loc-summary').classList.remove('hidden');
}

// ═══════════════════════════════════════════════════
// COMPLETE REGISTRATION (Step 5 submit button)
// ═══════════════════════════════════════════════════
async function completeRegistration() {
  var docs = window._damis_docs || {};
  if (!docs['school-id'])  { showStepError(5, 'Please upload your School ID.'); return; }
  if (!docs['residency'])  { showStepError(5, 'Please upload your Certificate of Residency.'); return; }
  if (!docs['low-income']) { showStepError(5, 'Please upload your Certificate of Low Income.'); return; }
  if (!docs['enrollment']) { showStepError(5, 'Please upload your Certificate of Enrollment.'); return; }
  if (!$('chk-terms').checked) { showStepError(5, 'You must agree to the Terms & Conditions.'); return; }

  // ── Student Residents Questionnaire (research instrument) ──────────────
  // Every statement must be answered and consent given before the
  // application can be submitted. Guarded on window.ResearchSurvey so a
  // failure to load the module never hard-blocks a dormitory application.
  var rsCheck = window.ResearchSurvey ? window.ResearchSurvey.validate() : { ok: true };
  if (!rsCheck.ok) { showStepError(5, rsCheck.message); return; }

  var btn = $('btn-complete');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner mr-2"></span> Submitting application...';

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
  }

  try {
    var phoneRaw = $('reg-phone') ? $('reg-phone').value.trim() : '';

    // Build FormData — send everything (fields + ID file) in ONE request
    var fd = new FormData();
    fd.append('firstName',  $('reg-fname').value.trim());
    fd.append('middleName', $('reg-mname') ? $('reg-mname').value.trim() : '');
    fd.append('lastName',   $('reg-lname').value.trim());
    fd.append('suffix',     $('reg-suffix') ? $('reg-suffix').value : '');
    fd.append('username',   ($('reg-uname') ? $('reg-uname').value.trim() : ''));
    fd.append('birthday',        $('reg-bday').value);
    fd.append('sex',             (document.querySelector('input[name="sex"]:checked') || {}).value || '');
    fd.append('civilStatus',     $('reg-civil') ? $('reg-civil').value : '');
    fd.append('phone',           phoneRaw);
    fd.append('bio',             $('reg-bio') ? $('reg-bio').value.trim() : '');
    fd.append('idType',          'school_id');

    // Present / Permanent address
    var permAddr = $('perm-addr-hidden') ? $('perm-addr-hidden').value : '';
    var presAddr = ($('same-as-permanent') && $('same-as-permanent').checked)
      ? permAddr
      : ($('pres-addr-hidden') ? $('pres-addr-hidden').value : '');
    fd.append('presentAddress',  presAddr);
    fd.append('permanentAddress', permAddr);
    fd.append('location',        presAddr);

    // School — either the default (readonly) value or whatever was manually typed
    fd.append('schoolName',   $('reg-school') ? $('reg-school').value.trim() : 'Aurora State College of Technology');
    fd.append('schoolAddress', $('reg-schooladdr') ? $('reg-schooladdr').value.trim() : 'Zabali, Baler, Aurora');

    // Year Level — manual text wins over the dropdown label when "Not listed" is checked
    var yearIsManual = !!($('yearlevel-manual-toggle') && $('yearlevel-manual-toggle').checked);
    var yearLevelVal = yearIsManual
      ? (($('reg-yearlevel-manual')||{}).value||'').trim()
      : ($('reg-yearlevel') ? $('reg-yearlevel').options[$('reg-yearlevel').selectedIndex].text : '');
    fd.append('yearLevel', yearLevelVal);

    // Course: if a specialization was selected, its value IS the specific course code
    // (e.g. BSIT-AP); otherwise the family key equals the code for single-track programs.
    // Manual course/specialization text (typed when "Not listed" is checked) takes priority.
    var courseIsManual = !!($('course-manual-toggle') && $('course-manual-toggle').checked);
    var specRow  = $('specialization-row');
    var specSel  = $('reg-specialization');
    var specIsManual = !!($('specialization-manual-toggle') && $('specialization-manual-toggle').checked);
    var specVal, courseVal;
    if (courseIsManual) {
      courseVal = (($('reg-course-manual')||{}).value||'').trim();
      specVal   = (($('reg-specialization-manual')||{}).value||'').trim();
    } else if (specIsManual) {
      specVal   = (($('reg-specialization-manual')||{}).value||'').trim();
      courseVal = specVal || ($('reg-course') ? $('reg-course').value : '');
    } else {
      specVal   = (specRow && !specRow.classList.contains('hidden') && specSel && specSel.value) ? specSel.value : '';
      courseVal = specVal || ($('reg-course') ? $('reg-course').value : '');
    }
    fd.append('course',         courseVal);
    fd.append('specialization', specVal);
    console.log('[REG] course=' + courseVal + ' (manual=' + courseIsManual + ') specialization=' + (specVal || '(none)'));

    // Family info — "deceased" is recorded on the JSON blob itself so the
    // shape stays identical to how the backend has always stored it; no new
    // top-level fields required. Contact/employer/address are left blank
    // when deceased (toggleParentDeceased() already clears them client-side).
    var fatherDeceased = !!($('father-deceased') && $('father-deceased').checked);
    var motherDeceased = !!($('mother-deceased') && $('mother-deceased').checked);
    var fatherInfo = JSON.stringify({
      firstName: ($('father-fname')||{}).value||'', middleName: ($('father-mname')||{}).value||'',
      lastName:  ($('father-lname')||{}).value||'', suffix:     ($('father-suffix')||{}).value||'',
      phone:     ($('father-phone')||{}).value||'', employer:   ($('father-employer')||{}).value||'',
      address:   ($('father-addr-hidden')||{}).value||'', deceased: fatherDeceased
    });
    var motherInfo = JSON.stringify({
      firstName: ($('mother-fname')||{}).value||'', middleName: ($('mother-mname')||{}).value||'',
      lastName:  ($('mother-lname')||{}).value||'', suffix:     ($('mother-suffix')||{}).value||'',
      phone:     ($('mother-phone')||{}).value||'', employer:   ($('mother-employer')||{}).value||'',
      address:   ($('mother-addr-hidden')||{}).value||'', deceased: motherDeceased
    });
    fd.append('fatherInfo',    fatherInfo);
    fd.append('motherInfo',    motherInfo);

    // Guardian info — only meaningful (and only validated) when both parents
    // are deceased, but we send it whenever present so nothing is silently lost.
    if (fatherDeceased && motherDeceased) {
      var guardianInfo = JSON.stringify({
        firstName: ($('guardian-fname')||{}).value||'', middleName: ($('guardian-mname')||{}).value||'',
        lastName:  ($('guardian-lname')||{}).value||'', suffix:     ($('guardian-suffix')||{}).value||'',
        relationship: ($('guardian-relationship')||{}).value||'',
        phone:     ($('guardian-phone')||{}).value||'', employer:   ($('guardian-employer')||{}).value||'',
        address:   ($('guardian-addr-hidden')||{}).value||''
      });
      fd.append('guardianInfo', guardianInfo);
    }
    fd.append('monthlyIncome', $('reg-income') ? $('reg-income').value : '');

    // Attach DAMIS document files
    var docFiles = window._damis_docs || {};
    if (docFiles['school-id'])  fd.append('id_front',        docFiles['school-id']);
    if (docFiles['residency'])  fd.append('cert_residency',  docFiles['residency']);
    if (docFiles['low-income']) fd.append('cert_low_income', docFiles['low-income']);
    if (docFiles['enrollment']) fd.append('cert_enrollment', docFiles['enrollment']);

    // ── Attach profile photo ──────────────────────────────────────
    // Always use the original file — the crop position is saved separately
    // as avatarFaceX/Y so admin can display the right face region via object-position.
    if (capturedPhotoData && !avatarFileRef) {
      try {
        var parts  = capturedPhotoData.split(',');
        var mime   = (parts[0].match(/:(.*?);/) || [])[1] || 'image/jpeg';
        var byteStr = atob(parts[1]);
        var ab = new Uint8Array(byteStr.length);
        for (var i = 0; i < byteStr.length; i++) ab[i] = byteStr.charCodeAt(i);
        var camBlob = new Blob([ab], { type: mime });
        fd.append('avatar', camBlob, 'avatar.jpg');
        fd.append('selfie', camBlob, 'selfie.jpg');
      } catch(camErr) {
        console.error('[Registration] Camera blob conversion failed:', camErr);
        showStepError(5, 'Could not process your profile photo. Please go back and re-upload it.');
        btn.disabled = false;
        btn.innerHTML = 'Submit Application <i class="fa-solid fa-paper-plane ml-1"></i>';
        return;
      }
    }
    // File-upload path: send original file directly
    if (avatarFileRef) {
      fd.append('avatar', avatarFileRef, avatarFileRef.name || 'avatar.jpg');
      fd.append('selfie', avatarFileRef, avatarFileRef.name || 'selfie.jpg');
    }

    // ── Face crop position (percentage of original image) ────────
    var faceX = $('avatar-face-x') ? parseFloat($('avatar-face-x').value) : 50;
    var faceY = $('avatar-face-y') ? parseFloat($('avatar-face-y').value) : 50;
    var cropX  = $('avatar-crop-x')    ? parseFloat($('avatar-crop-x').value)    : 25;
    var cropY  = $('avatar-crop-y')    ? parseFloat($('avatar-crop-y').value)    : 25;
    var cropSz = $('avatar-crop-size') ? parseFloat($('avatar-crop-size').value) : 50;
    fd.append('avatarFaceX',    isNaN(faceX) ? 50   : Math.min(100, Math.max(0, faceX)));
    fd.append('avatarFaceY',    isNaN(faceY) ? 50   : Math.min(100, Math.max(0, faceY)));
    fd.append('avatarCropX',    isNaN(cropX) ? 25   : Math.min(100, Math.max(0, cropX)));
    fd.append('avatarCropY',    isNaN(cropY) ? 25   : Math.min(100, Math.max(0, cropY)));
    fd.append('avatarCropSize', isNaN(cropSz) ? 50  : Math.min(100, Math.max(5,  cropSz)));

    // ── Diagnostic: log what we're sending ───────────────────────
    var fdKeys = [];
    try { fd.forEach(function(v,k){ fdKeys.push(k+(v instanceof File||v instanceof Blob?' [file:'+((v.size/1024).toFixed(1))+'KB]':'')); }); } catch(e){}
    var docKeys = Object.keys(window._damis_docs || {});
    console.log('[DAMIS] FormData fields:', fdKeys.join(', ') || '(empty)');
    console.log('[DAMIS] Documents uploaded:', docKeys.length ? docKeys.join(', ') : 'none');
    console.log('[DAMIS] Avatar source:', capturedPhotoData ? 'camera' : avatarFileRef ? 'file' : 'none');

    var res  = await fetch(API.COMPLETE_REG, { method: 'POST', body: fd });
    var data = await res.json();

    if (!res.ok) {
      var errMsg = data.error || 'Registration failed. Please try again.';
      var isUsernameTaken = errMsg.toLowerCase().includes('username') && errMsg.toLowerCase().includes('taken');
      var isPhoneTaken    = errMsg.toLowerCase().includes('phone') && errMsg.toLowerCase().includes('registered');
      if (isUsernameTaken || isPhoneTaken) {
        $('step-5').classList.add('hidden');
        $('step-3').classList.remove('hidden');
        currentStep = 3;
        updateProgress(3);
        if (isUsernameTaken) {
          var unameEl = $('reg-uname'); // field removed; username auto-generated
          if (unameEl) { unameEl.classList.add('is-error'); }
          var unameMsg = $('uname-status-msg');
          if (unameMsg) { unameMsg.textContent = errMsg; unameMsg.style.color = '#ef4444'; }
          var unameIcon = $('uname-status-icon');
          if (unameIcon) { unameIcon.textContent = '\u2717'; unameIcon.style.color = '#ef4444'; unameIcon.classList.remove('hidden'); }
          usernameAvailableStatus = false;
          usernameLastChecked = ($('reg-uname') || {}).value || '';
          showStepError(3, errMsg);
          if (unameEl) unameEl.focus();
        }
        if (isPhoneTaken) {
          var phoneEl = $('reg-phone');
          if (phoneEl) { phoneEl.classList.add('is-error'); }
          var phoneErr = $('phone-err-msg');
          if (phoneErr) { phoneErr.textContent = errMsg; phoneErr.style.color = ''; phoneErr.classList.remove('hidden'); }
          phoneAvailableStatus = false;
          phoneLastChecked = $('reg-phone') ? $('reg-phone').value.replace(/\D/g,'') : '';
          showStepError(3, errMsg);
          if (phoneEl) phoneEl.focus();
        }
      } else {
        showStepError(5, errMsg);
      }
      btn.disabled = false;
      btn.innerHTML = 'Submit Application <i class="fa-solid fa-paper-plane ml-1"></i>';
      return;
    }

    hideStepError(5);
    $('step-5').classList.add('hidden');
    $('step-ok').classList.remove('hidden');
    $('prog-bar').style.width = '100%';
    $('prog-bar').style.background = '#f59e0b';
    // Show the email address in the confirmation screen
    var confirmEmail = $('reg-confirm-email');
    if (confirmEmail) {
      var emailEl = $('reg-email') || $('reg-email-display');
      confirmEmail.textContent = emailEl ? emailEl.value.trim() : '';
    }
    showToast('Registration submitted! Check your email for next steps. ⏳');

  } catch(e) {
    console.error('completeRegistration error:', e);
    showStepError(5, 'Something went wrong. Please try again.');
    btn.disabled = false;
    btn.innerHTML = 'Submit Application <i class="fa-solid fa-paper-plane ml-1"></i>';
  }
}

// ═══════════════════════════════════════════════════
// ID DROP ZONE
// ═══════════════════════════════════════════════════
function processIdFile(file) {
  if (!file) return;
  // Only accept image files — PDFs not accepted for ID verification
  if (!file.type.startsWith('image/')) {
    showStepError(5, 'Only image files (JPG, PNG, WEBP, HEIC) are accepted. PDFs are not allowed for ID verification.');
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    showStepError(5, 'ID file is too large. Maximum size is 10MB.');
    return;
  }
  hideStepError(5);
  readFileWithProgress(file, {
    wrapperId: 'id-progress',
    barId:     'id-bar',
    loadedId:  'id-loaded',
    speedId:   'id-speed',
    statusId:  'id-status',
    onDone: function(dataUrl) {
      // Compact drop-zone confirmed state
      $('id-def').classList.add('hidden');
      $('id-prev').classList.remove('hidden');
      var fn = $('id-fn');
      if (fn) fn.textContent = file.name.length > 28 ? file.name.slice(0,26)+'\u2026' : file.name;
      var sz = $('id-file-size');
      if (sz) sz.textContent = '\u2713 Ready \u00b7 ' + formatBytes(file.size);
      // Large thumbnail card — always an image now
      var thumb    = $('id-thumb');
      var thumbImg = $('id-thumb-img');
      var thumbPdf = $('id-thumb-pdf');
      var thumbName = $('id-thumb-name');
      var thumbSize = $('id-thumb-size');
      if (thumb) {
        var label = file.name.length > 28 ? file.name.slice(0,26)+'\u2026' : file.name;
        if (thumbName) thumbName.textContent = label;
        if (thumbSize) thumbSize.textContent = formatBytes(file.size);
        if (thumbImg) { thumbImg.src = dataUrl; thumbImg.classList.remove('hidden'); }
        if (thumbPdf) thumbPdf.classList.add('hidden');
        thumb.classList.remove('hidden');
      }
    }
  });
}
function handleIdFile(event) {
  var file = event.target.files[0];
  if (file) idFileRef = file;
  processIdFile(file);
}
function handleIdDrop(event) {
  event.preventDefault();
  $('id-zone').classList.remove('drag-over');
  var file = event.dataTransfer.files[0];
  if (!file) return;
  idFileRef = file;  // store reference reliably
  try { var dt = new DataTransfer(); dt.items.add(file); $('id-file').files = dt.files; } catch(e) {}
  processIdFile(file);
}
function clearIdFile(event) {
  event.stopPropagation();
  idFileRef = null;
  $('id-prev').classList.add('hidden');
  $('id-def').classList.remove('hidden');
  $('id-file').value = '';
  var wrap = $('id-progress'); if (wrap) wrap.classList.add('hidden');
  var bar  = $('id-bar');      if (bar)  { bar.style.width='0%'; bar.style.background=''; }
  var st   = $('id-status');   if (st)   st.textContent = 'Reading file\u2026';
  var ld   = $('id-loaded');   if (ld)   ld.textContent = '';
  var sp   = $('id-speed');    if (sp)   sp.textContent = '';
  var thumb = $('id-thumb');   if (thumb) thumb.classList.add('hidden');
}

// ═══════════════════════════════════════════════════
// TERMS MODAL
// ═══════════════════════════════════════════════════
function openTerms()  { var m=$('terms-modal'); m.classList.remove('hidden'); m.classList.add('flex'); }
function closeTerms() { var m=$('terms-modal'); m.classList.add('hidden'); m.classList.remove('flex'); }
function acceptTerms(){ $('chk-terms').checked = true; closeTerms(); showToast('Terms accepted!'); }

// ═══════════════════════════════════════════════════
// LIGHTBOX — full-screen image viewer
// ═══════════════════════════════════════════════════
function openLightbox(imgId, nameId, sizeId) {
  var img  = $(imgId);
  var name = $(nameId);
  var size = $(sizeId);
  if (!img || !img.src || img.classList.contains('hidden')) return;
  var lb = $('lightbox');
  var lbImg = $('lb-img');
  var lbName = $('lb-name');
  var lbSize = $('lb-size');
  lbImg.src = img.src;
  if (lbName) lbName.textContent = name ? name.textContent : '';
  if (lbSize) lbSize.textContent = size ? size.textContent : '';
  lb.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}
function closeLightbox(e) {
  // Only close if clicking the backdrop (not the image itself)
  if (e && e.target.id === 'lb-img') return;
  closeLightboxBtn();
}
function closeLightboxBtn() {
  $('lightbox').classList.add('hidden');
  document.body.style.overflow = '';
}
// Escape key closes lightbox
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    if (!$('lightbox').classList.contains('hidden')) closeLightboxBtn();
    if (!$('panel-forgot').classList.contains('hidden')) hideForgot();
  }
});

// ═══════════════════════════════════════════════════
// FORGOT PASSWORD
// ═══════════════════════════════════════════════════
var fpEmail = '';  // holds email across forgot-password sub-steps

function showForgot() {
  fpEmail = '';
  $('fp-email').value = $('login-email').value.trim(); // pre-fill from login
  $('fp-email-err').classList.add('hidden');
  ['fp-email-step','fp-otp-step','fp-pass-step','fp-done-step'].forEach(function(id) {
    var el = $(id); if (el) el.classList.add('hidden');
  });
  $('fp-email-step').classList.remove('hidden');
  $('panel-forgot').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  setTimeout(function() { $('fp-email').focus(); }, 100);
}

function hideForgot() {
  $('panel-forgot').classList.add('hidden');
  document.body.style.overflow = '';
}

function fpShowStep(stepId) {
  ['fp-email-step','fp-otp-step','fp-pass-step','fp-done-step'].forEach(function(id) {
    var el = $(id); if (el) el.classList.add('hidden');
  });
  var el = $(stepId); if (el) el.classList.remove('hidden');
}

function fpShowErr(errId, msg) {
  var el = $(errId); if (!el) return;
  el.querySelector('span').textContent = msg;
  el.classList.remove('hidden');
}
function fpHideErr(errId) {
  var el = $(errId); if (el) el.classList.add('hidden');
}

// ── Step 1: send OTP to email ─────────────────────
async function sendResetOTP() {
  var email = $('fp-email').value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    fpShowErr('fp-email-err', 'Please enter a valid email address.'); return;
  }
  fpHideErr('fp-email-err');
  var btn = $('fp-email-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner mr-2"></span> Sending…';
  try {
    var res  = await fetch(API.FORGOT_PASS, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email }) });
    var data = await res.json();
    if (!res.ok) {
      // 400 = Google account or validation error — these we CAN reveal
      fpShowErr('fp-email-err', data.error || 'Could not send reset code. Please try again.');
      btn.disabled = false;
      btn.innerHTML = 'Send Reset Code <i class="fa-solid fa-arrow-right ml-1"></i>';
      return;
    }
    // 200 — always advance to OTP step regardless of whether email exists
    // The server only sends a code if the account exists; we never reveal which
    fpEmail = email;
    $('fp-otp-email').textContent = email;
    // Clear OTP boxes
    ['ro1','ro2','ro3','ro4','ro5','ro6'].forEach(function(id) {
      var el = $(id); if (el) { el.value = ''; el.classList.remove('otp-error'); el.disabled = false; el.classList.remove('opacity-50'); }
    });
    fpHideErr('fp-otp-err');
    // Start resend countdown
    fpStartResendCountdown();
    fpShowStep('fp-otp-step');
    setTimeout(function() { $('ro1').focus(); }, 100);
  } catch(e) {
    fpShowErr('fp-email-err', 'Network error. Please try again.');
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Send Reset Code <i class="fa-solid fa-arrow-right ml-1"></i>';
  }
}

// Resend countdown for forgot-password OTP
var fpResendInterval = null;
function fpStartResendCountdown() {
  var timerEl  = $('fp-resend-timer');
  var resendEl = $('fp-resend-btn');
  var cdEl     = $('fp-resend-cd');
  if (!timerEl || !resendEl || !cdEl) return;
  clearInterval(fpResendInterval);
  var secs = 60;
  timerEl.classList.remove('hidden');
  resendEl.classList.add('hidden');
  cdEl.textContent = secs;
  fpResendInterval = setInterval(function() {
    secs--;
    cdEl.textContent = secs;
    if (secs <= 0) {
      clearInterval(fpResendInterval);
      timerEl.classList.add('hidden');
      resendEl.classList.remove('hidden');
    }
  }, 1000);
}

async function fpResendCode() {
  var btn = $('fp-resend-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  try {
    var res  = await fetch(API.FORGOT_PASS, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email: fpEmail }) });
    if (res.ok) {
      ['ro1','ro2','ro3','ro4','ro5','ro6'].forEach(function(id) {
        var el=$(id); if(el){ el.value=''; el.classList.remove('otp-error','opacity-50'); el.disabled=false; }
      });
      fpHideErr('fp-otp-err');
      fpStartResendCountdown();
      showToast('Reset code resent to ' + fpEmail);
      setTimeout(function(){ $('ro1').focus(); }, 100);
    } else {
      var d = await res.json();
      fpShowErr('fp-otp-err', d.error || 'Could not resend code. Please try again.');
    }
  } catch(e) {
    fpShowErr('fp-otp-err', 'Network error. Please try again.');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Resend Code'; }
  }
}

function fpBackToEmail() {
  fpHideErr('fp-email-err');
  fpShowStep('fp-email-step');
  setTimeout(function() { $('fp-email').focus(); }, 100);
}

// ── Step 2: verify reset OTP ──────────────────────
var RESET_OTP_IDS = ['ro1','ro2','ro3','ro4','ro5','ro6'];

function resetOtpMove(cur, prevId, nextId) {
  cur.value = cur.value.replace(/[^0-9]/g, '');
  fpHideErr('fp-otp-err');
  RESET_OTP_IDS.forEach(function(id){ var el=$(id); if(el) el.classList.remove('otp-error'); });
  if (cur.value && nextId) { var n=$(nextId); if(n) n.focus(); }
  var allFilled = RESET_OTP_IDS.every(function(id){ var el=$(id); return el && el.value.length===1; });
  if (allFilled) setTimeout(verifyResetOTPCode, 300);
}
function resetOtpBack(e, prevId) {
  if (e.key==='Backspace' && !e.target.value && prevId) { var p=$(prevId); if(p){p.value='';p.focus();} }
}
function resetOtpPaste(e) {
  e.preventDefault();
  var digits = (e.clipboardData||window.clipboardData).getData('text').replace(/\D/g,'').slice(0,6);
  if (!digits.length) return;
  var startIdx = RESET_OTP_IDS.indexOf(e.target.id);
  if (startIdx === -1) startIdx = 0;
  RESET_OTP_IDS.forEach(function(id){ var el=$(id); if(el) el.classList.remove('otp-error'); });
  for (var i=0; i<digits.length && (startIdx+i)<RESET_OTP_IDS.length; i++) {
    var box=$(RESET_OTP_IDS[startIdx+i]); if(box) box.value=digits[i];
  }
  var last = Math.min(startIdx+digits.length-1, RESET_OTP_IDS.length-1);
  var fb=$(RESET_OTP_IDS[last]); if(fb) fb.focus();
  var allFilled = RESET_OTP_IDS.every(function(id){ var el=$(id); return el && el.value.length===1; });
  if (allFilled) setTimeout(verifyResetOTPCode, 300);
}

async function verifyResetOTPCode() {
  var otp = RESET_OTP_IDS.map(function(id){ var el=$(id); return el?el.value:''; }).join('');
  if (otp.length < 6) {
    fpShowErr('fp-otp-err', 'Please enter all 6 digits.'); return;
  }
  var btn = $('fp-otp-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner mr-2"></span> Verifying…';
  try {
    var res  = await fetch(API.VERIFY_RESET, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email: fpEmail, otp }) });
    var data = await res.json();
    if (!res.ok) {
      var fpErrMsg = data.error || 'Incorrect code. Please try again.';
      RESET_OTP_IDS.forEach(function(id){ var el=$(id); if(el) el.classList.add('otp-error'); });
      setTimeout(function(){ RESET_OTP_IDS.forEach(function(id){ var el=$(id); if(el) el.classList.remove('otp-error'); }); }, 1500);
      fpShowErr('fp-otp-err', fpErrMsg);

      var fpLocked = fpErrMsg.toLowerCase().includes('too many') || fpErrMsg.toLowerCase().includes('new code');
      if (fpLocked) {
        clearInterval(fpResendInterval);
        RESET_OTP_IDS.forEach(function(id){ var el=$(id); if(el){ el.disabled=true; el.classList.add('opacity-50'); } });
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-lock mr-2"></i> Code Locked';
        // Show resend immediately
        var timerEl = $('fp-resend-timer'); if(timerEl) timerEl.classList.add('hidden');
        var resendEl = $('fp-resend-btn'); if(resendEl) resendEl.classList.remove('hidden');
      } else {
        btn.disabled = false;
        btn.innerHTML = 'Verify Code <i class="fa-solid fa-arrow-right ml-1"></i>';
      }
      return;
    }
    // Move to new password step — reset all state
    $('fp-pass1').value = '';
    $('fp-pass2').value = '';
    var fpMatchMsg = $('fp-match-msg'); if (fpMatchMsg) fpMatchMsg.textContent = '';
    // Reset rule checklist to 'bad' state
    ['fp-req-len','fp-req-upper','fp-req-lower','fp-req-num','fp-req-sym','fp-req-ns'].forEach(function(id){
      var el=$(id); if(!el) return;
      el.classList.remove('ok'); el.classList.add('bad');
      el.querySelector('i').className = 'fa-solid fa-circle-dot text-[10px]';
    });
    for (var si=1;si<=4;si++){ var s=$('fp-seg'+si); if(s) s.style.background='#e2e8f0'; }
    var fpLbl=$('fp-str-lbl'); if(fpLbl) fpLbl.textContent='';
    fpHideErr('fp-pass-err');
    fpShowStep('fp-pass-step');
    setTimeout(function() { $('fp-pass1').focus(); }, 100);
  } catch(e) {
    fpShowErr('fp-otp-err', 'Network error. Please try again.');
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Verify Code <i class="fa-solid fa-arrow-right ml-1"></i>';
  }
}

// ── Step 3: set new password ──────────────────────
// Full PASSWORD_RULES-based evaluator for forgot-password new password step
// Uses fp- prefixed element IDs to avoid conflict with registration step 1
const FP_PASSWORD_RULES = [
  { id: 'fp-req-len',   test: function(p){ return p.length >= 8; } },
  { id: 'fp-req-upper', test: function(p){ return /[A-Z]/.test(p); } },
  { id: 'fp-req-lower', test: function(p){ return /[a-z]/.test(p); } },
  { id: 'fp-req-num',   test: function(p){ return /[0-9]/.test(p); } },
  { id: 'fp-req-sym',   test: function(p){ return /[^A-Za-z0-9]/.test(p); } },
  { id: 'fp-req-ns',    test: function(p){ return !/\s/.test(p) && p.length > 0; } },
];

function evalResetPass(val) {
  var score = 0;
  FP_PASSWORD_RULES.forEach(function(rule) {
    var ok = rule.test(val);
    var el = $(rule.id);
    if (!el) return;
    el.classList.toggle('ok', ok);
    el.classList.toggle('bad', !ok);
    el.querySelector('i').className = ok ? 'fa-solid fa-circle-check text-[10px]' : 'fa-solid fa-circle-dot text-[10px]';
    if (ok && FP_PASSWORD_RULES.indexOf(rule) < 4) score++;
  });
  for (var i = 1; i <= 4; i++) {
    var seg = $('fp-seg' + i);
    if (seg) seg.style.background = i <= score ? SEG_COLORS[score - 1] : '#e2e8f0';
  }
  var lbl = $('fp-str-lbl');
  if (lbl) { lbl.textContent = val.length ? STR_LABELS[score] : ''; lbl.style.color = STR_TW[score] || '#94a3b8'; }
  fpCheckMatch();
}

function fpCheckMatch() {
  var p1  = $('fp-pass1').value;
  var p2  = $('fp-pass2').value;
  var msg = $('fp-match-msg');
  if (!msg) return;
  if (!p2) { msg.textContent = ''; return; }
  if (p1 === p2) { msg.textContent = '\u2713 Passwords match'; msg.style.color = '#10b981'; $('fp-pass2').classList.remove('is-error'); }
  else           { msg.textContent = '\u2717 Passwords do not match'; msg.style.color = '#ef4444'; $('fp-pass2').classList.add('is-error'); }
}

async function submitResetPassword() {
  var pass1 = $('fp-pass1').value;
  var pass2 = $('fp-pass2').value;
  // Must meet all 6 rules
  var failed = FP_PASSWORD_RULES.filter(function(r){ return !r.test(pass1); });
  if (failed.length) {
    fpShowErr('fp-pass-err', 'Your password must meet all 6 requirements listed above.'); return;
  }
  if (pass1 !== pass2) {
    fpShowErr('fp-pass-err', 'Passwords do not match.'); return;
  }
  fpHideErr('fp-pass-err');
  var btn = $('fp-pass-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner mr-2"></span> Updating…';
  try {
    var res  = await fetch(API.RESET_PASS, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email: fpEmail, password: pass1 }) });
    var data = await res.json();
    if (!res.ok) {
      fpShowErr('fp-pass-err', data.error || 'Could not update password. Please try again.');
      btn.disabled = false;
      btn.innerHTML = 'Update Password <i class="fa-solid fa-check ml-1"></i>';
      return;
    }
    // Auto-fill login email and show success
    $('login-email').value = fpEmail;
    fpShowStep('fp-done-step');
  } catch(e) {
    fpShowErr('fp-pass-err', 'Network error. Please try again.');
    btn.disabled = false;
    btn.innerHTML = 'Update Password <i class="fa-solid fa-check ml-1"></i>';
  }
}

// ═══════════════════════════════════════════════════
// LOGIN
// ═══════════════════════════════════════════════════
async function handleLogin() {
  var email = $('login-email').value.trim();
  var pass  = $('login-pass').value;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showLoginError('Please enter a valid email address.'); return; }
  if (!pass) { showLoginError('Password cannot be empty.'); return; }

  var btn = $('btn-login');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner mr-2"></span> Signing in...';

  try {
    var res  = await fetch(API.LOGIN, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email: email, password: pass }) });
    var data = await res.json();

    if (!res.ok) {
      var errMsg = data.error || 'Invalid credentials.';
      // Special visual treatment for pending/rejected accounts
      if (data.code === 'ACCOUNT_PENDING') {
        showLoginError('⏳ ' + errMsg);
      } else if (data.code === 'ACCOUNT_REJECTED') {
        showLoginError('🚫 ' + errMsg);
      } else if (data.code === 'NO_PASSWORD') {
        // Account was restored from rejection — no password on file yet. Auto-open forgot-password.
        showLoginError('🔑 ' + errMsg);
        var fpEmailInput = $('fp-email');
        if (fpEmailInput) fpEmailInput.value = email;
        setTimeout(function(){ showForgot(); }, 800);
      } else {
        showLoginError(errMsg);
      }
      // 429 = account locked — keep button disabled, show countdown
      if (res.status === 429) {
        btn.innerHTML = '<i class="fa-solid fa-lock mr-2"></i> Account Locked';
        btn.classList.add('bg-red-500', 'hover:bg-red-500');
        // Re-enable after 15 minutes
        setTimeout(function() {
          btn.disabled = false;
          btn.textContent = 'Sign In';
          btn.classList.remove('bg-red-500', 'hover:bg-red-500');
          showLoginError('');
          $('login-err').classList.add('hidden');
        }, 15 * 60 * 1000);
      } else {
        btn.disabled = false;
        btn.textContent = 'Sign In';
      }
      return;
    }

    showToast('Welcome back, ' + data.user.firstName + '! 👋');
    btn.innerHTML = '✓ Success! Redirecting...';
    // [TESTING] Admins go directly to admin panel
    var dest = (data.user && data.user.role === 'admin') ? '/admin.html' : '/feed.html';
    setTimeout(function(){ window.location.href = dest; }, 1200);

  } catch(e) {
    showLoginError('Network error. Please check your connection.');
    btn.disabled = false; btn.textContent = 'Sign In';
  }
}

function showLoginError(msg) {
  var b = $('login-err');
  $('login-err-txt').textContent = msg;
  b.classList.remove('hidden');
  b.classList.add('anim-shake');
  setTimeout(function(){ b.classList.remove('anim-shake'); }, 500);
}

// ═══════════════════════════════════════════════════
// GOOGLE AUTH
// ═══════════════════════════════════════════════════
function handleGoogleAuth(intent) {
  sessionStorage.setItem('googleIntent', intent || 'login');
  window.location.href = API.GOOGLE;
}

// ═══════════════════════════════════════════════════
// URL PARAMS — handle Google OAuth redirect
// ═══════════════════════════════════════════════════
async function checkUrlParams() {
  var params = new URLSearchParams(window.location.search);
  window.history.replaceState({}, '', '/');

  if (params.get('unauthorized') === 'admin') {
    showTab('login');
    showLoginError('Admin access only. Please log in with an admin account.');
    return;
  }

  if (params.get('login') === 'google') {
    showToast('Signed in with Google! 👋');
    setTimeout(function(){ window.location.href = '/feed.html'; }, 1200);
    return;
  }

  if (params.get('error') === 'google_failed') {
    showTab('login');
    showLoginError('Google sign-in failed. Please try again.');
    return;
  }

  if (params.get('error') === 'google_email_taken') {
    var email = decodeURIComponent(params.get('email') || '');
    showTab('login');
    showLoginError(email
      ? email + ' already has an account with a password. Please log in with your email and password below.'
      : 'That Google account email is already registered. Please log in with your password.');
    if (email) $('login-email').value = email;
    return;
  }

  if (params.get('error') === 'google_pending') {
    showTab('login');
    showLoginError('Your account is pending admin approval. You will be notified by email once it is reviewed.');
    return;
  }

  if (params.get('error') === 'google_rejected') {
    showTab('login');
    showLoginError('Your account registration was not approved. Please contact support.');
    return;
  }

  if (params.get('error') === 'google_suspended') {
    showTab('login');
    showLoginError('Your account has been suspended. Please contact support.');
    return;
  }

  if (params.get('google') === 'pending_signup') {
    try {
      var res  = await fetch(API.PENDING_GOOGLE);
      var data = await res.json();

      if (data.pending) {
        isGoogleSignup = true;
        showTab('signup');

        var emailInput = $('reg-email');
        emailInput.value    = data.email;
        emailInput.readOnly = true;
        emailInput.style.background = '#eff6ff';
        emailInput.style.color = '#1d4ed8';
        emailInput.style.fontWeight = '600';

        $('google-banner-email').textContent = data.email;
        $('google-banner').classList.remove('hidden');
        $('pass-fields').classList.add('hidden');
        $('btn-google-signup').classList.add('hidden');

        showToast('Google account recognised. Please complete your registration.', 'info');
      } else {
        showTab('login');
        showLoginError('Google session expired. Please try signing up again.');
      }
    } catch(e) {
      showTab('login');
      showLoginError('Something went wrong. Please try again.');
    }
    return;
  }
}

// ═══════════════════════════════════════════════════
// BIRTHDAY SETUP
// ═══════════════════════════════════════════════════
function setupBirthdayField() {
  var bd = $('reg-bday');
  if (!bd) return;
  var now = new Date();
  bd.max = new Date(now.getFullYear()-13, now.getMonth(), now.getDate()).toISOString().split('T')[0];
  bd.min = new Date(now.getFullYear()-120, now.getMonth(), now.getDate()).toISOString().split('T')[0];
  bd.addEventListener('change', function(){
    var msg = $('age-msg');
    var age = Math.floor((Date.now() - new Date(this.value)) / (365.25*24*3600*1000));
    if (age < 13) { msg.textContent = '⚠ Must be at least 13 years old.'; msg.style.color = '#ef4444'; }
    else          { msg.textContent = '✓ Age confirmed: ' + age + ' years old'; msg.style.color = '#10b981'; }
  });
}

// ═══════════════════════════════════════════════════
// KEYBOARD SHORTCUTS
// ═══════════════════════════════════════════════════
document.addEventListener('keydown', function(e){
  if (e.key === 'Escape') closeTerms();
  if (e.key === 'Enter' && !$('panel-login').classList.contains('hidden')) handleLogin();
});

// ═══════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════
// ── Contact Support — AI live chat widget (no login required) ──────────
var _supportHistory = [];
var _supportOpen = false;
var _supportRetryAt = 0;    // timestamp when rate-limit window ends (survives close/reopen)
var _supportCountdown = null; // active countdown interval

function showSupportInfo() {
  if (_supportOpen) return;
  _supportOpen = true;
  _supportHistory = [];

  const adminEmail = 'rutherfordc.arana@gmail.com';

  const overlay = document.createElement('div');
  overlay.id = 'support-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.5);display:flex;align-items:flex-end;justify-content:center;padding:12px;backdrop-filter:blur(6px)';
  overlay.innerHTML = `
    <div id="support-box" style="background:#fff;border-radius:20px 20px 16px 16px;width:100%;max-width:420px;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 32px 80px rgba(0,0,0,.4);overflow:hidden;animation:supportSlideUp .25s ease">
      <style>
        @keyframes supportSlideUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
        #support-msgs::-webkit-scrollbar{width:4px}
        #support-msgs::-webkit-scrollbar-thumb{background:#cbd5e1;border-radius:2px}
      </style>
      <!-- Header -->
      <div style="background:linear-gradient(135deg,#0f172a 0%,#1e3a5f 60%,#0070e0 100%);padding:16px 18px;display:flex;align-items:center;gap:12px;flex-shrink:0;position:relative">
        <div style="position:relative;flex-shrink:0">
          <div style="width:44px;height:44px;background:linear-gradient(135deg,#3b82f6,#06b6d4);border-radius:14px;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(59,130,246,.4)">
            <i class="fa-solid fa-robot" style="color:#fff;font-size:20px"></i>
          </div>
          <div style="position:absolute;bottom:1px;right:1px;width:10px;height:10px;background:#22c55e;border:2px solid #0f172a;border-radius:50%"></div>
        </div>
        <div style="flex:1;min-width:0">
          <p style="font-weight:800;font-size:15px;color:#fff;margin:0;letter-spacing:-.2px">PGA-DAMIS Support</p>
          <p id="support-subtitle" style="font-size:11px;color:rgba(255,255,255,.65);margin:0;margin-top:1px">🟢 Online · AI-powered</p>
        </div>
        <button onclick="clearSupportChat()" title="Clear chat" style="background:rgba(255,255,255,.1);border:none;color:rgba(255,255,255,.7);width:30px;height:30px;border-radius:8px;cursor:pointer;font-size:12px;margin-right:4px;display:flex;align-items:center;justify-content:center;transition:background .15s" onmouseover="this.style.background='rgba(255,255,255,.2)'" onmouseout="this.style.background='rgba(255,255,255,.1)'">🗑</button>
        <button onclick="closeSupportChat()" style="background:rgba(255,255,255,.1);border:none;color:rgba(255,255,255,.85);width:30px;height:30px;border-radius:50%;cursor:pointer;font-size:17px;display:flex;align-items:center;justify-content:center;line-height:1;transition:background .15s" onmouseover="this.style.background='rgba(255,255,255,.2)'" onmouseout="this.style.background='rgba(255,255,255,.1)'">✕</button>
      </div>
      <!-- Quick replies -->
      <div id="support-quick-replies" style="padding:10px 14px 0;display:flex;gap:6px;flex-wrap:wrap;flex-shrink:0">
        <button onclick="quickReply('I cannot log in')" style="background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;border-radius:20px;padding:5px 11px;font-size:11.5px;font-weight:600;cursor:pointer;white-space:nowrap">Can't log in</button>
        <button onclick="quickReply('How do I register?')" style="background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;border-radius:20px;padding:5px 11px;font-size:11.5px;font-weight:600;cursor:pointer;white-space:nowrap">How to register</button>
        <button onclick="quickReply('My account is pending')" style="background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;border-radius:20px;padding:5px 11px;font-size:11.5px;font-weight:600;cursor:pointer;white-space:nowrap">Account pending</button>
        <button onclick="quickReply('I forgot my password')" style="background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;border-radius:20px;padding:5px 11px;font-size:11.5px;font-weight:600;cursor:pointer;white-space:nowrap">Forgot password</button>
      </div>
      <!-- Messages -->
      <div id="support-msgs" style="flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:10px;min-height:160px;max-height:340px">
        <div style="background:#f1f5f9;border-radius:16px 16px 16px 4px;padding:12px 14px;font-size:13.5px;color:#334155;max-width:88%;line-height:1.6">
          👋 Hi! I'm the PGA-DAMIS AI assistant.<br><br>I can help with <strong>login issues</strong>, <strong>registration</strong>, <strong>account questions</strong>, and more. What can I help you with today?
        </div>
      </div>
      <!-- Escalation banner -->
      <div id="support-escalate" style="display:none;background:#fef3c7;border-top:1px solid #fde68a;padding:10px 16px;font-size:12px;color:#92400e;flex-shrink:0">
        <div style="margin-bottom:6px"><i class="fa-solid fa-envelope" style="margin-right:4px"></i> Need more help? Email: <a href="mailto:${adminEmail}" style="font-weight:700;color:#b45309">${adminEmail}</a></div>
        <div id="support-contact-area">
          <button onclick="showSupportContactForm()" style="display:inline-flex;align-items:center;gap:6px;background:#b45309;color:#fff;border:none;cursor:pointer;padding:6px 14px;border-radius:8px;font-weight:700;font-size:11px">
            <i class="fa-solid fa-paper-plane"></i> Send Message to Admin
          </button>
        </div>
      </div>
      <!-- Input -->
      <div style="border-top:1px solid #e2e8f0;padding:10px 12px;display:flex;flex-direction:column;gap:6px;flex-shrink:0;background:#fafafa">
        <div style="display:flex;gap:8px;align-items:flex-end">
          <textarea id="support-input" rows="1" placeholder="Type your message… (Enter to send)"
            style="flex:1;border:1.5px solid #e2e8f0;border-radius:14px;padding:9px 12px;font-size:13.5px;font-family:inherit;resize:none;outline:none;background:#fff;color:#0f172a;line-height:1.45;max-height:90px;transition:border-color .15s"
            onfocus="this.style.borderColor='#3b82f6'"
            onblur="this.style.borderColor='#e2e8f0'"
            onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendSupportMsg();}"
            oninput="this.style.height='auto';this.style.height=Math.min(this.scrollHeight,90)+'px';updateSupportCharCount(this.value.length)"></textarea>
          <button onclick="sendSupportMsg()" id="support-send-btn"
            style="background:linear-gradient(135deg,#3b82f6,#0070e0);color:#fff;border:none;border-radius:12px;width:40px;height:40px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 2px 8px rgba(59,130,246,.35);transition:opacity .15s"
            onmouseover="this.style.opacity='.85'" onmouseout="this.style.opacity='1'">
            <i class="fa-solid fa-paper-plane" style="font-size:14px"></i>
          </button>
        </div>
        <div style="display:flex;justify-content:space-between;padding:0 2px">
          <span style="font-size:10px;color:#94a3b8">Press <kbd style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:4px;padding:1px 4px;font-size:9px">Enter</kbd> to send · <kbd style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:4px;padding:1px 4px;font-size:9px">Shift+Enter</kbd> for new line</span>
          <span id="support-char-count" style="font-size:10px;color:#94a3b8">0/300</span>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  // Load usage counter
  fetch('/api/auth/support-status').then(r=>r.json()).then(u=>updateSupportUsageUI(u)).catch(()=>{});
  // If rate-limit is still active from before close, re-apply countdown immediately
  const msLeft = _supportRetryAt - Date.now();
  if (msLeft > 0) {
    applySupportCountdown(Math.ceil(msLeft / 1000));
  } else {
    setTimeout(() => { const inp = document.getElementById('support-input'); if(inp) inp.focus(); }, 100);
  }
}

function updateSupportUsageUI(u) {
  if (!u) return;
  const sub = document.getElementById('support-subtitle');
  if (!sub) return;
  const remaining = Math.max(0, u.remaining !== undefined ? u.remaining : u.limit - u.used);
  const pct = u.limit > 0 ? Math.round((u.used / u.limit) * 100) : 0;
  if (remaining === 0) {
    sub.style.color = '#fca5a5';
    sub.textContent = `⛔ Daily limit reached (${u.used}/${u.limit}) — resets at midnight`;
  } else if (pct >= 75) {
    sub.style.color = '#fcd34d';
    sub.textContent = `⚠️ ${remaining} messages left today (${u.used}/${u.limit})`;
  } else {
    sub.style.color = 'rgba(255,255,255,.65)';
    const keyInfo = u.keys > 1 ? ` · ${u.availableKeys||u.keys}/${u.keys} keys` : '';
    sub.textContent = `🟢 Online · ${u.used}/${u.limit} used${keyInfo}`;
  }
}

function closeSupportChat() {
  const el = document.getElementById('support-overlay');
  if (el) el.remove();
  _supportOpen = false;
  // Don't clear _supportRetryAt — rate-limit persists across close/reopen
}

function applySupportCountdown(secs) {
  // Clear any existing countdown
  if (_supportCountdown) { clearInterval(_supportCountdown); _supportCountdown = null; }

  const lockUI = () => {
    const inp = document.getElementById('support-input');
    const btn = document.getElementById('support-send-btn');
    if (inp) inp.disabled = true;
    if (btn) { btn.disabled = true; btn.style.background = '#94a3b8'; }
    return { inp, btn };
  };
  const unlockUI = () => {
    const inp = document.getElementById('support-input');
    const btn = document.getElementById('support-send-btn');
    if (inp) inp.disabled = false;
    if (btn) { btn.disabled = false; btn.textContent = 'Send'; btn.style.background = '#0070e0'; }
    if (inp) inp.focus();
  };
  const updateBtn = (s) => {
    const btn = document.getElementById('support-send-btn');
    if (btn) btn.textContent = s > 0 ? `Wait ${s}s` : 'Send';
  };

  lockUI();
  updateBtn(secs);

  _supportCountdown = setInterval(() => {
    secs--;
    updateBtn(secs);
    if (secs <= 0) {
      clearInterval(_supportCountdown);
      _supportCountdown = null;
      _supportRetryAt = 0;
      unlockUI();
    }
  }, 1000);
}

function clearSupportChat() {
  _supportHistory = [];
  const msgs = document.getElementById('support-msgs');
  if (!msgs) return;
  msgs.innerHTML = '<div style="background:#f1f5f9;border-radius:16px 16px 16px 4px;padding:12px 14px;font-size:13.5px;color:#334155;max-width:88%;line-height:1.6">Chat cleared. How can I help you? 👋</div>';
  const escBanner = document.getElementById('support-escalate');
  if (escBanner) escBanner.style.display = 'none';
  // Restore quick replies
  const qr = document.getElementById('support-quick-replies');
  if (qr) qr.style.display = 'flex';
}

function quickReply(text) {
  const inp = document.getElementById('support-input');
  if (!inp) return;
  inp.value = text;
  inp.style.height = 'auto';
  inp.style.height = Math.min(inp.scrollHeight, 90) + 'px';
  updateSupportCharCount(text.length);
  // Hide quick replies after first use
  const qr = document.getElementById('support-quick-replies');
  if (qr) qr.style.display = 'none';
  inp.focus();
  sendSupportMsg();
}

function updateSupportCharCount(len) {
  const el = document.getElementById('support-char-count');
  if (!el) return;
  el.textContent = len + '/300';
  el.style.color = len > 280 ? '#ef4444' : len > 250 ? '#f59e0b' : '#94a3b8';
}

function showSupportContactForm() {
  const area = document.getElementById('support-contact-area');
  if (!area) return;
  // If user is logged in, go to messages instead
  fetch('/api/auth/me').then(r=>r.json()).then(d=>{
    if (d.loggedIn) {
      window.location.href = '/messages.html?support=1';
      return;
    }
    // Not logged in — show inline contact form
    area.innerHTML = `
      <div style="margin-top:4px;display:flex;flex-direction:column;gap:6px">
        <input id="contact-name" type="text" placeholder="Your name (optional)"
          style="border:1px solid #fde68a;border-radius:8px;padding:7px 10px;font-size:12px;background:#fffbeb;color:#78350f;outline:none;width:100%;box-sizing:border-box"/>
        <input id="contact-email" type="email" placeholder="Your email (so admin can reply)"
          style="border:1px solid #fde68a;border-radius:8px;padding:7px 10px;font-size:12px;background:#fffbeb;color:#78350f;outline:none;width:100%;box-sizing:border-box"/>
        <textarea id="contact-msg" rows="3" placeholder="Describe your issue…"
          style="border:1px solid #fde68a;border-radius:8px;padding:7px 10px;font-size:12px;background:#fffbeb;color:#78350f;outline:none;width:100%;box-sizing:border-box;resize:none"></textarea>
        <div style="display:flex;gap:6px">
          <button onclick="submitSupportContact()" id="contact-send-btn"
            style="flex:1;background:#b45309;color:#fff;border:none;border-radius:8px;padding:7px;font-weight:700;font-size:12px;cursor:pointer">
            Send to Admin
          </button>
          <button onclick="document.getElementById('support-contact-area').innerHTML='<button onclick=\'showSupportContactForm()\' style=\'display:inline-flex;align-items:center;gap:6px;background:#b45309;color:#fff;border:none;cursor:pointer;padding:6px 14px;border-radius:8px;font-weight:700;font-size:11px\'><i class=\'fa-solid fa-paper-plane\'></i> Send Message to Admin</button>'"
            style="background:transparent;color:#92400e;border:1px solid #fcd34d;border-radius:8px;padding:7px 12px;font-size:12px;cursor:pointer">
            Cancel
          </button>
        </div>
        <p id="contact-status" style="font-size:11px;margin:0;display:none"></p>
      </div>`;
  }).catch(()=>{
    // Can't check auth — show form anyway
    area.innerHTML = `
      <div style="margin-top:4px;display:flex;flex-direction:column;gap:6px">
        <input id="contact-name" type="text" placeholder="Your name (optional)"
          style="border:1px solid #fde68a;border-radius:8px;padding:7px 10px;font-size:12px;background:#fffbeb;color:#78350f;outline:none;width:100%;box-sizing:border-box"/>
        <input id="contact-email" type="email" placeholder="Your email (so admin can reply)"
          style="border:1px solid #fde68a;border-radius:8px;padding:7px 10px;font-size:12px;background:#fffbeb;color:#78350f;outline:none;width:100%;box-sizing:border-box"/>
        <textarea id="contact-msg" rows="3" placeholder="Describe your issue…"
          style="border:1px solid #fde68a;border-radius:8px;padding:7px 10px;font-size:12px;background:#fffbeb;color:#78350f;outline:none;width:100%;box-sizing:border-box;resize:none"></textarea>
        <button onclick="submitSupportContact()" id="contact-send-btn"
          style="background:#b45309;color:#fff;border:none;border-radius:8px;padding:7px;font-weight:700;font-size:12px;cursor:pointer">
          Send to Admin
        </button>
        <p id="contact-status" style="font-size:11px;margin:0;display:none"></p>
      </div>`;
  });
}

async function submitSupportContact() {
  const name  = (document.getElementById('contact-name')?.value  || '').trim();
  const email = (document.getElementById('contact-email')?.value || '').trim();
  const msg   = (document.getElementById('contact-msg')?.value   || '').trim();
  const btn   = document.getElementById('contact-send-btn');
  const status = document.getElementById('contact-status');

  if (!msg) { if(status){status.style.display='block';status.style.color='#b91c1c';status.textContent='Please write a message.';} return; }

  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  try {
    const res  = await fetch('/api/auth/contact-admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, message: msg }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      if(status){status.style.display='block';status.style.color='#b91c1c';status.textContent=data.error||'Failed to send. Please try again.';}
      if(btn){btn.disabled=false;btn.textContent='Send to Admin';}
      return;
    }
    // Success
    const area = document.getElementById('support-contact-area');
    if (area) area.innerHTML = '<p style="color:#166534;font-weight:700;font-size:12px;margin:0"><i class="fa-solid fa-circle-check" style="margin-right:4px"></i>Message sent! The admin will reply to your email.</p>';
    appendSupportMsg('✅ Your message has been sent to the admin. Watch your email for a reply!', 'assistant');
  } catch(e) {
    if(status){status.style.display='block';status.style.color='#b91c1c';status.textContent='Network error. Please try again.';}
    if(btn){btn.disabled=false;btn.textContent='Send to Admin';}
  }
}

function appendSupportMsg(text, role) {
  const msgs = document.getElementById('support-msgs');
  if (!msgs) return;
  const div = document.createElement('div');
  if (role === 'user') {
    div.style.cssText = 'background:#0070e0;color:#fff;border-radius:16px 16px 4px 16px;padding:10px 14px;font-size:13.5px;max-width:80%;align-self:flex-end;margin-left:auto;line-height:1.5;word-break:break-word';
  } else {
    div.style.cssText = 'background:#f1f5f9;color:#334155;border-radius:16px 16px 16px 4px;padding:10px 14px;font-size:13.5px;max-width:88%;line-height:1.55;word-break:break-word';
  }
  // Simple markdown: **bold**
  div.innerHTML = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

function setSupportTyping(show) {
  const existing = document.getElementById('support-typing');
  if (show && !existing) {
    const msgs = document.getElementById('support-msgs');
    if (!msgs) return;
    const div = document.createElement('div');
    div.id = 'support-typing';
    div.style.cssText = 'background:#f1f5f9;border-radius:16px 16px 16px 4px;padding:10px 16px;display:flex;gap:4px;align-items:center;width:52px';
    div.innerHTML = '<span style="width:6px;height:6px;background:#94a3b8;border-radius:50%;animation:supportBlink .9s infinite"></span><span style="width:6px;height:6px;background:#94a3b8;border-radius:50%;animation:supportBlink .9s .2s infinite"></span><span style="width:6px;height:6px;background:#94a3b8;border-radius:50%;animation:supportBlink .9s .4s infinite"></span>';
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
    // Inject animation if not already present
    if (!document.getElementById('support-anim-style')) {
      const s = document.createElement('style');
      s.id = 'support-anim-style';
      s.textContent = '@keyframes supportBlink{0%,80%,100%{opacity:.25}40%{opacity:1}}';
      document.head.appendChild(s);
    }
  } else if (!show && existing) {
    existing.remove();
  }
}

async function sendSupportMsg() {
  const input = document.getElementById('support-input');
  const btn = document.getElementById('support-send-btn');
  if (!input) return;
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';
  input.style.height = 'auto';
  updateSupportCharCount(0);
  // Hide quick-reply chips after first real message
  const qr = document.getElementById('support-quick-replies');
  if (qr) qr.style.display = 'none';
  if (btn) btn.disabled = true;

  appendSupportMsg(msg, 'user');
  _supportHistory.push({ role: 'user', content: msg });
  setSupportTyping(true);

  try {
    const res = await fetch('/api/auth/support-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, history: _supportHistory.slice(0, -1) }),
    });
    const data = await res.json();
    setSupportTyping(false);
    const reply = data.reply || 'Sorry, something went wrong. Please try again.';
    appendSupportMsg(reply, 'assistant');
    _supportHistory.push({ role: 'assistant', content: reply });
    // Update usage counter in header
    if (data.used !== undefined) updateSupportUsageUI(data);
    if (data.escalate) {
      const escBanner = document.getElementById('support-escalate');
      if (escBanner) escBanner.style.display = 'block';
    }
    // Daily limit reached — lock input permanently until reset
    if (data.dailyLimitReached) {
      const inp = document.getElementById('support-input');
      const btn = document.getElementById('support-send-btn');
      if (inp) { inp.disabled = true; inp.placeholder = 'Daily limit reached — resets at midnight'; }
      if (btn) { btn.disabled = true; btn.textContent = 'Limit'; btn.style.background = '#94a3b8'; }
      if (data.resetsInSecs) {
        // Show a live countdown to reset in the subtitle
        let secs = data.resetsInSecs;
        const resetInterval = setInterval(() => {
          secs--;
          const h = Math.floor(secs/3600), m = Math.floor((secs%3600)/60), s = secs%60;
          const sub = document.getElementById('support-subtitle');
          if (sub) sub.textContent = `⚠️ Daily limit reached — resets in ${h>0?h+'h ':''}${m}m ${s}s`;
          if (secs <= 0) { clearInterval(resetInterval); if(inp){inp.disabled=false;inp.placeholder='Type your question…';}if(btn){btn.disabled=false;btn.textContent='Send';btn.style.background='#0070e0';} }
        }, 1000);
      }
      return;
    }
    if (data.retryAfter) {
      // Store the absolute timestamp when the rate-limit expires (survives close/reopen)
      _supportRetryAt = Date.now() + data.retryAfter * 1000;
      applySupportCountdown(data.retryAfter);
      return; // skip the finally re-enable
    }
  } catch(e) {
    setSupportTyping(false);
    appendSupportMsg('Connection error. Please check your internet and try again.', 'assistant');
  } finally {
    // Only re-enable if not rate-limited
    if (_supportRetryAt <= Date.now()) {
      if (btn) btn.disabled = false;
      setTimeout(() => { if(input) input.focus(); }, 50);
    }
  }
}

// ═══════════════════════════════════════════════════
// ASCOT COURSE CATALOG — Year-Level Cascade
// ─────────────────────────────────────────────────
// Each entry describes ONE enrollable program track.
//
// Fields:
//   value      — unique submission code (sent to the backend)
//   family     — groups programs sharing the same base title (for dedup in dropdown)
//   familyLabel— label shown in the course <select> (shared by all siblings)
//   type       — 'bachelor' | 'diploma' | 'associate' | 'certificate' | 'postgrad'
//   school     — <optgroup> label
//   minYear    — first year a student can be in this program (always 1)
//   maxYear    — last year a student can be in this program (program duration)
//   major      — optional: the Major / Specialization label for this track
//
// Year-level filtering rules
// ─────────────────────────
//   General  : show courses where  minYear ≤ selectedYear ≤ maxYear
//   1st-year : per school, if ANY non-degree programs (diploma/associate/certificate)
//              exist in that school → suppress ALL bachelor/postgrad entries for
//              that school (non-degree programs are the entry-level track).
//              Schools with ONLY bachelor programs show their bachelor entries normally.
//
// Deduplication
// ─────────────
//   The dropdown shows ONE option per `family`.
//   If members of a family have `major` fields, the Specialization dropdown appears
//   after the user picks that family.
// ═══════════════════════════════════════════════════
var ASCOT_COURSES = [

  // ── School of Forestry and Environmental Sciences ──────────────────────────
  // Non-degree (2 yr) → shown for yr 1-2; bachelor (4 yr) → shown for yr 1-4
  // 1st-year rule: DFT exists → suppress BSF/BSES for yr 1
  { value: 'BSF',  family: 'BSF',  familyLabel: 'Bachelor of Science in Forestry (BSF)',               type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Forestry and Environmental Sciences' },
  { value: 'BSES', family: 'BSES', familyLabel: 'Bachelor of Science in Environmental Science (BSES)', type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Forestry and Environmental Sciences' },
  { value: 'DFT',  family: 'DFT',  familyLabel: 'Diploma in Forest Technology (2 Years)',              type: 'diploma',  minYear: 1, maxYear: 2, school: 'School of Forestry and Environmental Sciences' },

  // ── School of Education ─────────────────────────────────────────────────────
  // No non-degree programs → bachelor's shown for all year levels (including 1st)
  { value: 'BEEd',      family: 'BEEd', familyLabel: 'Bachelor of Elementary Education (BEEd)',               type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Education' },
  { value: 'BPEd',      family: 'BPEd', familyLabel: 'Bachelor of Physical Education (BPEd)',                 type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Education' },
  // BSEd family — 5 majors share one dropdown entry
  { value: 'BSEd-EN',   family: 'BSEd', familyLabel: 'Bachelor of Secondary Education (BSEd)',                type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Education', major: 'Major in English' },
  { value: 'BSEd-FIL',  family: 'BSEd', familyLabel: 'Bachelor of Secondary Education (BSEd)',                type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Education', major: 'Major in Filipino' },
  { value: 'BSEd-MATH', family: 'BSEd', familyLabel: 'Bachelor of Secondary Education (BSEd)',                type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Education', major: 'Major in Mathematics' },
  { value: 'BSEd-SCI',  family: 'BSEd', familyLabel: 'Bachelor of Secondary Education (BSEd)',                type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Education', major: 'Major in Science' },
  { value: 'BSEd-SS',   family: 'BSEd', familyLabel: 'Bachelor of Secondary Education (BSEd)',                type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Education', major: 'Major in Social Studies' },
  // BTLE family — 2 majors
  { value: 'BTLE-HE',  family: 'BTLE', familyLabel: 'Bachelor of Technology and Livelihood Education (BTLE)', type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Education', major: 'Major in Home Economics' },
  { value: 'BTLE-ICT', family: 'BTLE', familyLabel: 'Bachelor of Technology and Livelihood Education (BTLE)', type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Education', major: 'Major in Information and Communication Technology' },

  // ── School of Agricultural Sciences ─────────────────────────────────────────
  // 1st-year rule: CAS (associate 2yr) exists → suppress BSA bachelor for yr 1
  { value: 'BSA-AS', family: 'BSA', familyLabel: 'Bachelor of Science in Agriculture (BSA)',                  type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Agricultural Sciences', major: 'Major in Animal Science' },
  { value: 'BSA-CS', family: 'BSA', familyLabel: 'Bachelor of Science in Agriculture (BSA)',                  type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Agricultural Sciences', major: 'Major in Crop Science (Agronomy/Horticulture)' },
  { value: 'CAS',    family: 'CAS', familyLabel: 'Certificate in Agricultural Science (2 Years)',             type: 'associate',minYear: 1, maxYear: 2, school: 'School of Agricultural Sciences' },

  // ── School of Arts and Sciences ──────────────────────────────────────────────
  // No non-degree programs → bachelor shown for all year levels
  { value: 'ABPolSci', family: 'ABPolSci', familyLabel: 'Bachelor of Arts in Political Science',              type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Arts and Sciences' },

  // ── School of Engineering ─────────────────────────────────────────────────────
  // No non-degree programs → bachelor shown for all year levels (5-year programs)
  { value: 'BSCE', family: 'BSCE', familyLabel: 'Bachelor of Science in Civil Engineering (BSCE)',            type: 'bachelor', minYear: 1, maxYear: 5, school: 'School of Engineering' },
  { value: 'BSEE', family: 'BSEE', familyLabel: 'Bachelor of Science in Electrical Engineering (BSEE)',      type: 'bachelor', minYear: 1, maxYear: 5, school: 'School of Engineering' },
  { value: 'BSME', family: 'BSME', familyLabel: 'Bachelor of Science in Mechanical Engineering (BSME)',      type: 'bachelor', minYear: 1, maxYear: 5, school: 'School of Engineering' },

  // ── School of Fisheries and Ocean Sciences ────────────────────────────────────
  // No non-degree programs → bachelor shown for all year levels
  { value: 'BSFish', family: 'BSFish', familyLabel: 'Bachelor of Science in Fisheries',                      type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Fisheries and Ocean Sciences' },

  // ── School of Industrial Technology ──────────────────────────────────────────
  // 1st-year rule: certificates/associates/diplomas exist → suppress BIT bachelor for yr 1
  // BIT family — 4 majors share one dropdown entry
  { value: 'BIT-AET', family: 'BIT', familyLabel: 'Bachelor in Industrial Technology (BIT)',                  type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Industrial Technology', major: 'Major in Automotive Engineering Technology' },
  { value: 'BIT-CET', family: 'BIT', familyLabel: 'Bachelor in Industrial Technology (BIT)',                  type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Industrial Technology', major: 'Major in Civil Engineering Technology' },
  { value: 'BIT-EET', family: 'BIT', familyLabel: 'Bachelor in Industrial Technology (BIT)',                  type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Industrial Technology', major: 'Major in Electrical Engineering Technology' },
  { value: 'BIT-FT',  family: 'BIT', familyLabel: 'Bachelor in Industrial Technology (BIT)',                  type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Industrial Technology', major: 'Major in Food Technology' },
  // 3-year diploma programs
  { value: 'DipAET', family: 'DipAET', familyLabel: 'Diploma in Automotive Engineering Technician (3 years)', type: 'diploma',     minYear: 1, maxYear: 3, school: 'School of Industrial Technology' },
  { value: 'DipCET', family: 'DipCET', familyLabel: 'Diploma in Civil Engineering Technician (3 years)',      type: 'diploma',     minYear: 1, maxYear: 3, school: 'School of Industrial Technology' },
  { value: 'DipEET', family: 'DipEET', familyLabel: 'Diploma in Electrical Engineering Technician (3 years)', type: 'diploma',     minYear: 1, maxYear: 3, school: 'School of Industrial Technology' },
  { value: 'DipFT',  family: 'DipFT',  familyLabel: 'Diploma in Food Technology (3 years)',                   type: 'diploma',     minYear: 1, maxYear: 3, school: 'School of Industrial Technology' },
  // 2-year associate programs
  { value: 'AssocAET', family: 'AssocAET', familyLabel: 'Associate in Automotive Engineering Technician (2 years)', type: 'associate', minYear: 1, maxYear: 2, school: 'School of Industrial Technology' },
  { value: 'AssocCET', family: 'AssocCET', familyLabel: 'Associate in Civil Engineering Technician (2 years)',       type: 'associate', minYear: 1, maxYear: 2, school: 'School of Industrial Technology' },
  { value: 'AssocEET', family: 'AssocEET', familyLabel: 'Associate in Electrical Engineering Technician (2 years)',  type: 'associate', minYear: 1, maxYear: 2, school: 'School of Industrial Technology' },
  { value: 'AssocFT',  family: 'AssocFT',  familyLabel: 'Associate in Food Technology (2 years)',                    type: 'associate', minYear: 1, maxYear: 2, school: 'School of Industrial Technology' },
  // 1-year certificate programs
  { value: 'CertAET', family: 'CertAET', familyLabel: 'Certificate in Automotive Engineering Technician (1 year)',  type: 'certificate', minYear: 1, maxYear: 1, school: 'School of Industrial Technology' },
  { value: 'CertCET', family: 'CertCET', familyLabel: 'Certificate in Civil Engineering Technician (1 year)',        type: 'certificate', minYear: 1, maxYear: 1, school: 'School of Industrial Technology' },
  { value: 'CertEET', family: 'CertEET', familyLabel: 'Certificate in Electrical Engineering Technician (1 year)',   type: 'certificate', minYear: 1, maxYear: 1, school: 'School of Industrial Technology' },
  { value: 'CertFT',  family: 'CertFT',  familyLabel: 'Certificate in Food Technology (1 year)',                     type: 'certificate', minYear: 1, maxYear: 1, school: 'School of Industrial Technology' },

  // ── School of Information Technology ─────────────────────────────────────────
  // 1st-year rule: ACT (associate, 2yr) exists → suppress BSIT bachelor for yr 1
  // BSIT family — 2 specializations share one dropdown entry
  { value: 'BSIT-AP', family: 'BSIT', familyLabel: 'Bachelor of Science in Information Technology (BSIT)',    type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Information Technology', major: 'Specialization in Application Programming' },
  { value: 'BSIT-DD', family: 'BSIT', familyLabel: 'Bachelor of Science in Information Technology (BSIT)',    type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Information Technology', major: 'Specialization in Digital Design' },
  { value: 'ACT',     family: 'ACT',  familyLabel: 'Associate in Computer Technology (2 Years)',               type: 'associate',minYear: 1, maxYear: 2, school: 'School of Information Technology' },

  // ── School of Accountancy and Business Management ─────────────────────────────
  // No non-degree programs → all shown for yr 1+
  { value: 'BSAcc', family: 'BSAcc', familyLabel: 'Bachelor of Science in Accountancy',                        type: 'bachelor', minYear: 1, maxYear: 5, school: 'School of Accountancy and Business Management' },
  { value: 'BSHM',  family: 'BSHM',  familyLabel: 'Bachelor of Science in Hospitality Management',            type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Accountancy and Business Management' },
  { value: 'BSTM',  family: 'BSTM',  familyLabel: 'Bachelor of Science in Tourism Management',                type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Accountancy and Business Management' },

  // ── College of Law ────────────────────────────────────────────────────────────
  // Postgraduate — shown for all year levels (no non-degree to suppress it)
  { value: 'JD', family: 'JD', familyLabel: 'Juris Doctor (Online)',                                           type: 'postgrad', minYear: 1, maxYear: 4, school: 'College of Law' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
/** Return the catalog entry matching a specific value code. */
function ascotByValue(val) {
  return ASCOT_COURSES.find(function(c) { return c.value === val; }) || null;
}
/** Return all catalog entries belonging to a family. */
function ascotFamily(familyKey) {
  return ASCOT_COURSES.filter(function(c) { return c.family === familyKey; });
}

// ── Year Level → Course cascade ───────────────────────────────────────────────
//
// Filtering rules (applied in order):
//   1. Year-range  : keep entries where minYear ≤ selectedYear ≤ maxYear
//   2. 1st-year    : per school, if ANY non-degree entries (diploma/associate/
//                    certificate) survived step 1, remove all bachelor/postgrad
//                    entries for that school.  Schools with ONLY bachelor entries
//                    keep those entries.
//   3. Dedup       : show ONE <option> per family (first occurrence wins).
//
function onYearLevelChange() {
  var yearSel   = $('reg-yearlevel');
  var courseSel = $('reg-course');
  var specRow   = $('specialization-row');
  var specSel   = $('reg-specialization');

  var yearVal = yearSel ? parseInt(yearSel.value, 10) : 0;

  // Reset downstream fields
  if (courseSel) {
    courseSel.innerHTML = '<option value="">' +
      (yearVal ? '\u2014 Select Program / Course \u2014' : '\u2014 Select Year Level first \u2014') + '</option>';
    courseSel.disabled = !yearVal;
  }
  if (specRow) specRow.classList.add('hidden');
  if (specSel) specSel.innerHTML = '<option value="">\u2014 Select Major / Specialization \u2014</option>';

  if (!yearVal) {
    console.log('[ASCOT] Year level cleared — cascades reset');
    return;
  }

  // ── Step 1: year-range filter ─────────────────────────────────────────────
  // Keep only programs whose duration covers the selected year.
  var inRange = ASCOT_COURSES.filter(function(c) {
    return yearVal >= c.minYear && yearVal <= c.maxYear;
  });

  // ── Step 2: lowest-tier non-degree rule (applies to ALL year levels) ───────
  //
  // For each school, find all non-degree programs (diploma / associate /
  // certificate) that survived step 1.  If any exist:
  //   a) Suppress ALL bachelor / postgrad entries for that school.
  //   b) Among the surviving non-degree entries, keep ONLY those whose maxYear
  //      equals the SMALLEST maxYear in that school — i.e. the shortest programs
  //      still active at this year level.
  //
  // This produces the correct tier per school per year:
  //   Yr 1  Industrial Tech → certificates only   (maxYear 1 is the minimum)
  //   Yr 2  Industrial Tech → associates only     (certs done; maxYear 2 is min)
  //   Yr 3  Industrial Tech → diplomas only       (assocs done; maxYear 3 is min)
  //   Yr 4  Industrial Tech → BIT bachelor        (all non-degree done)
  //   Yr 1  Forestry        → DFT diploma         (only non-degree option)
  //   Yr 3  Forestry        → BSF + BSES          (DFT done at yr 2)
  //
  var nonDegreeTypes = { certificate: true, associate: true, diploma: true };

  // Per school: track the lowest maxYear among its surviving non-degree programs.
  // undefined → school has no non-degree programs in range (bachelor-only school).
  var schoolLowestTierMax = {};
  inRange.forEach(function(c) {
    if (!nonDegreeTypes[c.type]) return;
    if (schoolLowestTierMax[c.school] === undefined ||
        c.maxYear < schoolLowestTierMax[c.school]) {
      schoolLowestTierMax[c.school] = c.maxYear;
    }
  });

  var visible = inRange.filter(function(c) {
    var lowestMax = schoolLowestTierMax[c.school];
    if (lowestMax !== undefined) {
      // School still has non-degree options at this year level:
      //   a) drop all degree/postgrad entries
      if (!nonDegreeTypes[c.type]) return false;
      //   b) keep only the lowest-tier non-degree entries
      return c.maxYear === lowestMax;
    }
    return true; // bachelor-only school — keep all
  });

  var suppressed = inRange.length - visible.length;
  if (suppressed > 0) {
    console.log('[ASCOT] Year ' + yearVal + ': suppressed ' + suppressed +
      ' entries (degree programs + higher-tier non-degree hidden while lower-tier exists)');
  }

  // ── Step 3: deduplicate by family ─────────────────────────────────────────
  var seenFamilies = {};
  var bySchool     = {};
  visible.forEach(function(c) {
    if (seenFamilies[c.family]) return;
    seenFamilies[c.family] = true;
    if (!bySchool[c.school]) bySchool[c.school] = [];
    bySchool[c.school].push(c);
  });

  // ── Build <optgroup> elements ──────────────────────────────────────────────
  Object.keys(bySchool).sort().forEach(function(school) {
    var og = document.createElement('optgroup');
    og.label = school;
    bySchool[school].forEach(function(c) {
      var opt         = document.createElement('option');
      opt.value       = c.family;      // family key → specific code via specialization
      opt.textContent = c.familyLabel;
      og.appendChild(opt);
    });
    if (courseSel) courseSel.appendChild(og);
  });

  var totalShown = Object.keys(seenFamilies).length;
  console.log('[ASCOT] Year ' + yearVal + ' → ' + visible.length +
    ' programs visible → ' + totalShown + ' unique course entries in dropdown');
}

// ── Manual-entry toggles ───────────────────────────────────────────────────
// Independent checkboxes, deliberately NOT tied to any dropdown option value
// or datalist/autocomplete — "not listed" means the resident's answer is not
// among the fixed choices, so it must not be constrained back to them, and
// the toggle state must not depend on (and reset with) the dropdown's value.

function toggleYearLevelManualMode() {
  var manual = $('yearlevel-manual-toggle').checked;
  var sel    = $('reg-yearlevel');
  var input  = $('reg-yearlevel-manual');
  var hint   = $('yearlevel-hint');
  if (manual) {
    sel.classList.add('hidden');
    input.classList.remove('hidden');
    input.focus();
    if (hint) hint.classList.add('hidden');
    // Can't filter courses by an unknown/non-standard year level — fall back
    // to letting the resident pick from the full unfiltered course list.
    buildFullCourseList();
  } else {
    sel.classList.remove('hidden');
    input.classList.add('hidden');
    input.value = '';
    if (hint) hint.classList.remove('hidden');
    onYearLevelChange(); // rebuild the course list filtered by the select's current value
  }
  console.log('[DAMIS] Year Level manual entry = ' + manual);
}

function buildFullCourseList() {
  var courseSel = $('reg-course');
  var specRow   = $('specialization-row');
  if (!courseSel) return;
  courseSel.innerHTML = '<option value="">\u2014 Select Program / Course \u2014</option>';
  courseSel.disabled = false;
  var seen = {}, bySchool = {};
  ASCOT_COURSES.forEach(function(c) {
    if (seen[c.family]) return;
    seen[c.family] = true;
    if (!bySchool[c.school]) bySchool[c.school] = [];
    bySchool[c.school].push(c);
  });
  Object.keys(bySchool).sort().forEach(function(school) {
    var og = document.createElement('optgroup'); og.label = school;
    bySchool[school].forEach(function(c) {
      var opt = document.createElement('option');
      opt.value = c.family; opt.textContent = c.familyLabel;
      og.appendChild(opt);
    });
    courseSel.appendChild(og);
  });
  if (specRow) specRow.classList.add('hidden');
  console.log('[ASCOT] Year level is manual — showing full unfiltered course list');
}

function toggleCourseManualMode() {
  var manual = $('course-manual-toggle').checked;
  var sel    = $('reg-course');
  var input  = $('reg-course-manual');
  var specRow      = $('specialization-row');
  var specSel      = $('reg-specialization');
  var specManual   = $('reg-specialization-manual');
  var specToggle   = $('specialization-manual-toggle');
  var specToggleWrap = $('specialization-manual-toggle-wrap');
  var specRequiredMark = $('specialization-required-mark');
  if (manual) {
    sel.classList.add('hidden');
    input.classList.remove('hidden');
    input.focus();
    // No known majors for a manually-typed course — expose Specialization as
    // an optional plain-text field instead of trying to cascade from it.
    if (specRow) specRow.classList.remove('hidden');
    if (specSel) specSel.classList.add('hidden');
    if (specManual) specManual.classList.remove('hidden');
    if (specToggleWrap) specToggleWrap.classList.add('hidden'); // already forced manual — no need to offer the toggle
    if (specRequiredMark) { specRequiredMark.textContent = ''; specRequiredMark.classList.remove('text-red-400'); }
  } else {
    sel.classList.remove('hidden');
    input.classList.add('hidden');
    input.value = '';
    if (specToggleWrap) specToggleWrap.classList.remove('hidden');
    if (specToggle) specToggle.checked = false;
    if (specRequiredMark) { specRequiredMark.textContent = '*'; specRequiredMark.classList.add('text-red-400'); }
    onCourseChange(); // rebuild the specialization cascade for whatever course is currently selected
  }
  console.log('[DAMIS] Program/Course manual entry = ' + manual);
}

function toggleSpecializationManualMode() {
  var manual = $('specialization-manual-toggle').checked;
  var sel    = $('reg-specialization');
  var input  = $('reg-specialization-manual');
  if (manual) {
    sel.classList.add('hidden');
    input.classList.remove('hidden');
    input.focus();
  } else {
    sel.classList.remove('hidden');
    input.classList.add('hidden');
    input.value = '';
  }
  console.log('[DAMIS] Major/Specialization manual entry = ' + manual);
}

// ── Course → Specialization cascade ──────────────────────────────────────────
//
// reg-course value = family key (e.g. "BSIT", "BIT", "BSEd").
// If the family has members with a `major` field → show Specialization dropdown.
// The reg-specialization value = specific track code (e.g. "BSIT-AP") sent to
// the backend.  For single-track families, family key === value code.
//
function onCourseChange() {
  var courseSel = $('reg-course');
  var specRow   = $('specialization-row');
  var specSel   = $('reg-specialization');

  if (!specRow || !specSel) return;

  var familyKey = courseSel ? courseSel.value : '';

  // Reset specialization
  specSel.innerHTML = '<option value="">\u2014 Select Major / Specialization \u2014</option>';

  if (!familyKey) {
    specRow.classList.add('hidden');
    return;
  }

  // Find all members of this family that carry a major/specialization
  var members = ASCOT_COURSES.filter(function(c) {
    return c.family === familyKey && c.major;
  });

  if (members.length > 0) {
    members.forEach(function(c) {
      var opt       = document.createElement('option');
      opt.value     = c.value;   // specific code sent to backend
      opt.textContent = c.major;
      specSel.appendChild(opt);
    });
    specRow.classList.remove('hidden');
    console.log('[ASCOT] Family "' + familyKey + '" → ' +
      members.length + ' specialization(s) shown');
  } else {
    // No specialization — single-track program
    specRow.classList.add('hidden');
    console.log('[ASCOT] Family "' + familyKey + '" → single-track (no specialization)');
  }
}

// ═══════════════════════════════════════════════════
// LIVE SELFIE — Step 4 camera capture
// ═══════════════════════════════════════════════════
var _selfieStream = null;

function setStep4Mode(mode) {
  // mode: 'upload' | 'selfie'
  var btnUpload = $('btn-mode-upload');
  var btnSelfie = $('btn-mode-selfie');
  var selfiePanel = $('selfie-panel');
  var active   = 'flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold bg-blue-600 text-white shadow shadow-blue-200 transition-all';
  var inactive = 'flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition-all';
  if (mode === 'upload') {
    if (btnUpload)  btnUpload.className  = active;
    if (btnSelfie)  btnSelfie.className  = inactive;
    if (selfiePanel) selfiePanel.classList.add('hidden');
    stopSelfieCamera();
  } else {
    if (btnUpload)  btnUpload.className  = inactive;
    if (btnSelfie)  btnSelfie.className  = active;
    if (selfiePanel) selfiePanel.classList.remove('hidden');
  }
}

async function startSelfieCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showStepError(4, 'Camera is not supported in this browser. Please upload a photo instead.');
    setStep4Mode('upload');
    return;
  }
  try {
    _selfieStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    var feed = $('selfie-feed');
    if (feed) feed.srcObject = _selfieStream;
    var snapBtn = $('selfie-snap-btn');
    if (snapBtn) snapBtn.disabled = false;
    console.log('[Selfie] Camera stream started');
  } catch(err) {
    var msg = (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')
      ? 'Camera permission denied. Allow camera access in browser settings or upload a photo instead.'
      : 'Camera unavailable on this device. Please upload a photo instead.';
    showStepError(4, msg);
    setStep4Mode('upload');
    console.warn('[Selfie] Camera error:', err.name, err.message);
  }
}

function stopSelfieCamera() {
  if (_selfieStream) {
    _selfieStream.getTracks().forEach(function(t){ t.stop(); });
    _selfieStream = null;
    console.log('[Selfie] Camera stream stopped');
  }
  var feed = $('selfie-feed');
  if (feed) feed.srcObject = null;
}

function captureSelfie() {
  var video  = $('selfie-feed');
  var canvas = $('selfie-canvas');
  if (!video || !canvas) { console.error('[Selfie] Missing feed or canvas'); return; }
  if (!video.videoWidth)  { showStepError(4, 'Camera is not ready yet. Please wait a moment.'); return; }

  canvas.width  = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  var dataUrl = canvas.toDataURL('image/jpeg', 0.92);

  capturedPhotoData = dataUrl;
  avatarFileRef = null;

  // Show selfie preview
  var selfiePreview = $('selfie-preview');
  var selfiePreviewImg = $('selfie-preview-img');
  if (selfiePreview && selfiePreviewImg) {
    selfiePreviewImg.src = dataUrl;
    selfiePreview.classList.remove('hidden');
  }

  // Feed it into the crop viewfinder system
  var fakeEvent = { target: { files: [] } };
  var bytes = Math.round((dataUrl.length * 3) / 4);
  var fakeFile = null;
  try {
    var parts   = dataUrl.split(',');
    var mime    = (parts[0].match(/:(.*?);/) || [])[1] || 'image/jpeg';
    var bStr    = atob(parts[1]);
    var ab      = new Uint8Array(bStr.length);
    for (var i = 0; i < bStr.length; i++) ab[i] = bStr.charCodeAt(i);
    fakeFile = new File([new Blob([ab], { type: mime })], 'selfie.jpg', { type: mime });
  } catch(e) { /* old browser fallback — no File object, use raw dataUrl */ }

  // Initialize viewfinder with the selfie
  var img = new Image();
  img.onload = function() {
    var avFile = $('av-file');
    if (avFile) {
      try { var dt = new DataTransfer(); if(fakeFile){ dt.items.add(fakeFile); avFile.files = dt.files; } } catch(e) {}
    }
    previewAvatarViewfinder({ target: { result: dataUrl, files: fakeFile ? [fakeFile] : [] } }, true);
  };
  img.src = dataUrl;

  stopSelfieCamera();
  setStep4Mode('upload'); // switch to upload mode to show the viewfinder

  var bytes2 = Math.round((dataUrl.length * 3) / 4);
  console.log('[Selfie] Captured — ' + formatBytes(bytes2));
  hideStepError(4);
  showToast('Selfie captured! Adjust the crop frame if needed.', 'success');
}

function doModeUpload() {
  stopSelfieCamera();
  setStep4Mode('upload');
  var inp = $('av-file');
  if (inp) inp.click();
}

function doModeSelfie() {
  setStep4Mode('selfie');
  startSelfieCamera();
}

document.addEventListener('DOMContentLoaded', async function(){
  // ── Already logged-in? Skip the login page entirely ──
  try {
    var meRes  = await fetch('/api/auth/me');
    var meData = await meRes.json();
    if (meData.loggedIn && meData.user) {
      var dest = meData.user.role === 'admin' ? '/admin.html' : '/feed.html';
      window.location.replace(dest);
      return; // stop further init
    }
  } catch (_) { /* network error — show login form normally */ }

  setupBirthdayField();
  await checkUrlParams();
  $('terms-modal').addEventListener('click', function(e){ if (e.target === $('terms-modal')) closeTerms(); });
  console.log('PGA-DAMIS auth module loaded ✅ (v2 enhanced)');
});
