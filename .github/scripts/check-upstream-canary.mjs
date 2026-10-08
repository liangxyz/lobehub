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
 * Validates and parses a canary tag string (strictly canary format, e.g. "v2.2.19-canary.39").
 * Excludes stable, nightly, pr, and test tags.
 * @param {string} tag
 * @returns {{ valid: boolean, raw: string, normalized: string, version: string, canaryNum: number } | null}
 */
export function parseCanaryTag(tag) {
  if (!tag || typeof tag !== 'string') return null;
  const trimmed = tag.trim();

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
 * Validates and parses a release tag string.
 * Supports:
 * - Stable releases: "v2.2.19" or "2.2.19" (channel: 'stable')
 * - Canary releases: "v2.2.19-canary.39" or "2.2.19-canary.39" (channel: 'canary')
 * Excludes: nightly, pr, and draft tags.
 * @param {string} tag
 * @returns {{ valid: boolean, raw: string, normalized: string, version: string, isCanary: boolean, canaryNum: number | null, channel: 'stable' | 'canary' } | null}
 */
export function parseReleaseTag(tag) {
  if (!tag || typeof tag !== 'string') return null;
  const trimmed = tag.trim();

  // Match semantic version with optional -canary.X
  const match = trimmed.match(/^v?(\d+\.\d+\.\d+)(?:-canary\.(\d+))?$/);
  if (!match) return null;

  const version = match[1];
  const isCanary = typeof match[2] !== 'undefined';
  const canaryNum = isCanary ? parseInt(match[2], 10) : null;
  const channel = isCanary ? 'canary' : 'stable';

  return {
    valid: true,
    raw: trimmed,
    normalized: normalizeVersion(trimmed),
    version,
    isCanary,
    canaryNum,
    channel,
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
 * Compares two stable releases (newest first).
 * Returns negative if a is newer than b, positive if b is newer than a, 0 if equal.
 */
export function compareStableTags(aTag, bTag) {
  const a = parseReleaseTag(aTag);
  const b = parseReleaseTag(bTag);
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;

  const aParts = a.version.split('.').map(Number);
  const bParts = b.version.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (aParts[i] !== bParts[i]) {
      return bParts[i] - aParts[i];
    }
  }
  return 0;
}

/**
 * Compares two canary releases (newest first).
 * Returns negative if a is newer than b, positive if b is newer than a, 0 if equal.
 */
export function compareCanaryTags(aTag, bTag) {
  const a = parseCanaryTag(aTag);
  const b = parseCanaryTag(bTag);
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;

  const aParts = a.version.split('.').map(Number);
  const bParts = b.version.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (aParts[i] !== bParts[i]) {
      return bParts[i] - aParts[i];
    }
  }

  return (b.canaryNum ?? 0) - (a.canaryNum ?? 0);
}

/**
 * Filters a list of GitHub release objects for valid canary releases.
 * Provided for backward compatibility.
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

      return parseCanaryTag(r.tag_name) !== null;
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
 * Filters and categorizes releases into stable and canary lists.
 * Requires: non-draft, non-empty tag, valid published_at ISO string.
 * @param {Array<object>} releases
 * @returns {{ latestStable: object | null, latestCanary: object | null }}
 */
export function categorizeReleases(releases) {
  if (!Array.isArray(releases)) return { latestStable: null, latestCanary: null };

  const validReleases = releases.filter((r) => {
    if (!r || typeof r !== 'object') return false;
    if (r.draft === true) return false;
    if (!r.published_at || typeof r.published_at !== 'string' || isNaN(new Date(r.published_at).getTime())) return false;
    if (!r.tag_name || typeof r.tag_name !== 'string') return false;

    const parsed = parseReleaseTag(r.tag_name);
    if (!parsed) return false;

    // Strict channel matching with prerelease field
    if (parsed.channel === 'stable' && r.prerelease !== false) return false;
    if (parsed.channel === 'canary' && r.prerelease !== true) return false;

    return true;
  });

  const stableReleases = validReleases
    .filter((r) => parseReleaseTag(r.tag_name)?.channel === 'stable')
    .sort((a, b) => compareStableTags(a.tag_name, b.tag_name));

  const canaryReleases = validReleases
    .filter((r) => parseReleaseTag(r.tag_name)?.channel === 'canary')
    .sort((a, b) => compareCanaryTags(a.tag_name, b.tag_name));

  return {
    latestStable: stableReleases[0] || null,
    latestCanary: canaryReleases[0] || null,
  };
}

/**
 * Determines whether a specific channel should sync.
 * @param {object | null} latestRelease
 * @param {object | null} channelState
 * @param {'stable' | 'canary'} channel
 * @returns {{ shouldSync: boolean, reason: string, tag: string, normalizedVersion: string, channel: string, publishedAt: string }}
 */
export function checkChannelSync(latestRelease, channelState, channel) {
  if (!latestRelease) {
    return {
      shouldSync: false,
      reason: `no-valid-${channel}-found`,
      tag: '',
      normalizedVersion: '',
      channel,
      publishedAt: '',
    };
  }

  const tag = latestRelease.tag_name;
  const parsed = parseReleaseTag(tag);
  if (!parsed || parsed.channel !== channel) {
    return {
      shouldSync: false,
      reason: `tag-not-in-channel-${channel}: ${tag}`,
      tag: '',
      normalizedVersion: '',
      channel,
      publishedAt: '',
    };
  }

  const lastPublishedTag = channelState?.lastPublishedTag || '';
  if (!lastPublishedTag) {
    return {
      shouldSync: true,
      reason: `initial-${channel}-sync`,
      tag,
      normalizedVersion: parsed.normalized,
      channel,
      publishedAt: latestRelease.published_at,
    };
  }

  const cmp = channel === 'canary'
    ? compareCanaryTags(tag, lastPublishedTag)
    : compareStableTags(tag, lastPublishedTag);

  if (cmp === 0) {
    return {
      shouldSync: false,
      reason: `already-published-${channel}`,
      tag,
      normalizedVersion: parsed.normalized,
      channel,
      publishedAt: latestRelease.published_at,
    };
  } else if (cmp > 0) {
    return {
      shouldSync: false,
      reason: `${channel}-older-than-recorded (${tag} < ${lastPublishedTag})`,
      tag,
      normalizedVersion: parsed.normalized,
      channel,
      publishedAt: latestRelease.published_at,
    };
  }

  return {
    shouldSync: true,
    reason: `new-${channel}-release`,
    tag,
    normalizedVersion: parsed.normalized,
    channel,
    publishedAt: latestRelease.published_at,
  };
}

/**
 * Selects which channel to sync if multiple are eligible.
 * Prioritizes whichever release was published more recently, defaulting to stable on tie.
 */
export function selectPendingSync(stableDecision, canaryDecision) {
  if (stableDecision.shouldSync && canaryDecision.shouldSync) {
    const stableDate = new Date(stableDecision.publishedAt).getTime();
    const canaryDate = new Date(canaryDecision.publishedAt).getTime();
    if (!isNaN(canaryDate) && !isNaN(stableDate) && canaryDate > stableDate) {
      return canaryDecision;
    }
    return stableDecision;
  }
  if (stableDecision.shouldSync) return stableDecision;
  if (canaryDecision.shouldSync) return canaryDecision;

  return {
    shouldSync: false,
    reason: 'already-up-to-date',
    tag: '',
    normalizedVersion: '',
    channel: '',
    publishedAt: '',
  };
}

/**
 * Backward compatible shouldSync function for existing callers and test suites.
 * @param {object} params
 * @param {object | null} params.latestCanaryRelease
 * @param {object | null} params.lastRecordedState
 * @returns {{ shouldSync: boolean, reason: string, tag: string, normalizedVersion: string }}
 */
export function shouldSync({ latestCanaryRelease, lastRecordedState }) {
  const canaryState = lastRecordedState?.canary || lastRecordedState;
  const decision = checkChannelSync(latestCanaryRelease, canaryState, 'canary');
  return {
    shouldSync: decision.shouldSync,
    reason: decision.reason,
    tag: decision.tag,
    normalizedVersion: decision.normalizedVersion,
  };
}

/**
 * Reads and strictly validates durable upstream release state file.
 * Handles both channelized state and legacy flat state with strict typing.
 * @param {string} filePath
 * @returns {{ canary: { lastPublishedTag: string, lastPublishedSha: string, lastPublishedAt: string, updatedAt: string }, stable: { lastPublishedTag: string, lastPublishedSha: string, lastPublishedAt: string, updatedAt: string }, lastPublishedTag: string, lastPublishedSha: string }}
 */
export function loadState(filePath) {
  const defaultChannelState = () => ({
    lastPublishedTag: '',
    lastPublishedSha: '',
    lastPublishedAt: '',
    updatedAt: '',
  });

  if (!fs.existsSync(filePath)) {
    return {
      canary: defaultChannelState(),
      stable: defaultChannelState(),
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

  // Handle migration from legacy flat state
  const canaryRaw = parsed.canary || (parsed.lastPublishedTag?.includes('canary') ? parsed : defaultChannelState());
  const stableRaw = parsed.stable || (!parsed.lastPublishedTag?.includes('canary') && parsed.lastPublishedTag ? parsed : defaultChannelState());

  const validateChannel = (c, expectedChannel) => {
    if (!c || typeof c !== 'object') {
      throw new Error(`Invalid ${expectedChannel} section in state file: expected object`);
    }

    const { lastPublishedTag, lastPublishedSha, lastPublishedAt, updatedAt } = c;

    if (typeof lastPublishedTag !== 'string') {
      throw new Error(`Invalid 'lastPublishedTag' in ${expectedChannel} state: expected string, got ${typeof lastPublishedTag}`);
    }
    if (lastPublishedTag) {
      const parsedTag = parseReleaseTag(lastPublishedTag);
      if (!parsedTag) {
        throw new Error(`Invalid 'lastPublishedTag' in ${expectedChannel} state: '${lastPublishedTag}' is not a valid release tag`);
      }
      if (parsedTag.channel !== expectedChannel) {
        throw new Error(`Channel mismatch in ${expectedChannel} state: tag '${lastPublishedTag}' belongs to channel '${parsedTag.channel}'`);
      }
    }

    if (typeof lastPublishedSha !== 'string') {
      throw new Error(`Invalid 'lastPublishedSha' in ${expectedChannel} state: expected string, got ${typeof lastPublishedSha}`);
    }
    if (lastPublishedSha && !isValidSha(lastPublishedSha)) {
      throw new Error(`Invalid 'lastPublishedSha' in ${expectedChannel} state: '${lastPublishedSha}' is not a 40-character hex SHA`);
    }

    if (typeof lastPublishedAt !== 'string') {
      throw new Error(`Invalid 'lastPublishedAt' in ${expectedChannel} state: expected string, got ${typeof lastPublishedAt}`);
    }
    if (typeof updatedAt !== 'string') {
      throw new Error(`Invalid 'updatedAt' in ${expectedChannel} state: expected string, got ${typeof updatedAt}`);
    }

    return {
      lastPublishedTag,
      lastPublishedSha,
      lastPublishedAt,
      updatedAt,
    };
  };

  const canary = validateChannel(canaryRaw, 'canary');
  const stable = validateChannel(stableRaw, 'stable');

  return {
    canary,
    stable,
    lastPublishedTag: canary.lastPublishedTag || stable.lastPublishedTag || '',
    lastPublishedSha: canary.lastPublishedSha || stable.lastPublishedSha || '',
  };
}

/**
 * Saves durable upstream release state file.
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
      'User-Agent': 'Sync-Upstream-Releases-Action',
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

    const { latestStable, latestCanary } = categorizeReleases(releases);

    const stableDecision = checkChannelSync(latestStable, state.stable, 'stable');
    const canaryDecision = checkChannelSync(latestCanary, state.canary, 'canary');

    console.log('Stable Release Candidate:', JSON.stringify(stableDecision, null, 2));
    console.log('Canary Release Candidate:', JSON.stringify(canaryDecision, null, 2));

    const decision = selectPendingSync(stableDecision, canaryDecision);
    console.log('Final Sync Decision:', JSON.stringify(decision, null, 2));

    // Export to GitHub Actions output if GITHUB_OUTPUT is set
    const githubOutput = process.env.GITHUB_OUTPUT;
    if (githubOutput) {
      fs.appendFileSync(githubOutput, `should_sync=${decision.shouldSync ? 'true' : 'false'}\n`);
      fs.appendFileSync(githubOutput, `sync_reason=${decision.reason}\n`);
      fs.appendFileSync(githubOutput, `target_tag=${decision.tag}\n`);
      fs.appendFileSync(githubOutput, `normalized_version=${decision.normalizedVersion}\n`);
      fs.appendFileSync(githubOutput, `channel=${decision.channel}\n`);
    }
  } else if (command === 'record') {
    const tag = process.env.SYNCED_TAG || args[1];
    const sha = process.env.SYNCED_SHA || args[2];
    const stateFile = process.env.STATE_FILE || defaultStatePath;

    if (!tag || !sha) {
      console.error('Usage: check-upstream-canary.mjs record <tag> <sha>');
      process.exit(1);
    }

    const parsed = parseReleaseTag(tag);
    if (!parsed) {
      console.error(`Invalid release tag format: ${tag}`);
      process.exit(1);
    }

    if (!isValidSha(sha)) {
      console.error(`Invalid commit SHA format: ${sha}`);
      process.exit(1);
    }

    const currentState = loadState(stateFile);
    const channel = parsed.channel;
    const now = new Date().toISOString();

    currentState[channel] = {
      lastPublishedTag: tag,
      lastPublishedSha: sha,
      lastPublishedAt: now,
      updatedAt: now,
    };

    // Keep top-level compatibility keys
    currentState.lastPublishedTag = tag;
    currentState.lastPublishedSha = sha;
    currentState.lastPublishedAt = now;
    currentState.updatedAt = now;

    saveState(stateFile, currentState);
    console.log(`Successfully recorded published ${channel} state for ${tag} (${sha}) in ${stateFile}`);
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
