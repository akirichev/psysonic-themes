#!/usr/bin/env node
// Regenerate registry.json from every theme manifest under themes/.
//
//   node scripts/build-registry.mjs
//
// registry.json is the single file the app reads (over jsDelivr). It is
// AUTO-GENERATED — never hand-edit it. CSS and thumbnails are referenced by
// relative path and fetched on demand; the client prepends the CDN base.

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const themesDir = join(REPO, 'themes');

const SCHEMA_VERSION = 1;

const registryPath = join(REPO, 'registry.json');

function build() {
  const themes = [];
  // Carry over the enrichment fields (installs / updatedAt) from the previous
  // registry so a plain rebuild without the stats step never drops them;
  // enrich-registry-stats.mjs refreshes them afterwards.
  const prevById = {};
  if (existsSync(registryPath)) {
    try {
      for (const t of JSON.parse(readFileSync(registryPath, 'utf8')).themes || []) prevById[t.id] = t;
    } catch { /* ignore a malformed previous registry */ }
  }
  if (existsSync(themesDir)) {
    const ids = readdirSync(themesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    for (const id of ids) {
      const manifestPath = join(themesDir, id, 'manifest.json');
      if (!existsSync(manifestPath)) continue;
      const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
      // A theme animates if its CSS defines @keyframes — the app flags these on
      // setups where animation is costly (Nvidia/Linux, compositing off).
      const cssPath = join(themesDir, id, 'theme.css');
      const animated = existsSync(cssPath) && /@(?:-[a-z]+-)?keyframes\b/i.test(readFileSync(cssPath, 'utf8'));
      themes.push({
        id: m.id,
        name: m.name,
        author: m.author,
        version: m.version,
        description: m.description,
        mode: m.mode,
        ...(m.tags ? { tags: m.tags } : {}),
        ...(m.minAppVersion ? { minAppVersion: m.minAppVersion } : {}),
        ...(animated ? { animated: true } : {}),
        css: `themes/${id}/theme.css`,
        thumbnail: `themes/${id}/thumbnail.webp`,
        ...(typeof prevById[id]?.installs === 'number' ? { installs: prevById[id].installs } : {}),
        ...(prevById[id]?.updatedAt ? { updatedAt: prevById[id].updatedAt } : {}),
      });
    }
  }

  const registry = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    themes,
  };
  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
  console.log(`registry.json: ${themes.length} theme(s)`);
}

build();
