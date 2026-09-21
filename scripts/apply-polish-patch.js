#!/usr/bin/env node
/**
 * scripts/apply-polish-patch.js
 *
 * Adds the <link> for /css/polish.css to the four pages that render the
 * mobile bottom nav. These pages are 70–145 KB each, so a one-line insert is
 * safer done mechanically than by hand-editing four files.
 *
 * Run once from the project root:
 *     node scripts/apply-polish-patch.js
 *
 * Idempotent — re-running skips anything already linked. Aborts without
 * writing if any anchor is missing or ambiguous. Writes a .bak on first touch.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// polish.css must load AFTER app.css so it wins on equal specificity.
const ANCHOR = '<link rel="stylesheet" href="/css/app.css"/>';
const MARKER = '/css/polish.css';
const INSERT = '\n  <link rel="stylesheet" href="/css/polish.css"/>';

const PAGES = [
  'public/feed.html',
  'public/notifications.html',
  'public/search.html',
  'public/profile.html',
];

let applied = 0, skipped = 0;
const edits = [];

for (const rel of PAGES) {
  const full = path.join(ROOT, rel);

  if (!fs.existsSync(full)) {
    console.error(`✖ Aborted — file not found: ${rel}`);
    process.exit(1);
  }

  const src = fs.readFileSync(full, 'utf8');

  if (src.includes(MARKER)) {
    console.log(`○ skip    ${rel} (already linked)`);
    skipped++;
    continue;
  }

  const hits = src.split(ANCHOR).length - 1;
  if (hits !== 1) {
    console.error(
      `✖ Aborted — nothing written.\n` +
      `  ${rel}: app.css link matched ${hits} time(s), expected exactly 1.\n` +
      `  Add this line by hand after the app.css link, then re-run:\n` +
      `      <link rel="stylesheet" href="/css/polish.css"/>`
    );
    process.exit(1);
  }

  edits.push({ rel, full, src });
}

for (const e of edits) {
  const bak = e.full + '.bak';
  if (!fs.existsSync(bak)) fs.writeFileSync(bak, e.src);
  fs.writeFileSync(e.full, e.src.replace(ANCHOR, ANCHOR + INSERT));
  console.log(`✔ patch   ${e.rel}`);
  applied++;
}

console.log(`\nDone — ${applied} applied, ${skipped} already present.`);
if (applied) console.log('Backups written alongside each patched file as *.bak');
