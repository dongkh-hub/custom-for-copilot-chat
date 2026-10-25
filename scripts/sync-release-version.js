#!/usr/bin/env node
/**
 * sync:release-version — 把「已发布版本」的版本文件回填到 master。
 *
 * 版本权威只有一个：`release` 上的 v<version> tag（semantic-release 生成）。
 * master 不自己算版本号——它始终等于「最后一次发布出去的版本」，这样下一次
 * 发版时 semantic-release 推断出的补丁号不会跳号，CI 里的 diff 也不会莫名
 * 夹带版本变更。两边一旦漂移（典型场景：semantic-release 的版本 commit 用
 * GITHUB_TOKEN 推的，那次推送不会触发任何 workflow），本脚本负责抹平。
 *
 * 规则（幂等，可反复跑）：
 *   release 版本 > master 版本 → 取 release 的版本文件覆盖 master 并提交
 *   release 版本 ≤ master 版本 → 什么都不做（没发新版，或 master 手工领先）
 *
 * 只搬三个文件，都是 semantic-release 的所有物：
 *   package.json / package-lock.json / CHANGELOG.md
 *
 * 用法：
 *   node scripts/sync-release-version.js                  # 对齐并推送 origin master
 *   node scripts/sync-release-version.js --dry-run        # 只演练，不提交不推送
 *   node scripts/sync-release-version.js --no-fetch       # 跳过 fetch（离线/本地已最新）
 *
 * 需要：clean 工作树、对 master 的推送权限（CI 里由 GITHUB_TOKEN 提供）。
 * 失败（如 master 分支保护）时的兜底是人工执行 `npm run sync:release-version`。
 */
'use strict';

const { execFileSync } = require('child_process');

const RELEASE_REF = 'origin/release';
const MAIN_REF = 'origin/master';
const VERSION_FILES = ['package.json', 'package-lock.json', 'CHANGELOG.md'];
/** 推送被拒（别的提交抢先落地）时的重试次数——每轮都会重新基于最新 master 重建。 */
const MAX_ATTEMPTS = 3;
const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';
const BOT_NAME = 'github-actions[bot]';

const argv = new Set(process.argv.slice(2));
const dryRun = argv.has('--dry-run');
const skipFetch = argv.has('--no-fetch');

function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** `git` 的退出码即答案（存在性 / 已配置判断），失败一律折叠成 false。 */
function gitOk(args) {
  try {
    git(args);
    return true;
  } catch {
    return false;
  }
}

function log(message) {
  console.log(`[sync-version] ${message}`);
}

function readVersion(ref) {
  const raw = git(['show', `${ref}:package.json`]);
  return JSON.parse(raw).version;
}

function parseVersion(version) {
  return String(version)
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) {
      return diff > 0 ? 1 : -1;
    }
  }
  return 0;
}

function fetchRefs() {
  if (skipFetch) {
    return;
  }
  git(['fetch', '--no-tags', 'origin', 'release', 'master']);
}

/** CI 的 runner 没有 git 身份；本地已配置时不覆盖。 */
function ensureIdentity() {
  if (!gitOk(['config', 'user.email'])) {
    git(['config', 'user.email', BOT_EMAIL]);
  }
  if (!gitOk(['config', 'user.name'])) {
    git(['config', 'user.name', BOT_NAME]);
  }
}

/**
 * CHANGELOG.md 在早期分支上可能不存在，存在才搬。
 * 返回两个 ref 上内容不一致的文件（blob 哈希比较，不碰工作树）。
 */
function differingFiles() {
  return VERSION_FILES.filter((file) => {
    if (!gitOk(['cat-file', '-e', `${RELEASE_REF}:${file}`])) {
      return false;
    }
    const fromRelease = git(['rev-parse', `${RELEASE_REF}:${file}`]);
    const fromDevelop = git(['rev-parse', `${MAIN_REF}:${file}`]);
    return fromRelease !== fromDevelop;
  });
}

// ---------------------------------------------------------------------------
// Version-only patching for the two JSON manifests
//
// ⚠️ These two files are NOT owned by semantic-release: package.json holds every
// LM-tool declaration, script and setting default, and master commits change
// them constantly. Taking the whole file from `release` silently reverted an
// entire refactor on 2026-10-20 (162 lines of declarations reverted, tools went
// from 87 back to the pre-rename set). Only the version fields may travel.
// ---------------------------------------------------------------------------

/** Replace the FIRST `"version": "…"` occurrence, leaving every other byte alone. */
function replaceFirstVersion(text, version) {
  return text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
}

/**
 * Patch the version fields as TEXT — re-serialising the JSON would reformat the
 * whole file (package.json carries deliberate column alignment), which is the
 * same collateral damage this function exists to avoid.
 *
 * package.json     → the root `version` (first occurrence)
 * package-lock.json → the root `version` plus `packages[""].version`
 *                     (dependency versions under node_modules/* must not move)
 */
function patchJsonVersions(text, version, lockfile) {
  const rootPatched = replaceFirstVersion(text, version);
  if (!lockfile) {
    return rootPatched;
  }
  const packagesAt = rootPatched.indexOf('"packages"');
  if (packagesAt < 0) {
    return rootPatched;
  }
  const emptyKeyAt = rootPatched.indexOf('"":', packagesAt);
  if (emptyKeyAt < 0) {
    return rootPatched;
  }
  return rootPatched.slice(0, emptyKeyAt) + replaceFirstVersion(rootPatched.slice(emptyKeyAt), version);
}

/**
 * Overwrite ONLY the version fields in `file`, keeping every other byte of the
 * master-side content. Returns true when the file actually changed.
 *
 * Verified before writing: after patching, everything except the version fields
 * must still deep-equal the master-side original — that invariant makes the
 * 2026-10-20 regression impossible to reintroduce silently.
 */
function applyVersionOnly(file, version) {
  const lockfile = file.endsWith('package-lock.json');
  const before = require('fs').readFileSync(file, 'utf8');
  const after = patchJsonVersions(before, version, lockfile);
  if (after === before) {
    return false;
  }

  const original = JSON.parse(before);
  const patched = JSON.parse(after);
  const strip = (value) => {
    if (!value || typeof value !== 'object') {
      return value;
    }
    const clone = JSON.parse(JSON.stringify(value));
    delete clone.version;
    if (clone.packages && clone.packages['']) {
      delete clone.packages[''].version;
    }
    return clone;
  };
  if (JSON.stringify(strip(original)) !== JSON.stringify(strip(patched))) {
    throw new Error(`${file}: 版本号以外的内容被改动了，拒绝写入（同步只能改 version 字段）`);
  }

  require('fs').writeFileSync(file, after, 'utf8');
  return true;
}

/** Files whose version field differs from `version` on the master side. */
function versionFilesToPatch(version) {
  return ['package.json', 'package-lock.json'].filter((file) => {
    if (!gitOk(['cat-file', '-e', `${MAIN_REF}:${file}`])) {
      return false;
    }
    const masterText = git(['show', `${MAIN_REF}:${file}`]);
    return patchJsonVersions(masterText, version, file.endsWith('package-lock.json')) !== masterText;
  });
}

/** CHANGELOG is wholly owned by semantic-release, so it is copied as a file. */
function changelogNeedsCopy() {
  if (!gitOk(['cat-file', '-e', `${RELEASE_REF}:CHANGELOG.md`])) {
    return false;
  }
  if (!gitOk(['cat-file', '-e', `${MAIN_REF}:CHANGELOG.md`])) {
    return true;
  }
  return (
    git(['rev-parse', `${RELEASE_REF}:CHANGELOG.md`]) !==
    git(['rev-parse', `${MAIN_REF}:CHANGELOG.md`])
  );
}


function logPlan(releaseVersion, files) {
  log(`将提交: chore(release): 同步版本号至 v${releaseVersion}（对齐 release）`);
  log(`改动文件: ${files.join(', ')}`);
}

/**
 * 一轮完整流程：基于最新 master 重建 → 只改版本字段 + 搬 CHANGELOG → 提交 → 推送。
 * 返回 'pushed' | 'aligned'。
 *
 * 调用前已确认 HEAD 没有未推送提交，所以 checkout --force 只会丢掉「本地 master
 * 落后于 origin」这种无害差异，不会吞掉真实工作。
 */
function alignOnce(releaseVersion) {
  // 本地有未提交改动时直接退出：脚本会重建分支，不能吞掉别人的工作。
  if (git(['status', '--porcelain'])) {
    throw new Error('工作树不干净，请先提交或 stash 后再运行');
  }

  git(['checkout', '--force', '-B', 'master', MAIN_REF]);

  const touched = [];
  for (const file of ['package.json', 'package-lock.json']) {
    if (gitOk(['cat-file', '-e', `${MAIN_REF}:${file}`]) && applyVersionOnly(file, releaseVersion)) {
      touched.push(file);
    }
  }
  if (changelogNeedsCopy()) {
    git(['checkout', RELEASE_REF, '--', 'CHANGELOG.md']);
    touched.push('CHANGELOG.md');
  }
  if (touched.length === 0) {
    return 'aligned';
  }
  git(['add', '--', ...touched]);

  if (!git(['diff', '--cached', '--name-only'])) {
    return 'aligned';
  }

  logPlan(releaseVersion, touched);
  ensureIdentity();
  git([
    'commit',
    '-m',
    `chore(release): 同步版本号至 v${releaseVersion}（对齐 release）`,
  ]);
  git(['push', 'origin', 'HEAD:master']);
  return 'pushed';
}

/**
 * 本地手动运行时最容易踩的坑：脚本会 `checkout --force -B master origin/master`，
 * 本地未推送的提交会被一并丢掉（只在 reflog 里）。CI 的干净 checkout 永远不触发，
 * 但开发机上千真万确会。先拦住，让用户明确 push 或换 clone。
 */
function assertNoUnpushedCommits() {
  const ahead = Number.parseInt(git(['rev-list', '--count', `${MAIN_REF}..HEAD`]) || '0', 10);
  if (ahead > 0) {
    throw new Error(
      `本地 master 有 ${ahead} 个未推送提交，本脚本会 reset 分支把它们丢掉。\n` +
        '请先 git push origin master，或用干净的 clone 运行；只想想看结果就加 --dry-run。',
    );
  }
}

function main() {
  fetchRefs();

  if (!gitOk(['cat-file', '-e', `${RELEASE_REF}:package.json`])) {
    log(`${RELEASE_REF} 不存在，跳过`);
    return 0;
  }

  const releaseVersion = readVersion(RELEASE_REF);
  const masterVersion = readVersion(MAIN_REF);
  log(`release=${releaseVersion} master=${masterVersion}`);

  if (compareVersions(releaseVersion, masterVersion) <= 0) {
    log('master 已对齐（或领先），无需处理');
    return 0;
  }

  // 演练完全不碰本地分支（只比内容），所以放行有未推送提交的本地。
  if (dryRun) {
    const files = [...versionFilesToPatch(releaseVersion), ...(changelogNeedsCopy() ? ['CHANGELOG.md'] : [])];
    if (files.length === 0) {
      log('版本文件已一致，无需提交');
      return 0;
    }
    log(`[dry-run] 将提交: chore(release): 同步版本号至 v${releaseVersion}（对齐 release）`);
    log(`[dry-run] 改动文件: ${files.join(', ')}`);
    return 0;
  }

  assertNoUnpushedCommits();

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      if (alignOnce(releaseVersion) === 'pushed') {
        log(`已把 v${releaseVersion} 回填到 master 并推送`);
      } else {
        log('版本文件已一致，无需提交');
      }
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === MAX_ATTEMPTS) {
        throw new Error(
          `对齐失败（第 ${attempt}/${MAX_ATTEMPTS} 次）: ${message}\n` +
            '若 master 开启了分支保护，请人工执行 npm run sync:release-version 或直接在网页改版本号。',
        );
      }
      log(`第 ${attempt} 次失败（${message}），重新拉取 master 后重试`);
      fetchRefs();
    }
  }
  return 1;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`[sync-version] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
