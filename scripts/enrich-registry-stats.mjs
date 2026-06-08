#!/usr/bin/env node
// Enrich registry.json with per-theme install counts and last-modified dates.
// Run AFTER build-registry.mjs.
//
//   node scripts/enrich-registry-stats.mjs
//
// - installs: all-time CDN hits on the theme's theme.css (jsDelivr stats). The
//   app fetches a theme's CSS only on install (browsing pulls registry.json +
//   thumbnails, app start replays from local storage), so CSS hits are a clean
//   install proxy. A theme nobody has installed yet simply gets 0.
// - updatedAt: ISO date of the last commit touching themes/<id>/ (from git).
//
// Both are additive fields; older app clients ignore them. The script is
// resilient: if the jsDelivr request fails, install counts are carried over
// from the last committed registry.json rather than zeroed.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const REGISTRY = join(REPO, 'registry.json');

// jsDelivr retains at most a year of stats and the repo is younger than that,
// so `year` is effectively all-time. Revisit if a longer period appears.
const STATS_URL =
  'https://data.jsdelivr.com/v1/stats/packages/gh/Psysonic/psysonic-themes@main/files?period=year';

/** Map theme id -> all-time theme.css CDN hits, or null when the fetch fails. */
async function fetchInstallCounts() {
  try {
    const res = await fetch(STATS_URL, { headers: { 'user-agent': 'psysonic-themes-registry' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const files = await res.json();
    if (!Array.isArray(files)) throw new Error('unexpected payload');
    const counts = {};
    for (const f of files) {
      const m = /^\/themes\/([^/]+)\/theme\.css$/.exec(f?.name || '');
      if (m) counts[m[1]] = Number(f?.hits?.total) || 0;
    }
    return counts;
  } catch (e) {
    console.warn(`stats fetch failed (${e.message}); carrying over previous install counts`);
    return null;
  }
}

/** ISO date of the last commit touching themes/<id>/, or undefined. */
function lastModified(id) {
  try {
    return execSync(`git log -1 --format=%cI -- themes/${id}`, { cwd: REPO, encoding: 'utf8' }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Install counts from the last committed registry — fallback when the live fetch fails. */
function previousInstalls() {
  try {
    const prev = JSON.parse(execSync('git show HEAD:registry.json', { cwd: REPO, encoding: 'utf8' }));
    const map = {};
    for (const t of prev.themes || []) if (typeof t.installs === 'number') map[t.id] = t.installs;
    return map;
  } catch {
    return {};
  }
}

async function main() {
  if (!existsSync(REGISTRY)) {
    console.error('registry.json missing — run build-registry.mjs first');
    process.exit(1);
  }
  const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));
  const live = await fetchInstallCounts();
  const fallback = live === null ? previousInstalls() : null;

  for (const theme of registry.themes || []) {
    theme.installs = live !== null
      ? (live[theme.id] ?? 0)
      : (fallback[theme.id] ?? (typeof theme.installs === 'number' ? theme.installs : 0));
    const updatedAt = lastModified(theme.id);
    if (updatedAt) theme.updatedAt = updatedAt;
  }

  writeFileSync(REGISTRY, JSON.stringify(registry, null, 2) + '\n');
  const withInstalls = (registry.themes || []).filter((t) => t.installs > 0).length;
  console.log(
    `enriched ${registry.themes?.length ?? 0} theme(s); ${withInstalls} with installs` +
      (live === null ? ' (counts carried over — live stats unavailable)' : ''),
  );
}

main();
