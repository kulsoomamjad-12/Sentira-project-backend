/**
 * Apify integration — fetches comments off a social media post URL via an
 * Apify Actor (a pre-built scraper), so they can be run through the same
 * sentiment analysis as everything else in this app.
 *
 * IMPORTANT / honest caveat: the actors below are well-known, commonly used
 * public Actors on the Apify Store for each platform, but Actor maintainers
 * do occasionally rename their input/output fields. This module was written
 * without a live Apify token to test against (none was available), so:
 *   - `buildActorInput` sends several common aliases for the post URL and
 *     result-limit fields at once (extra fields an Actor doesn't recognize
 *     are simply ignored), to maximize the odds it works unmodified.
 *   - `normalizeComments` likewise tries several common output field names
 *     per platform before giving up on a field.
 * The first real run per platform (once APIFY_TOKEN is set) should be
 * checked against the actual dataset items — see the note in
 * fetchComments() below for how to inspect raw output if a platform comes
 * back with blank/garbled comments.
 */

const APIFY_BASE = 'https://api.apify.com/v2';

// One well-known public Actor per platform. Swap any of these for a
// different Actor ID (e.g. a paid/more reliable one you prefer) without
// touching the rest of this file.
const PLATFORM_ACTORS = {
  instagram: 'apify/instagram-comment-scraper',
  facebook: 'apify/facebook-comments-scraper',
  youtube: 'streamers/youtube-comments-scraper',
  tiktok: 'clockworks/tiktok-comments-scraper',
  linkedin: 'apimaestro/linkedin-post-comments-replies-engagements-scraper',
};

const PLATFORMS = Object.keys(PLATFORM_ACTORS);

function assertKnownPlatform(platform) {
  if (!PLATFORM_ACTORS[platform]) {
    throw new Error(`Unsupported platform "${platform}" — expected one of: ${PLATFORMS.join(', ')}`);
  }
}

// Sends the post URL and a result cap under every common field name an
// Apify comment-scraper Actor might expect. Actors ignore input fields they
// don't recognize, so this is safe rather than guessing wrong and getting
// zero results back.
function buildActorInput(url, limit) {
  return {
    url,
    directUrls: [url],
    startUrls: [{ url }],
    postURLs: [url],
    videoUrl: url,
    resultsLimit: limit,
    maxComments: limit,
    maxResults: limit,
    commentsPerPost: limit,
  };
}

async function runActor(actorId, input) {
  const token = process.env.APIFY_TOKEN;
  if (!token) {
    throw new Error(
      'APIFY_TOKEN is not set. Get an API token from your Apify account (Settings → Integrations → API tokens) and add it to backend/.env as APIFY_TOKEN=...'
    );
  }

  const url = `${APIFY_BASE}/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?token=${encodeURIComponent(
    token
  )}&timeout=100`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Apify actor run failed: ${response.status} ${response.statusText} ${body.slice(0, 300)}`.trim());
  }

  return response.json(); // array of raw dataset items
}

// Defensive field-name lookup: tries each candidate key in order, returns
// the first defined, non-empty, PRIMITIVE value (skips objects/arrays —
// e.g. a nested `{ author: { name: "..." } }` shape — so callers can fall
// through to a more specific nested lookup instead of stringifying it).
function pick(item, keys) {
  for (const key of keys) {
    const value = item?.[key];
    if (value !== undefined && value !== null && value !== '' && typeof value !== 'object') return value;
  }
  return undefined;
}

// LinkedIn comment Actors commonly nest the commenter under an
// author/commenter/actor object (e.g. { author: { name: "..." } }) instead
// of a flat field — this checks those shapes before giving up.
function pickNestedName(item) {
  for (const key of ['author', 'commenter', 'actor', 'commentator']) {
    const nested = item?.[key];
    if (nested && typeof nested === 'object') {
      const name = nested.name || nested.fullName || nested.title || nested.username;
      if (name) return name;
    }
  }
  return undefined;
}

// Normalizes one platform's raw dataset items into a common shape:
// { externalId, author, text, timestamp }. Filters out anything with no
// usable comment text.
function normalizeComments(items) {
  return (items || [])
    .map((item) => {
      const text = pick(item, ['text', 'comment', 'commentText', 'caption', 'message', 'commentary']);
      const author =
        pick(item, [
          'ownerUsername',
          'author',
          'uniqueId',
          'profileName',
          'facebookName',
          'authorName',
          'username',
          'fullName',
          'commenterName',
          'name',
        ]) || pickNestedName(item);
      const timestamp = pick(item, ['timestamp', 'date', 'createTimeISO', 'publishedAt', 'publishedTimeText']);
      const rawId = pick(item, ['id', 'commentId', 'cid', 'commentUniqueId']);
      const externalId = rawId
        ? String(rawId)
        : // No id field found on this Actor's output — fall back to a
          // content-based key so re-running the same import still mostly
          // dedupes, even without a real platform comment ID.
          `${author || 'unknown'}:${String(text || '').slice(0, 80)}`;

      return {
        externalId,
        author: author ? String(author) : 'Unknown',
        text: text ? String(text).trim() : '',
        timestamp: timestamp || null,
      };
    })
    .filter((c) => c.text.length >= 2);
}

// Fetches + normalizes comments for one post URL on one platform.
async function fetchComments(platform, url, limit = 30) {
  assertKnownPlatform(platform);
  const actorId = PLATFORM_ACTORS[platform];
  const input = buildActorInput(url, limit);
  const items = await runActor(actorId, input);
  return normalizeComments(items);
}

module.exports = { PLATFORM_ACTORS, PLATFORMS, fetchComments, normalizeComments, buildActorInput };
