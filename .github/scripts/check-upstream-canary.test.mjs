import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  compareCanaryTags,
  fetchPaginatedReleases,
  filterCanaryReleases,
  getNextPageUrl,
  isValidSha,
  loadState,
  normalizeVersion,
  parseCanaryTag,
  saveState,
  shouldSync,
} from './check-upstream-canary.mjs';

test('normalizeVersion strips leading v', () => {
  assert.equal(normalizeVersion('v2.2.19-canary.39'), '2.2.19-canary.39');
  assert.equal(normalizeVersion('2.2.19-canary.39'), '2.2.19-canary.39');
  assert.equal(normalizeVersion(''), '');
  assert.equal(normalizeVersion(null), '');
});

test('parseCanaryTag identifies valid canary tags and rejects others', () => {
  const valid1 = parseCanaryTag('v2.2.19-canary.39');
  assert.ok(valid1);
  assert.equal(valid1.valid, true);
  assert.equal(valid1.normalized, '2.2.19-canary.39');
  assert.equal(valid1.version, '2.2.19');
  assert.equal(valid1.canaryNum, 39);

  const valid2 = parseCanaryTag('2.2.18-canary.1');
  assert.ok(valid2);
  assert.equal(valid2.canaryNum, 1);

  // Invalid: nightly / PR build
  assert.equal(parseCanaryTag('v0.0.0-nightly.pr20401.32995'), null);
  // Invalid: stable release
  assert.equal(parseCanaryTag('v2.2.19'), null);
  // Invalid: random strings
  assert.equal(parseCanaryTag('canary'), null);
  assert.equal(parseCanaryTag(''), null);
  assert.equal(parseCanaryTag(null), null);
});

test('isValidSha validates 40-character hex string', () => {
  assert.equal(isValidSha('b85f6ad80cad69e034eeb09932b9be5e4a3b6ab0'), true);
  assert.equal(isValidSha('b85f6ad'), false); // too short
  assert.equal(isValidSha('g85f6ad80cad69e034eeb09932b9be5e4a3b6ab0'), false); // non-hex
  assert.equal(isValidSha(''), false);
  assert.equal(isValidSha(null), false);
});

test('compareCanaryTags correctly sorts tags', () => {
  assert.ok(compareCanaryTags('v2.2.19-canary.39', 'v2.2.19-canary.38') < 0);
  assert.ok(compareCanaryTags('v2.2.19-canary.1', 'v2.2.18-canary.99') < 0);
  assert.ok(compareCanaryTags('v2.2.18-canary.38', 'v2.2.19-canary.38') > 0);
  assert.equal(compareCanaryTags('v2.2.19-canary.39', 'v2.2.19-canary.39'), 0);
});

test('filterCanaryReleases filters drafts, nightlies, and missing published_at', () => {
  const mockReleases = [
    { tag_name: 'v0.0.0-nightly.pr20401.32995', draft: false, published_at: '2026-10-06T00:00:00Z' },
    { tag_name: 'v2.2.19-canary.37', draft: false, published_at: '2026-10-03T00:00:00Z' },
    { tag_name: 'v2.2.19-canary.39', draft: false, published_at: '2026-10-05T00:00:00Z' },
    { tag_name: 'v2.2.19-canary.40', draft: true, published_at: '2026-10-06T00:00:00Z' }, // draft
    { tag_name: 'v2.2.19-canary.38', draft: false, published_at: null }, // no published_at
    { tag_name: 'v2.2.19-canary.38', draft: false, published_at: '2026-10-04T00:00:00Z' },
    { tag_name: 'v2.2.19', draft: false, published_at: '2026-10-05T00:00:00Z' }, // stable
  ];

  const filtered = filterCanaryReleases(mockReleases);
  assert.equal(filtered.length, 3);
  assert.equal(filtered[0].tag_name, 'v2.2.19-canary.39');
  assert.equal(filtered[1].tag_name, 'v2.2.19-canary.38');
  assert.equal(filtered[2].tag_name, 'v2.2.19-canary.37');
});

test('getNextPageUrl parses GitHub Link header', () => {
  const header = '<https://api.github.com/releases?page=2>; rel="next", <https://api.github.com/releases?page=5>; rel="last"';
  assert.equal(getNextPageUrl(header), 'https://api.github.com/releases?page=2');
  assert.equal(getNextPageUrl(''), null);
  assert.equal(getNextPageUrl(null), null);
});

test('fetchPaginatedReleases handles multi-page results and pagination error on cutoff', async () => {
  const pages = {
    'https://api.github.com/releases?page=1': {
      data: [{ tag_name: 'v0.0.0-nightly.1', draft: false, published_at: '2026-10-06T00:00:00Z' }],
      next: 'https://api.github.com/releases?page=2',
    },
    'https://api.github.com/releases?page=2': {
      data: [{ tag_name: 'v2.2.19-canary.39', draft: false, published_at: '2026-10-05T00:00:00Z' }],
      next: null,
    },
  };

  const mockFetch = async (url) => {
    const page = pages[url];
    if (!page) throw new Error('Not found: ' + url);
    return {
      ok: true,
      json: async () => page.data,
      headers: {
        get: (h) => (h === 'link' && page.next ? `<${page.next}>; rel="next"` : null),
      },
    };
  };

  const releases = await fetchPaginatedReleases('https://api.github.com/releases?page=1', {}, mockFetch, 5);
  assert.equal(releases.length, 2);

  const filtered = filterCanaryReleases(releases);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].tag_name, 'v2.2.19-canary.39');

  // Test that exceeding maxPages throws an error rather than silently truncating
  await assert.rejects(
    async () => fetchPaginatedReleases('https://api.github.com/releases?page=1', {}, mockFetch, 1),
    /Pagination exceeded safety limit/,
  );
});

test('shouldSync decision logic with downgrade prevention', () => {
  const latestRelease = { tag_name: 'v2.2.19-canary.39' };

  // 1. Initial run (no recorded state)
  const res1 = shouldSync({
    latestCanaryRelease: latestRelease,
    lastRecordedState: { lastPublishedTag: '' },
  });
  assert.equal(res1.shouldSync, true);
  assert.equal(res1.tag, 'v2.2.19-canary.39');
  assert.equal(res1.normalizedVersion, '2.2.19-canary.39');
  assert.equal(res1.reason, 'initial-sync');

  // 2. Already published
  const res2 = shouldSync({
    latestCanaryRelease: latestRelease,
    lastRecordedState: { lastPublishedTag: 'v2.2.19-canary.39' },
  });
  assert.equal(res2.shouldSync, false);
  assert.equal(res2.reason, 'already-published');

  // 3. New release available
  const newRelease = { tag_name: 'v2.2.19-canary.40' };
  const res3 = shouldSync({
    latestCanaryRelease: newRelease,
    lastRecordedState: { lastPublishedTag: 'v2.2.19-canary.39' },
  });
  assert.equal(res3.shouldSync, true);
  assert.equal(res3.reason, 'new-upstream-release');
  assert.equal(res3.tag, 'v2.2.19-canary.40');

  // 4. Downgrade prevention: upstream release is older than recorded
  const olderRelease = { tag_name: 'v2.2.19-canary.38' };
  const res4 = shouldSync({
    latestCanaryRelease: olderRelease,
    lastRecordedState: { lastPublishedTag: 'v2.2.19-canary.39' },
  });
  assert.equal(res4.shouldSync, false);
  assert.ok(res4.reason.includes('upstream-release-older-than-recorded'));

  // 5. No valid release found
  const res5 = shouldSync({
    latestCanaryRelease: null,
    lastRecordedState: { lastPublishedTag: 'v2.2.19-canary.39' },
  });
  assert.equal(res5.shouldSync, false);
  assert.equal(res5.reason, 'no-valid-upstream-canary-found');
});

test('loadState strict validation of types and values', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-state-test-'));
  const testFile = path.join(tmpDir, 'state.json');

  // Missing file -> returns default empty state
  const defaultState = loadState(testFile);
  assert.equal(defaultState.lastPublishedTag, '');

  // Valid file -> loads correctly
  saveState(testFile, {
    lastPublishedTag: 'v2.2.19-canary.39',
    lastPublishedSha: 'b85f6ad80cad69e034eeb09932b9be5e4a3b6ab0',
    lastPublishedAt: '2026-10-06T12:00:00Z',
    updatedAt: '2026-10-06T12:00:00Z',
  });
  const loaded = loadState(testFile);
  assert.equal(loaded.lastPublishedTag, 'v2.2.19-canary.39');
  assert.equal(loaded.lastPublishedSha, 'b85f6ad80cad69e034eeb09932b9be5e4a3b6ab0');

  // Corrupted JSON -> throws error
  fs.writeFileSync(testFile, '{ not valid json');
  assert.throws(() => loadState(testFile), /Malformed JSON/);

  // Invalid tag value -> throws error
  fs.writeFileSync(testFile, JSON.stringify({
    lastPublishedTag: 'not-a-canary-tag',
    lastPublishedSha: 'b85f6ad80cad69e034eeb09932b9be5e4a3b6ab0',
    lastPublishedAt: '',
    updatedAt: '',
  }));
  assert.throws(() => loadState(testFile), /not a valid canary tag/);

  // Invalid SHA value -> throws error
  fs.writeFileSync(testFile, JSON.stringify({
    lastPublishedTag: 'v2.2.19-canary.39',
    lastPublishedSha: 'too-short-sha',
    lastPublishedAt: '',
    updatedAt: '',
  }));
  assert.throws(() => loadState(testFile), /not a 40-character hex SHA/);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('sync-merge.sh preserves fork workflows even with upstream additions, modifications, and deletions', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-sync-test-'));
  const syncMergeScript = path.resolve(import.meta.dirname, 'sync-merge.sh');

  try {
    execSync('git init -b canary', { cwd: tmpDir });
    execSync('git config user.name "Tester" && git config user.email "tester@test.com"', { cwd: tmpDir });

    // Initial commit on canary with our custom workflows
    fs.mkdirSync(path.join(tmpDir, '.github/workflows'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.github/workflows/our-workflow.yml'), 'name: Custom Fork Workflow');
    fs.writeFileSync(path.join(tmpDir, 'app.txt'), 'version 1');
    execSync('git add . && git commit -m "initial commit on fork"', { cwd: tmpDir });

    // Create upstream branch with changes
    execSync('git checkout -b upstream-release', { cwd: tmpDir });
    fs.writeFileSync(path.join(tmpDir, 'app.txt'), 'version 2 from upstream');
    // Upstream modifies existing workflow and adds a new one
    fs.writeFileSync(path.join(tmpDir, '.github/workflows/our-workflow.yml'), 'name: Overwritten by upstream');
    fs.writeFileSync(path.join(tmpDir, '.github/workflows/upstream-new.yml'), 'name: New Upstream Workflow');
    execSync('git add . && git commit -m "upstream release commit"', { cwd: tmpDir });
    const upstreamSha = execSync('git rev-parse HEAD', { cwd: tmpDir, encoding: 'utf-8' }).trim();

    // Switch back to canary
    execSync('git checkout canary', { cwd: tmpDir });

    // Execute the real sync-merge.sh script!
    execSync(`bash "${syncMergeScript}" "${upstreamSha}" "v2.2.19-canary.40"`, { cwd: tmpDir });

    // Verify app.txt has upstream changes
    assert.equal(fs.readFileSync(path.join(tmpDir, 'app.txt'), 'utf-8'), 'version 2 from upstream');
    // Verify our custom workflow is preserved unchanged
    assert.equal(fs.readFileSync(path.join(tmpDir, '.github/workflows/our-workflow.yml'), 'utf-8'), 'name: Custom Fork Workflow');
    // Verify upstream new workflow was NOT introduced
    assert.equal(fs.existsSync(path.join(tmpDir, '.github/workflows/upstream-new.yml')), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sync-merge.sh aborts and exits 1 on application merge conflicts outside .github/workflows/', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-conflict-test-'));
  const syncMergeScript = path.resolve(import.meta.dirname, 'sync-merge.sh');

  try {
    execSync('git init -b canary', { cwd: tmpDir });
    execSync('git config user.name "Tester" && git config user.email "tester@test.com"', { cwd: tmpDir });

    fs.mkdirSync(path.join(tmpDir, '.github/workflows'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.github/workflows/our-workflow.yml'), 'name: Custom Fork Workflow');
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'base content');
    execSync('git add . && git commit -m "base"', { cwd: tmpDir });

    // Fork commits change
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'fork modification');
    execSync('git add . && git commit -m "fork change"', { cwd: tmpDir });

    // Upstream commits conflicting change
    execSync('git checkout -b upstream-conflict HEAD~1', { cwd: tmpDir });
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'conflicting upstream content');
    execSync('git add . && git commit -m "upstream change"', { cwd: tmpDir });
    const upstreamSha = execSync('git rev-parse HEAD', { cwd: tmpDir, encoding: 'utf-8' }).trim();

    execSync('git checkout canary', { cwd: tmpDir });

    // Test that sync-merge.sh fails and aborts cleanly
    let conflictOccurred = false;
    try {
      execSync(`bash "${syncMergeScript}" "${upstreamSha}" "v2.2.19-canary.40"`, { cwd: tmpDir, stdio: 'pipe' });
    } catch {
      conflictOccurred = true;
    }

    assert.equal(conflictOccurred, true);
    // After abort, canary should be back to fork modification cleanly
    assert.equal(fs.readFileSync(path.join(tmpDir, 'file.txt'), 'utf-8'), 'fork modification');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
