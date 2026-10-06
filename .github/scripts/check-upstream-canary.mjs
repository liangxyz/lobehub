import fs from 'node:fs';
import path from 'node:path';

/**
 * Normalizes a version tag by removing any leading 'v'.
 * @param {string} tag
 * @returns {string}
 */
export function normalizeVersion(tag) {
  if (!tag || typeof tag !== 'string') return '';
  return tag.trim().replace(/^v/, '');
}

/**
 * Validates and parses a canary tag string (e.g. "v2.2.19-canary.39" or "2.2.19-canary.39").
 * Excludes nightly, pr, and test tags.
 * @param {string} tag
 * @returns {{ valid: boolean, raw: string, normalized: string, version: string, canaryNum: number } | null}
 */
export function parseCanaryTag(tag) {
  if (!tag || typeof tag !== 'string') return null;
  const trimmed = tag.trim();

  // Must match semantic version with -canary.X
  const match = trimmed.match(/^v?(\d+\.\d+\.\d+)-canary\.(\d+)$/);
  if (!match) return null;

  return {
    valid: true,
    raw: trimmed,
    normalized: normalizeVersion(trimmed),
    version: match[1],
    canaryNum: parseInt(match[2], 10),
  };
}

/**
 * Validates git commit SHA (40-character hex string).
 * @param {string} sha
 * @returns {boolean}
 */
export function isValidSha(sha) {
  if (!sha || typeof sha !== 'string') return false;
  return /^[0-9a-f]{40}$/i.test(sha.trim());
}

/**
 * Compares two canary releases to sort in descending order (newest first).
 * Returns negative if a is newer than b, positive if b is newer than a, 0 if equal.
 */
export function compareCanaryTags(aTag, bTag) {
  const a = parseCanaryTag(aTag);
  const b = parseCanaryTag(bTag);
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;

  // Compare semantic version parts
  const aParts = a.version.split('.').map(Number);
  const bParts = b.version.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (aParts[i] !== bParts[i]) {
      return bParts[i] - aParts[i];
    }
  }

  // Compare canary number
  return b.canaryNum - a.canaryNum;
}

/**
 * Filters a list of GitHub release objects for valid canary releases.
 * Requires: non-draft, non-prerelease PR builds, valid published_at, valid canary tag.
 * @param {Array<object>} releases
 * @returns {Array<object>} Filtered and sorted descending by release semver
 */
export function filterCanaryReleases(releases) {
  if (!Array.isArray(releases)) return [];

  return releases
    .filter((r) => {
      if (!r || typeof r !== 'object') return false;
      if (r.draft === true) return false;
      if (!r.published_at || typeof r.published_at !== 'string') return false;
      if (!r.tag_name || typeof r.tag_name !== 'string') return false;

      // Must be a valid canary tag
      const parsed = parseCanaryTag(r.tag_name);
      return parsed !== null;
    })
    .sort((a, b) => compareCanaryTags(a.tag_name, b.tag_name));
}

/**
 * Parses Link header to find rel="next" URL
 * @param {string|null} linkHeader
 * @returns {string|null}
 */
export function getNextPageUrl(linkHeader) {
  if (!linkHeader || typeof linkHeader !== 'string') return null;
  const links = linkHeader.split(',');
  for (const link of links) {
    const match = link.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match && match[2] === 'next') {
      return match[1];
    }
  }
  return null;
}

/**
 * Fetches paginated releases from GitHub API until completion.
 * @param {string} initialUrl
 * @param {Record<string, string>} headers
 * @param {Function} [fetchFn=fetch]
 * @param {number} [maxPages=20]
 * @returns {Promise<Array<object>>}
 */
export async function fetchPaginatedReleases(initialUrl, headers, fetchFn = fetch, maxPages = 20) {
  const allReleases = [];
  let nextUrl = initialUrl;
  let pageCount = 0;

  while (nextUrl) {
    if (pageCount >= maxPages) {
      throw new Error(`Pagination exceeded safety limit of ${maxPages} pages; next page still exists: ${nextUrl}`);
    }
    pageCount++;
    const res = await fetchFn(nextUrl, { headers });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`GitHub API error ${res.status}: ${errText}`);
    }
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) {
      break;
    }
    allReleases.push(...data);

    const linkHeader = res.headers && typeof res.headers.get === 'function' ? res.headers.get('link') : null;
    nextUrl = getNextPageUrl(linkHeader);
  }

  return allReleases;
}

/**
 * Determines whether a sync and publish should occur.
 * @param {object} params
 * @param {object|null} params.latestCanaryRelease
 * @param {object|null} params.lastRecordedState
 * @returns {{ shouldSync: boolean, reason: string, tag: string, normalizedVersion: string }}
 */
export function shouldSync({
  latestCanaryRelease,
  lastRecordedState,
}) {
  if (!latestCanaryRelease) {
    return {
      shouldSync: false,
      reason: 'no-valid-upstream-canary-found',
      tag: '',
      normalizedVersion: '',
    };
  }

  const tag = latestCanaryRelease.tag_name;
  const parsed = parseCanaryTag(tag);
  if (!parsed) {
    return {
      shouldSync: false,
      reason: `invalid-canary-tag: ${tag}`,
      tag: '',
      normalizedVersion: '',
    };
  }
  const normalizedVersion = parsed.normalized;

  const lastPublishedTag = lastRecordedState?.lastPublishedTag || '';
  if (!lastPublishedTag) {
    return {
      shouldSync: true,
      reason: 'initial-sync',
      tag,
      normalizedVersion,
    };
  }

  const cmp = compareCanaryTags(tag, lastPublishedTag);
  if (cmp === 0) {
    return {
      shouldSync: false,
      reason: 'already-published',
      tag,
      normalizedVersion,
    };
  } else if (cmp > 0) {
    // tag is older than lastPublishedTag -> downgrade prevention
    return {
      shouldSync: false,
      reason: `upstream-release-older-than-recorded (${tag} < ${lastPublishedTag})`,
      tag,
      normalizedVersion,
    };
  }

  // cmp < 0: tag is newer than lastPublishedTag
  return {
    shouldSync: true,
    reason: 'new-upstream-release',
    tag,
    normalizedVersion,
  };
}

/**
 * Reads and strictly validates durable upstream canary state file.
 * Throws on malformed content or invalid field types.
 * @param {string} filePath
 * @returns {{ lastPublishedTag: string, lastPublishedSha: string, lastPublishedAt: string, updatedAt: string }}
 */
export function loadState(filePath) {
  if (!fs.existsSync(filePath)) {
    return {
      lastPublishedTag: '',
      lastPublishedSha: '',
      lastPublishedAt: '',
      updatedAt: '',
    };
  }

  const data = fs.readFileSync(filePath, 'utf-8');
  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch (err) {
    throw new Error(`Malformed JSON in state file at ${filePath}: ${err.message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid state file format at ${filePath}: expected a JSON object`);
  }

  // Strict type validations
  const { lastPublishedTag, lastPublishedSha, lastPublishedAt, updatedAt } = parsed;

  if (typeof lastPublishedTag !== 'string') {
    throw new Error(`Invalid state field 'lastPublishedTag': expected string, got ${typeof lastPublishedTag}`);
  }
  if (lastPublishedTag && !parseCanaryTag(lastPublishedTag)) {
    throw new Error(`Invalid 'lastPublishedTag' value in state: '${lastPublishedTag}' is not a valid canary tag`);
  }

  if (typeof lastPublishedSha !== 'string') {
    throw new Error(`Invalid state field 'lastPublishedSha': expected string, got ${typeof lastPublishedSha}`);
  }
  if (lastPublishedSha && !isValidSha(lastPublishedSha)) {
    throw new Error(`Invalid 'lastPublishedSha' value in state: '${lastPublishedSha}' is not a 40-character hex SHA`);
  }

  if (typeof lastPublishedAt !== 'string') {
    throw new Error(`Invalid state field 'lastPublishedAt': expected string, got ${typeof lastPublishedAt}`);
  }
  if (typeof updatedAt !== 'string') {
    throw new Error(`Invalid state field 'updatedAt': expected string, got ${typeof updatedAt}`);
  }

  return {
    lastPublishedTag,
    lastPublishedSha,
    lastPublishedAt,
    updatedAt,
  };
}

/**
 * Saves durable upstream canary state file.
 * @param {string} filePath
 * @param {object} state
 */
export function saveState(filePath, state) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

/**
 * CLI Handler
 */
async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'check';

  const defaultStatePath = path.resolve(import.meta.dirname, '../upstream-canary-state.json');

  if (command === 'check') {
    const stateFile = process.env.STATE_FILE || defaultStatePath;
    const state = loadState(stateFile);

    // Fetch upstream releases from GitHub API
    const token = process.env.GITHUB_TOKEN || '';
    const headers = {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'Sync-Upstream-Canary-Action',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    let releases = [];
    try {
      const initialUrl = 'https://api.github.com/repos/lobehub/lobehub/releases?per_page=50';
      releases = await fetchPaginatedReleases(initialUrl, headers, fetch, 20);
    } catch (err) {
      console.error('Error fetching upstream releases:', err.message);
      process.exit(1);
    }

    const canaryReleases = filterCanaryReleases(releases);
    const latestCanaryRelease = canaryReleases[0] || null;

    const decision = shouldSync({
      latestCanaryRelease,
      lastRecordedState: state,
    });

    console.log('Sync Decision:', JSON.stringify(decision, null, 2));

    // Export to GitHub Actions output if GITHUB_OUTPUT is set
    const githubOutput = process.env.GITHUB_OUTPUT;
    if (githubOutput) {
      fs.appendFileSync(githubOutput, `should_sync=${decision.shouldSync ? 'true' : 'false'}\n`);
      fs.appendFileSync(githubOutput, `sync_reason=${decision.reason}\n`);
      fs.appendFileSync(githubOutput, `target_tag=${decision.tag}\n`);
      fs.appendFileSync(githubOutput, `normalized_version=${decision.normalizedVersion}\n`);
    }
  } else if (command === 'record') {
    const tag = process.env.SYNCED_TAG || args[1];
    const sha = process.env.SYNCED_SHA || args[2];
    const stateFile = process.env.STATE_FILE || defaultStatePath;

    if (!tag || !sha) {
      console.error('Usage: check-upstream-canary.mjs record <tag> <sha>');
      process.exit(1);
    }

    if (!parseCanaryTag(tag)) {
      console.error(`Invalid canary tag format: ${tag}`);
      process.exit(1);
    }

    if (!isValidSha(sha)) {
      console.error(`Invalid commit SHA format: ${sha}`);
      process.exit(1);
    }

    const currentState = loadState(stateFile);
    currentState.lastPublishedTag = tag;
    currentState.lastPublishedSha = sha;
    currentState.lastPublishedAt = new Date().toISOString();
    currentState.updatedAt = new Date().toISOString();

    saveState(stateFile, currentState);
    console.log(`Successfully recorded published state for ${tag} (${sha}) in ${stateFile}`);
  } else {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
