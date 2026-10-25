#!/usr/bin/env node
/**
 * i18n gate — keeps the three translation surfaces in step with the code.
 *
 *   1. Manifest strings (`package.json` → `%key%`) resolved through
 *      `package.nls.json` (English baseline) and `package.nls.<locale>.json`.
 *   2. Runtime strings (`vscode.l10n.t('…')`) resolved through
 *      `l10n/bundle.l10n.<locale>.json`.
 *   3. Source discipline: every translatable string is a LITERAL wrapped in
 *      `l10n.t`, because the bundle is keyed by the exact English source text.
 *
 * Why a gate and not just discipline: VS Code substitutes `%key%` with the
 * locale value and, when the key is missing, leaves the RAW `%key%` on screen
 * (`localizeManifest` in the workbench). A bundle that drifts therefore ships
 * a user-visible defect, not a silent fallback — so drift must fail the build.
 *
 * Usage: `node scripts/i18n-check.js [--strict]`
 *   --strict  treat warnings (stale bundle entries) as errors.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const L10N_DIR = path.join(ROOT, 'l10n');
const BASE_LOCALE = 'zh-cn';
const STRICT = process.argv.includes('--strict');

/**
 * Translations that legitimately contain no Chinese: product terms and unit
 * labels stay as-is in every locale ("API Key" is not translated in this UI).
 */
const LATIN_ONLY_OK = new Set(['④ API key']);

const problems = [];
const error = (area, message) => problems.push({ level: 'error', area, message });
const warn = (area, message) => problems.push({ level: 'warn', area, message });

/* ------------------------------------------------------------------ JSON -- */

/**
 * `JSON.parse` silently keeps the last of two identical keys, so a duplicated
 * translation key would look fine here and translate to the wrong string in
 * the editor. Walk the raw text and collect only keys that sit DIRECTLY in the
 * root object (`{ … }` at depth 1) — nested keys repeat by design.
 */
function topLevelKeys(text) {
  const keys = [];
  let depth = 0;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      let end = index + 1;
      while (end < text.length) {
        if (text[end] === '\\') {
          end += 2;
          continue;
        }
        if (text[end] === '"') {
          break;
        }
        end += 1;
      }
      const raw = text.slice(index, end + 1);
      let after = end + 1;
      while (after < text.length && /\s/.test(text[after])) {
        after += 1;
      }
      if (depth === 1 && text[after] === ':') {
        keys.push(JSON.parse(raw));
      }
      index = end + 1;
      continue;
    }
    if (char === '{' || char === '[') {
      depth += 1;
    } else if (char === '}' || char === ']') {
      depth -= 1;
    }
    index += 1;
  }
  return keys;
}

function readJson(file, area) {
  const text = fs.readFileSync(file, 'utf8');
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    error(area, `${path.relative(ROOT, file)}: invalid JSON — ${err.message}`);
    return undefined;
  }
  const counts = new Map();
  for (const key of topLevelKeys(text)) {
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const [key, count] of counts) {
    if (count > 1) {
      error(area, `${path.relative(ROOT, file)}: duplicate key ${JSON.stringify(key)} (${count}×)`);
    }
  }
  return value;
}

/** Every `%key%` a manifest string refers to. */
function manifestKeys(node, found = new Set()) {
  if (typeof node === 'string') {
    for (const match of node.matchAll(/%([^%\s]+)%/g)) {
      found.add(match[1]);
    }
  } else if (Array.isArray(node)) {
    for (const item of node) {
      manifestKeys(item, found);
    }
  } else if (node && typeof node === 'object') {
    for (const value of Object.values(node)) {
      manifestKeys(value, found);
    }
  }
  return found;
}

/* ------------------------------------------------------------- manifest -- */

function checkManifest() {
  const manifest = readJson(path.join(ROOT, 'package.json'), 'manifest');
  if (!manifest) {
    return new Set();
  }
  const base = readJson(path.join(ROOT, 'package.nls.json'), 'manifest');
  if (!base) {
    return new Set();
  }

  const locales = fs
    .readdirSync(ROOT)
    .filter((name) => /^package\.nls\..+\.json$/.test(name))
    .map((name) => ({ locale: name.slice('package.nls.'.length, -'.json'.length), file: path.join(ROOT, name) }));
  if (!locales.some((item) => item.locale === BASE_LOCALE)) {
    error('manifest', `missing package.nls.${BASE_LOCALE}.json`);
  }
  if (manifest.l10n !== undefined && !fs.existsSync(path.join(ROOT, manifest.l10n))) {
    error('manifest', `"l10n": "${manifest.l10n}" does not exist`);
  }

  const referenced = manifestKeys(manifest);
  for (const key of referenced) {
    if (!(key in base)) {
      error('manifest', `package.nls.json: missing key ${JSON.stringify(key)} referenced by package.json`);
    }
  }
  for (const key of Object.keys(base)) {
    if (!referenced.has(key)) {
      warn('manifest', `package.nls.json: ${JSON.stringify(key)} is never referenced by package.json`);
    }
    if (typeof base[key] !== 'string' || base[key].trim() === '') {
      error('manifest', `package.nls.json: ${JSON.stringify(key)} is empty`);
    }
    if (/[\u3400-\u9fff]/.test(base[key])) {
      error('manifest', `package.nls.json: ${JSON.stringify(key)} contains Chinese — the baseline must be English`);
    }
  }

  for (const { locale, file } of locales) {
    const table = readJson(file, 'manifest');
    if (!table) {
      continue;
    }
    const name = path.basename(file);
    for (const key of Object.keys(base)) {
      if (!(key in table)) {
        error('manifest', `${name}: missing key ${JSON.stringify(key)}`);
      }
    }
    for (const key of Object.keys(table)) {
      if (!(key in base)) {
        error('manifest', `${name}: key ${JSON.stringify(key)} does not exist in package.nls.json`);
        continue;
      }
      const value = table[key];
      if (typeof value !== 'string' || value.trim() === '') {
        error('manifest', `${name}: ${JSON.stringify(key)} is empty`);
        continue;
      }
      const placeholders = (text) => [...new Set([...text.matchAll(/%([^%\s]+)%/g)].map((m) => m[1]))].sort();
      const expected = placeholders(base[key]);
      const actual = placeholders(value);
      if (expected.join() !== actual.join()) {
        error('manifest', `${name}: ${JSON.stringify(key)} placeholder mismatch (${expected.join() || '—'} → ${actual.join() || '—'})`);
      }
    }
  }

  console.log(
    `  manifest  package.json → ${referenced.size} key(s); locales: ${locales.map((l) => l.locale).join(', ') || 'none'}`
  );
  return referenced;
}

/* --------------------------------------------------------------- source -- */

const PLACEHOLDER = /\{(\d+)\}/g;
const placeholdersOf = (text) => [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => Number(m[1])))].sort((a, b) => a - b);
const showPlaceholders = (list) => (list.length === 0 ? 'none' : list.map((n) => `{${n}}`).join(' '));

/** `l10n.t` / `vscode.l10n.t` — both spellings appear in this codebase. */
function isL10nCall(node) {
  const callee = node.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === 't' &&
    /(^|\.)l10n$/.test(callee.expression.getText())
  );
}

function checkSource() {
  const files = fs.readdirSync(SRC).filter((name) => name.endsWith('.ts')).sort();
  /** key → { placeholders, where[] } */
  const messages = new Map();
  let callSites = 0;

  for (const name of files) {
    const file = path.join(SRC, name);
    const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);

    const at = (node) => {
      const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      return `${name}:${pos.line + 1}`;
    };

    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        if (isL10nCall(node)) {
          callSites += 1;
          const arg = node.arguments[0];
          const literal = arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) ? arg.text : undefined;
          if (literal === undefined) {
            error('source', `${at(node)}: l10n.t() needs a STRING LITERAL (template literals with ${'${}'} cannot be keyed)`);
          } else {
            if (literal.trim() === '') {
              error('source', `${at(node)}: l10n.t() with an empty message`);
            }
            const row = messages.get(literal) || { placeholders: placeholdersOf(literal), where: [] };
            row.where.push(at(node));
            messages.set(literal, row);
          }
        }
        // A literal handed straight to a notification — message OR button —
        // can never be translated.
        const callee = node.expression;
        if (ts.isPropertyAccessExpression(callee) && /^show(Information|Warning|Error)Message$/.test(callee.name.text)) {
          for (const arg of node.arguments) {
            if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
              error(
                'source',
                `${at(node)}: ${callee.name.text}() takes a bare string ${JSON.stringify(arg.text.slice(0, 60))} — wrap it in l10n.t()`
              );
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  console.log(`  source    ${messages.size} message(s) across ${callSites} l10n.t() call site(s) in ${files.length} file(s)`);
  return messages;
}

/* --------------------------------------------------------------- bundle -- */

function checkBundles(messages) {
  if (!fs.existsSync(L10N_DIR)) {
    error('bundle', 'l10n/ directory is missing — runtime strings would never translate');
    return;
  }
  const bundles = fs
    .readdirSync(L10N_DIR)
    .filter((name) => /^bundle\.l10n\..+\.json$/.test(name))
    .map((name) => ({ locale: name.slice('bundle.l10n.'.length, -'.json'.length), file: path.join(L10N_DIR, name) }));
  if (!bundles.some((item) => item.locale === BASE_LOCALE)) {
    error('bundle', `missing l10n/bundle.l10n.${BASE_LOCALE}.json`);
  }

  for (const { locale, file } of bundles) {
    const table = readJson(file, 'bundle');
    if (!table) {
      continue;
    }
    const name = path.basename(file);
    for (const [key, row] of messages) {
      if (!(key in table)) {
        error('bundle', `${name}: missing ${JSON.stringify(key)} — used at ${row.where.join(', ')}`);
        continue;
      }
      const value = table[key];
      if (typeof value !== 'string' || value.trim() === '') {
        error('bundle', `${name}: ${JSON.stringify(key)} is empty`);
        continue;
      }
      const expected = row.placeholders;
      const actual = placeholdersOf(value);
      if (expected.join() !== actual.join()) {
        error(
          'bundle',
          `${name}: ${JSON.stringify(key)} placeholder mismatch — source has ${showPlaceholders(expected)}, translation has ${showPlaceholders(actual)}`
        );
      }
      if (locale === BASE_LOCALE && !LATIN_ONLY_OK.has(key) && !/[\u3400-\u9fff]/.test(value)) {
        warn('bundle', `${name}: ${JSON.stringify(key)} has no Chinese characters — untranslated?`);
      }
    }
    for (const key of Object.keys(table)) {
      if (!messages.has(key)) {
        warn('bundle', `${name}: ${JSON.stringify(key)} is no longer used in src/ — delete it`);
      }
    }
    console.log(`  bundle    ${Object.keys(table).length} entr(ies) in ${locale}${locale === BASE_LOCALE ? '' : ' (fallback locale)'}`);
  }
}

/* ----------------------------------------------------------------- main -- */

console.log('i18n check');
const referenced = checkManifest();
void referenced;
const messages = checkSource();
checkBundles(messages);
console.log('');

const errors = problems.filter((p) => p.level === 'error');
const warnings = problems.filter((p) => p.level === 'warn');
for (const problem of problems) {
  console.log(`  ${problem.level === 'error' ? '✗' : '!'} [${problem.area}] ${problem.message}`);
}

if (errors.length > 0 || (STRICT && warnings.length > 0)) {
  console.log(`\n✗ ${errors.length} error(s), ${warnings.length} warning(s)`);
  process.exit(1);
}
console.log(`✓ all translation surfaces are in sync (${warnings.length} warning(s))`);
