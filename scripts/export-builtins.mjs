#!/usr/bin/env node
// Export Psysonic's built-in token-only themes into this community-store repo.
//
//   node scripts/export-builtins.mjs [--app <path-to-psysonic>] [--only id,id]
//
// What it does, per theme:
//   1. Resolves every contract token to a CONCRETE value. The built-in theme
//      files still carry --ctp-* palette primitives and let the :root Catppuccin
//      Mocha base fill in a handful of semantic tokens (--accent-2, --bg-deep,
//      --bg-elevated, --text-on-accent, --highlight, ...). We compute each token
//      against {mocha-base ∪ theme} so the exported theme depends on nothing.
//   2. Strips --ctp-* entirely (palette internals, not part of the contract).
//   3. Emits themes/<id>/theme.css (single [data-theme='<id>'] block), a
//      manifest.json, and a placeholder thumbnail.png (3-band swatch).
//
// The output must pass scripts/validate-theme.mjs. This is maintainer tooling:
// re-run it whenever the built-in palettes change to refresh the store copies.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import postcss from 'postcss';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

// ---- args ----
const argv = process.argv.slice(2);
function arg(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
const APP = resolve(arg('--app') || join(REPO, '..', 'psysonic'));
const ONLY = arg('--only') ? new Set(arg('--only').split(',').map((s) => s.trim())) : null;
const APP_THEMES = join(APP, 'src', 'styles', 'themes');
const PICKER = join(APP, 'src', 'components', 'ThemePicker.tsx');
const MOCHA = join(APP_THEMES, 'catppuccin-mocha-variables.css');

// ---- contract ----
const tokens = JSON.parse(readFileSync(join(REPO, 'schema', 'allowed-tokens.json'), 'utf8'));
const noMeta = (o) => Object.keys(o || {}).filter((k) => !k.startsWith('$'));
const CORE = noMeta(tokens.core);
const OPTIONAL = noMeta(tokens.optional);
const GRANULAR = noMeta(tokens.granular);
const OPT_GRAN = new Set([...OPTIONAL, ...GRANULAR]);

// Themes that intentionally stay built-in (cores + accessibility skins + demo).
const EXCLUDE = new Set(['mocha', 'latte', 'kanagawa-wave', 'stark-hud', 'vision-dark', 'vision-navy']);

// Defaults for the two required core tokens that the Mocha base doesn't define
// itself, so a theme that omits them still yields a complete contract theme.
const SHADOW_DROPDOWN_DEFAULT = 'rgba(0, 0, 0, 0.55)';

// Upstream attribution for the open-source palette families (credit in the
// store description; we don't claim authorship of the upstream palettes).
const UPSTREAM = {
  Catppuccin: 'the Catppuccin palette',
  Nord: 'the Nord palette by arcticicestudio',
  Dracula: 'the Dracula palette by Zeno Rocha',
  Gruvbox: 'the Gruvbox palette by morhetz',
  Kanagawa: 'the Kanagawa palette by rebelot',
  Nightfox: 'the Nightfox palettes by EdenEast',
  'Atom One': 'the Atom One palette (one-nvim by Th3Whit3Wolf)',
  '1984': 'the vs-1984 palette by juanmnl',
};

const idRe = /\[data-theme=['"]([^'"]+)['"]\]/;

/** Parse one CSS file → { byId: Map(id -> {decls, scheme}), structural: Set(id), atRules }. */
function parseThemeFile(path) {
  const css = readFileSync(path, 'utf8');
  const root = postcss.parse(css, { from: path });
  const byId = new Map();
  const structuralIds = new Set();
  let hasAtRule = false;
  root.walkAtRules(() => { hasAtRule = true; });
  root.walkRules((rule) => {
    const sels = rule.selector.split(',').map((s) => s.trim());
    const ids = [];
    let structural = false;
    for (const s of sels) {
      const m = idRe.exec(s);
      if (m) ids.push(m[1]);
      const bare = s.replace(idRe, '').trim();
      if (bare && bare !== ':root') structural = true; // a real component selector
    }
    if (ids.length === 0) return; // selector touches no [data-theme] → ignore here
    const decls = {};
    let scheme = null;
    rule.walkDecls((d) => {
      if (d.prop === 'color-scheme') scheme = d.value.trim();
      else if (d.prop.startsWith('--')) decls[d.prop.trim()] = d.value.trim();
    });
    for (const id of ids) {
      if (structural) structuralIds.add(id);
      const prev = byId.get(id) || { decls: {}, scheme: null };
      byId.set(id, { decls: { ...prev.decls, ...decls }, scheme: scheme ?? prev.scheme });
    }
  });
  return { byId, structuralIds, hasAtRule };
}

/** Resolve a CSS value to concrete form by expanding var(--x[, fallback]) via map. */
function resolveValue(val, map, seen = new Set()) {
  let out = val;
  let guard = 0;
  while (out.includes('var(') && guard++ < 50) {
    out = out.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g, (_m, name, fb) => {
      if (map[name] !== undefined && !seen.has(name)) {
        return resolveValue(map[name], map, new Set([...seen, name]));
      }
      return fb !== undefined ? fb.trim() : '';
    });
  }
  return out.trim();
}

/** Parse THEME_GROUPS out of ThemePicker.tsx → Map(id -> {label, family, group, bg, card, accent}). */
function parseMetadata() {
  const src = readFileSync(PICKER, 'utf8');
  const meta = new Map();
  let group = null;
  for (const line of src.split('\n')) {
    const gm = /group:\s*'([^']+)'/.exec(line);
    if (gm) { group = gm[1]; continue; }
    if (!/\bid:\s*['"]/.test(line)) continue;
    const get = (key) => {
      const m = new RegExp(`${key}:\\s*'([^']*)'`).exec(line) || new RegExp(`${key}:\\s*"([^"]*)"`).exec(line);
      return m ? m[1] : undefined;
    };
    const id = get('id');
    if (!id) continue;
    meta.set(id, {
      label: get('label') || id,
      family: get('family'),
      group,
      bg: get('bg'),
      card: get('card'),
      accent: get('accent'),
    });
  }
  return meta;
}

const kebab = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Families whose variant labels are ambiguous on their own ("Dark Hard", "Macchiato",
// "Polar Night") — in a flat store grid the family name must be prefixed. Families
// with self-contained labels (Nightfox/Carbonfox…, Dracula) are left as-is.
const PREFIX_FAMILIES = new Set(['Catppuccin', 'Atom One', 'Gruvbox', 'Kanagawa', 'Nord', '1984']);

// The picker uses terse labels that read fine under a family sub-header but are
// cryptic in a flat store grid. Spell out franchise/OS names (consistent with
// Dune/Blade/etc.); streaming-service names stay softened on purpose (DZR, P-DVD).
const NAME_OVERRIDES = {
  'aero-glass': 'Windows 7 Aero',
  'luna-teal': 'Windows XP Luna',
  w10: 'Windows 10',
  w11: 'Windows 11',
  'w3-1': 'Windows 3.1',
  w98: 'Windows 98',
  gw1: 'Guild Wars 1',
  dos: 'MS-DOS',
  unix: 'Unix Shell',
};

function displayName(m, id) {
  if (NAME_OVERRIDES[id]) return NAME_OVERRIDES[id];
  if (m.family && PREFIX_FAMILIES.has(m.family) && m.label !== m.family) return `${m.family} ${m.label}`;
  return m.label;
}

function makeDescription(m, name) {
  const { family, group } = m;
  if (family && UPSTREAM[family]) {
    if (family === 'Catppuccin') return `${name} — soothing pastel theme, recolour of ${UPSTREAM[family]}.`;
    return `${name} — recolour of ${UPSTREAM[family]}.`;
  }
  const themed = { Movies: 'movie', Games: 'game', Series: 'TV-series', 'Famous Albums': 'album', 'Social Media': 'app', Mediaplayer: 'media-player' };
  if (themed[group]) {
    const kind = themed[group];
    const article = /^[aeiou]/i.test(kind) ? 'an' : 'a';
    return `${name} — ${article} ${kind}-inspired theme for Psysonic.`;
  }
  return `${name} — a theme for Psysonic.`;
}

function makeTags(m) {
  const tags = new Set();
  if (m.group && m.group !== 'COMMUNITY' && m.group !== 'Psysonic Themes') tags.add(kebab(m.group));
  if (m.family) tags.add(kebab(m.family));
  return [...tags].filter(Boolean).slice(0, 8);
}

// ---- tiny PNG writer (3 horizontal bands) ----
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
})();
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(body), 0);
  return Buffer.concat([len, body, crc]);
}
function parseColor(c, fallback = [58, 58, 68]) {
  if (!c) return fallback;
  let m = /^#([0-9a-f]{3})$/i.exec(c);
  if (m) return [0, 1, 2].map((i) => parseInt(m[1][i] + m[1][i], 16));
  m = /^#([0-9a-f]{6})$/i.exec(c);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(c);
  if (m) return [1, 2, 3].map((i) => Math.round(Number(m[i])));
  return fallback;
}
/** Build an rgba() string from any parseable colour, or '' if it can't be parsed. */
function toRgba(color, alpha) {
  const rgb = parseColor(color, null);
  if (!rgb) return '';
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

function bandsPng(width, height, bands) {
  const rowLen = 1 + width * 3;
  const raw = Buffer.alloc(rowLen * height);
  let y0 = 0;
  for (const [color, frac] of bands) {
    const [r, g, b] = parseColor(color);
    const y1 = Math.min(height, y0 + Math.round(height * frac));
    for (let y = y0; y < y1; y++) {
      const off = y * rowLen; raw[off] = 0;
      for (let x = 0; x < width; x++) { const p = off + 1 + x * 3; raw[p] = r; raw[p + 1] = g; raw[p + 2] = b; }
    }
    y0 = y1;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw, { level: 9 })), pngChunk('IEND', Buffer.alloc(0))]);
}

// ---- main ----
function main() {
  // Mocha base map (ctp primitives + semantic var() defaults).
  const mochaParsed = parseThemeFile(MOCHA);
  const mochaEntry = mochaParsed.byId.get('mocha');
  const baseMap = mochaEntry.decls;
  const baseScheme = mochaEntry.scheme || 'dark';

  const meta = parseMetadata();

  // Discover all theme files and classify.
  const files = readdirSync(APP_THEMES).filter((f) => f.endsWith('.css'));
  const candidates = []; // {id, decls, scheme}
  const allStructural = new Set();
  for (const f of files) {
    if (f === 'catppuccin-mocha-variables.css' || f === 'semantic-cascade.css' || f === 'index.css') continue;
    let parsed;
    try { parsed = parseThemeFile(join(APP_THEMES, f)); } catch { continue; }
    for (const id of parsed.structuralIds) allStructural.add(id);
    if (parsed.hasAtRule) continue;
    for (const [id, entry] of parsed.byId) {
      if (parsed.structuralIds.has(id)) continue; // structural file, not token-only
      candidates.push({ id, ...entry, file: f });
    }
  }

  const warnings = [];
  const exported = [];
  for (const cand of candidates) {
    const { id } = cand;
    if (EXCLUDE.has(id)) continue;
    if (ONLY && !ONLY.has(id)) continue;
    if (allStructural.has(id)) { warnings.push(`SKIP ${id}: has a structural companion rule (treat as built-in skin)`); continue; }

    const map = { ...baseMap, ...cand.decls };
    const out = {};

    // color-scheme
    const scheme = cand.scheme || baseScheme;

    // core tokens — all required, all concrete
    for (const t of CORE) {
      let v;
      // --accent-dim / --accent-glow are literals in the Mocha base (not var(--ctp-*)),
      // so a theme that doesn't set them itself would otherwise inherit Mocha's purple
      // tint regardless of its own accent. Derive them from the theme's own accent.
      if ((t === '--accent-dim' || t === '--accent-glow') && cand.decls[t] === undefined) {
        v = toRgba(out['--accent'], t === '--accent-dim' ? 0.15 : 0.3);
      } else {
        v = map[t] !== undefined ? resolveValue(map[t], map) : '';
      }
      if (!v) {
        if (t === '--border-dropdown') v = resolveValue(map['--border'] || '', map);
        else if (t === '--shadow-dropdown') v = SHADOW_DROPDOWN_DEFAULT;
        else if (t === '--select-arrow') v = resolveValue(baseMap['--select-arrow'] || '', baseMap);
      }
      if (!v) { warnings.push(`${id}: could not resolve required core token ${t}`); continue; }
      out[t] = v;
    }

    // optional + granular — only the ones the theme set itself (not inherited)
    for (const [prop, val] of Object.entries(cand.decls)) {
      if (OPT_GRAN.has(prop)) {
        const v = resolveValue(val, map);
        if (v) out[prop] = v;
      }
    }

    const m = meta.get(id) || { label: id };
    const name = displayName(m, id);
    // ---- write theme.css ----
    const groups = [
      ['Accent', ['--accent', '--accent-dim', '--accent-glow', '--accent-2']],
      ['Backgrounds', ['--bg-app', '--bg-sidebar', '--bg-card', '--bg-hover', '--bg-elevated', '--bg-player', '--bg-deep', '--bg-glass']],
      ['Borders', ['--border', '--border-subtle', '--border-dropdown']],
      ['Text', ['--text-primary', '--text-secondary', '--text-muted', '--text-on-accent']],
      ['Status', ['--danger', '--positive', '--warning', '--highlight']],
      ['Special', ['--select-arrow', '--shadow-dropdown']],
    ];
    const written = new Set();
    let body = `[data-theme='${id}'] {\n  color-scheme: ${scheme};\n`;
    for (const [title, props] of groups) {
      const present = props.filter((p) => out[p] !== undefined);
      if (!present.length) continue;
      body += `\n  /* ${title} */\n`;
      for (const p of present) { body += `  ${p}: ${out[p]};\n`; written.add(p); }
    }
    const extras = Object.keys(out).filter((p) => !written.has(p));
    if (extras.length) {
      body += `\n  /* Per-theme overrides */\n`;
      for (const p of extras) body += `  ${p}: ${out[p]};\n`;
    }
    body += `}\n`;

    const dir = join(REPO, 'themes', id);
    mkdirSync(dir, { recursive: true });
    const header = `/* ${name} — exported from the Psysonic built-in themes. */\n`;
    writeFileSync(join(dir, 'theme.css'), header + body);

    // ---- manifest.json ----
    const manifest = {
      id,
      name,
      author: 'Psysonic',
      version: '1.0.0',
      description: makeDescription(m, name).slice(0, 200),
      mode: scheme === 'light' ? 'light' : 'dark',
    };
    const tags = makeTags(m);
    if (tags.length) manifest.tags = tags;
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

    // ---- thumbnail.png (3-band swatch) ----
    const bg = m.bg || out['--bg-app'];
    const card = m.card || out['--bg-card'];
    const accent = m.accent || out['--accent'];
    writeFileSync(join(dir, 'thumbnail.png'), bandsPng(480, 300, [[bg, 0.55], [card, 0.2], [accent, 0.25]]));

    exported.push(id);
    if (!meta.has(id)) warnings.push(`${id}: no ThemePicker metadata; used id as name`);
  }

  exported.sort();
  console.log(`Exported ${exported.length} theme(s):`);
  for (const id of exported) console.log(`  ${id}`);
  if (warnings.length) {
    console.log(`\nWarnings (${warnings.length}):`);
    for (const w of warnings) console.log(`  - ${w}`);
  }
}

main();
