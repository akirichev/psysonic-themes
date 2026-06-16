#!/usr/bin/env node
// Enforce a manifest version bump when an existing theme's files change.
//
// The in-app theme store detects updates by comparing `manifest.version`
// (semver, via the app's `isNewer`). If a contributor edits theme.css but
// leaves the version untouched, the store never offers the update. This check
// runs in the `validate` workflow on PRs and fails when a changed theme folder
// did not bump its version. Brand-new themes are exempt.
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.GITHUB_BASE_REF || 'main';

function sh(cmd) {
  return execSync(cmd, { cwd: REPO, encoding: 'utf8' }).trim();
}

// Mirror the app's `isNewer` (appUpdaterHelpers.ts): 3-part numeric compare,
// leading non-digits stripped, missing parts treated as 0.
function isNewer(a, b) {
  const pa = String(a).replace(/^[^0-9]*/, '').split('.').map(Number);
  const pb = String(b).replace(/^[^0-9]*/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return false;
}

const baseRef = `origin/${base}`;
try {
  sh(`git fetch --quiet origin ${base}`);
  sh(`git rev-parse ${baseRef}`);
} catch {
  console.log(`check-version-bump: cannot resolve base ref "${base}" — skipping`);
  process.exit(0);
}

const changed = sh(`git diff --name-only ${baseRef}...HEAD -- themes/`)
  .split('\n')
  .filter(Boolean);

const ids = [
  ...new Set(
    changed
      .map(p => p.match(/^themes\/([^/]+)\//))
      .filter(Boolean)
      .map(m => m[1]),
  ),
];

const errors = [];
for (const id of ids) {
  const manifestPath = join(REPO, 'themes', id, 'manifest.json');
  if (!existsSync(manifestPath)) continue; // theme deleted in this PR

  let baseVersion;
  try {
    baseVersion = JSON.parse(sh(`git show ${baseRef}:themes/${id}/manifest.json`)).version;
  } catch {
    continue; // not on base = brand-new theme, no bump required
  }

  let headVersion;
  try {
    headVersion = JSON.parse(readFileSync(manifestPath, 'utf8')).version;
  } catch {
    continue; // malformed manifest — validate-theme.mjs reports that
  }

  if (!isNewer(headVersion, baseVersion)) {
    errors.push(
      `${id}: files changed but manifest version is still "${headVersion}" ` +
        `(base "${baseVersion}"). Bump "version" in themes/${id}/manifest.json ` +
        `so the in-app theme store detects the update.`,
    );
  }
}

if (errors.length) {
  console.error('Theme version bump required:\n' + errors.map(e => '  - ' + e).join('\n'));
  process.exit(1);
}
console.log(`check-version-bump: OK (${ids.length} changed theme folder(s) checked)`);
