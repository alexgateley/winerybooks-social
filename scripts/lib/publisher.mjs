// The @TheWineryBooks publisher's logic, separate from the command (scripts/publish.mjs) so the tests can
// run it against a temporary repository folder with a fake fetch and a fixed clock.
//
// posts/schedule.json maps a date to a post folder: { "2026-11-02": "my-first-reel" }. A date that
// is not listed posts nothing, so an empty schedule means nothing ever posts.
//
// Two layers stop a post going out at the wrong time or twice:
//   1. The time of day: a listed date is due from 12:00 PM Pacific (brand.json post.hour) to midnight.
//   2. The marker: published/<date>.json means "already posted", whatever the run.
// `POST_DATE` posts a listed date now, whatever the hour; its marker still applies.
import fs from 'node:fs';
import path from 'node:path';

export const GRAPH = 'https://graph.instagram.com';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const FOLDER_RE = /^[a-z0-9][a-z0-9-]*$/;
/** Instagram's caption limit (characters). */
export const CAPTION_MAX = 2200;

export function readBrand(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'brand.json'), 'utf8'));
}

const readJson = (file, fallback) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback);

/** Date, hour and minute on the wall clock in `timeZone` (daylight saving included). */
export function localParts(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit', hour12: false, weekday: 'short',
    }).formatToParts(date).map((p) => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24, minute: Number(parts.minute), weekday: parts.weekday };
}

const HASHTAG_RE = /(^|\s)#[\p{L}\p{N}_]+/gu;
export const countHashtags = (text) => (text.match(HASHTAG_RE) || []).length;

/**
 * Keeps a caption within the hashtag limit: if it has more than `max`, the trailing line of hashtags
 * is cut down so the whole caption has `max`.
 */
export function limitHashtags(caption, max) {
  const total = countHashtags(caption);
  if (!max || total <= max) return { caption, removed: [] };
  const lines = caption.split('\n');
  const last = lines[lines.length - 1].trim();
  const tokens = last.split(/\s+/);
  if (!tokens.every((t) => t.startsWith('#'))) return { caption, removed: [], over: total - max };
  const before = total - tokens.length;
  const keep = Math.max(0, max - before);
  lines[lines.length - 1] = tokens.slice(0, keep).join(' ');
  const removed = tokens.slice(keep);
  return { caption: lines.join('\n').trimEnd(), removed, over: Math.max(0, before - max) };
}

/** The one-line way to record a by-hand post from anywhere: the workflow writes the marker on main. */
export const byHandCommand = (brand, date) => `gh workflow run "Post @${brand.handle}" --repo ${brand.repo} -f date=${date} -f by_hand=true`;

/**
 * A marker counts only on main: the job checks out main and nothing else. Before `mark` writes one in
 * a local clone, the clone must be on main and not behind origin/main (after a fetch). `git(args)`
 * runs git in the clone and returns { status, stdout, stderr } (the tests pass a fake).
 * Resolves to { ok, reason, fix }.
 */
export function checkMarkBranch(git) {
  const head = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (head.status !== 0) return { ok: false, reason: `this folder is not a git clone (${String(head.stderr || '').trim()})`, fix: null };
  const branch = head.stdout.trim();
  if (branch !== 'main') {
    return { ok: false, reason: `this clone is on "${branch}", but the job reads main only, so a marker committed here would not stop it`, fix: 'git switch main && git pull --rebase origin main' };
  }
  const fetched = git(['fetch', '--quiet', 'origin', 'main']);
  if (fetched.status !== 0) return { ok: false, reason: `could not fetch origin main (${String(fetched.stderr || '').trim().split('\n')[0]})`, fix: null };
  const behind = Number(git(['rev-list', '--count', 'HEAD..origin/main']).stdout.trim() || 0);
  if (behind > 0) {
    return { ok: false, reason: `main is ${behind} commit${behind === 1 ? '' : 's'} behind origin/main (the job commits a marker after every post), so the push would be refused`, fix: 'git pull --rebase origin main' };
  }
  return { ok: true };
}

/**
 * createPublisher({ root, fetch, now, env, log, warn, sleep }) → { publish, mark, refresh, check }
 *
 * root   the repository folder (brand.json, posts/, published/)
 * fetch  the HTTP client (the tests pass a fake)
 * now    () => Date, the clock
 * env    IG_ACCESS_TOKEN, IG_USER_ID, PAGES_BASE_URL, POST_DATE, DRY_RUN, GITHUB_ACTIONS
 */
export function createPublisher({
  root,
  fetch: fetchImpl = globalThis.fetch,
  now = () => new Date(),
  env = process.env,
  log = console.log,
  warn = console.error,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  if (!root) throw new Error('createPublisher needs root');
  const brand = readBrand(root);
  const TZ = brand.timezone || 'America/Los_Angeles';
  const { hour: postHour, label: postLabel, schedule: scheduleFile } = brand.post;
  const postsUrlDir = brand.postsDir || 'posts';
  const postsDir = path.join(root, postsUrlDir);
  const publishedDir = path.join(root, brand.publishedDir || 'published');
  const maxTags = brand.hashtagRules?.maxPerPost ?? 5;

  const token = env.IG_ACCESS_TOKEN || '';
  const userId = env.IG_USER_ID || '';
  const base = (env.PAGES_BASE_URL || brand.pagesBaseUrl || '').replace(/\/$/, '');
  const dryRun = env.DRY_RUN === 'true';

  async function api(endpoint, params = {}, method = 'POST') {
    const url = `${GRAPH}/${endpoint}`;
    const body = new URLSearchParams({ ...params, access_token: token });
    const res = method === 'GET' ? await fetchImpl(`${url}?${body}`) : await fetchImpl(url, { method, body });
    const json = await res.json();
    if (!res.ok || json.error) throw new Error(`${endpoint}: ${JSON.stringify(json.error ?? json)}`);
    return json;
  }

  async function assertReachable(url) {
    const head = await fetchImpl(url, { method: 'HEAD' });
    if (!head.ok) throw new Error(`Not reachable (${head.status}): ${url}. Has GitHub Pages finished deploying?`);
  }

  /** Waits until Instagram has processed a media container. */
  async function waitForContainer(creationId, attempts, delayMs) {
    for (let i = 0; i < attempts; i++) {
      const { status_code: status } = await api(creationId, { fields: 'status_code' }, 'GET');
      if (status === 'FINISHED') return;
      if (status === 'ERROR' || status === 'EXPIRED') throw new Error(`Instagram reported ${status} while processing the upload`);
      await sleep(delayMs);
    }
    throw new Error('Instagram did not finish processing the upload in time');
  }

  function writeMarker(file, data) {
    fs.mkdirSync(publishedDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...data, postedAt: now().toISOString() }, null, 2) + '\n');
  }

  const markerPath = (date) => path.join(publishedDir, `${date}.json`);
  const rel = (p) => path.relative(root, p);

  function requireCredentials() {
    if (!token || !userId || !base) throw new Error('IG_ACCESS_TOKEN, IG_USER_ID and PAGES_BASE_URL (or pagesBaseUrl in brand.json) must all be set');
  }

  function readCaption(file, label) {
    const raw = fs.readFileSync(file, 'utf8').trim();
    const { caption, removed, over } = limitHashtags(raw, maxTags);
    if (removed.length) warn(`WARNING: ${label}: the caption had more than ${maxTags} hashtags; not posting ${removed.join(' ')}`);
    if (over) throw new Error(`${label}: the caption has ${countHashtags(raw)} hashtags outside its last line; the limit is ${maxTags}`);
    if (caption.length > CAPTION_MAX) throw new Error(`${label}: the caption is ${caption.length} characters; Instagram allows ${CAPTION_MAX}`);
    return caption;
  }

  const showCaption = (caption) => caption.split('\n').map((l) => `  | ${l}`).join('\n');

  async function postDate({ date, forced, local, result }) {
    const label = `${date} (${postLabel})`;
    if (!forced && !dryRun && local.hour < postHour) {
      log(`${label}: it is ${local.hour}:${String(local.minute).padStart(2, '0')} in ${TZ}; posts go out from ${postHour}:00. Nothing to do yet.`);
      result.skipped.push({ date, reason: 'before-hour' });
      return;
    }
    const folder = readJson(path.join(root, scheduleFile), {})[date];
    if (!folder) {
      log(`${label}: nothing scheduled (${scheduleFile} has no ${date}).`);
      result.skipped.push({ date, reason: 'not-scheduled' });
      return;
    }
    const marker = markerPath(date);
    if (fs.existsSync(marker)) {
      log(`${label}: already posted (${rel(marker)}).`);
      result.skipped.push({ date, reason: 'posted' });
      return;
    }
    if (!FOLDER_RE.test(folder)) throw new Error(`${label}: ${scheduleFile} names "${folder}", which is not a post folder name`);
    const dir = path.join(postsDir, folder);
    if (!fs.existsSync(path.join(dir, 'reel.mp4'))) throw new Error(`${label}: ${postsUrlDir}/${folder}/reel.mp4 is missing`);
    const meta = readJson(path.join(dir, 'meta.json'), {});
    if (meta.date && meta.date !== date) throw new Error(`${label}: ${folder}/meta.json says date ${meta.date}; the schedule and the folder disagree`);
    const caption = readCaption(path.join(dir, 'caption.txt'), label);
    const thumbOffsetMs = Number.isInteger(meta.thumbOffsetMs) ? meta.thumbOffsetMs : 0;
    if (!dryRun) requireCredentials();
    const video_url = `${base}/${postsUrlDir}/${folder}/reel.mp4`;
    log(`Posting @${brand.handle} ${label} Reel (${folder}), cover at ${thumbOffsetMs} ms\n  ${video_url}`);
    if (dryRun) {
      log(`Caption (${countHashtags(caption)} hashtags):\n${showCaption(caption)}`);
      log('DRY RUN: not calling the API.');
      result.dryRun.push({ date, folder, video_url, caption, thumbOffsetMs });
      return;
    }

    await assertReachable(video_url);
    const { id: creationId } = await api(`${userId}/media`, {
      media_type: 'REELS',
      video_url,
      caption,
      share_to_feed: 'true',
      thumb_offset: String(thumbOffsetMs),
    });
    // Video is transcoded before it can be published, which takes longer than images
    await waitForContainer(creationId, 60, 5000);
    const { id: mediaId } = await api(`${userId}/media_publish`, { creation_id: creationId });
    writeMarker(marker, { date, folder, mediaId, kind: 'reel', thumbOffsetMs });
    log(`Published Reel: media id ${mediaId}`);
    result.posted.push({ date, folder, mediaId });
  }

  /** Posts today's Reel if it is due and not yet posted. Resolves to { date, posted, skipped, dryRun, errors }. */
  async function publish() {
    const forced = (env.POST_DATE || '').trim();
    if (forced && !DATE_RE.test(forced)) throw new Error(`POST_DATE must be YYYY-MM-DD, not "${forced}"`);
    const local = localParts(now(), TZ);
    const date = forced || local.date;
    const result = { date, posted: [], skipped: [], dryRun: [], errors: [] };
    if (dryRun && !forced) log(`DRY RUN for ${date} (${local.hour}:${String(local.minute).padStart(2, '0')} in ${TZ}): the hour check is skipped.`);
    try {
      await postDate({ date, forced, local, result });
    } catch (e) {
      warn(`ERROR: ${e.message}`);
      result.errors.push({ message: e.message });
    }
    return result;
  }

  /**
   * Records a post put up by hand, so the job won't post it again:
   *   node scripts/publish.mjs mark --date 2026-11-02
   * The job reads main only, so the marker counts once it is on main: the workflow's by_hand input
   * writes it there; run locally, scripts/publish.mjs first checks this clone is on an up-to-date main
   * (checkMarkBranch above).
   */
  function mark({ date, note } = {}) {
    if (!date || !DATE_RE.test(date)) throw new Error('mark needs --date YYYY-MM-DD');
    const file = markerPath(date);
    if (fs.existsSync(file)) {
      log(`${rel(file)} already exists; nothing changed.`);
      return { file, written: false };
    }
    const folder = readJson(path.join(root, scheduleFile), {})[date];
    writeMarker(file, { date, ...(folder ? { folder } : {}), mediaId: 'by-hand', kind: 'reel', ...(note ? { note } : {}) });
    log(`Wrote ${rel(file)}: the job will not post ${date}.`);
    if (env.GITHUB_ACTIONS !== 'true') {
      log(`Commit it and push it to main (the only branch the job reads) before ${postLabel}:\n  git add ${rel(file)} && git commit -m "Posted ${date} by hand" && git push origin main`);
    }
    return { file, written: true };
  }

  async function refresh() {
    if (!token) throw new Error('IG_ACCESS_TOKEN is not set');
    const res = await fetchImpl(`${GRAPH}/refresh_access_token?grant_type=ig_refresh_token&access_token=${token}`);
    const json = await res.json();
    if (!res.ok || json.error) {
      // Tokens under 24 hours old can't be refreshed yet; that's fine
      log(`Token not refreshed: ${JSON.stringify(json.error ?? json)}`);
      return false;
    }
    fs.writeFileSync(path.join(root, 'new-token.txt'), json.access_token);
    fs.writeFileSync(path.join(root, 'new-token-expires-in.txt'), String(json.expires_in));
    log(`Token refreshed; valid for ${Math.round(json.expires_in / 86400)} more days`);
    return true;
  }

  // Read-only: proves the token, the user id and the content-publishing permission all work
  async function check() {
    if (!token || !userId) throw new Error('IG_ACCESS_TOKEN and IG_USER_ID must be set');
    const me = await api('me', { fields: 'user_id,username' }, 'GET');
    const limit = await api(`${userId}/content_publishing_limit`, { fields: 'quota_usage,config' }, 'GET');
    const q = limit.data?.[0] ?? {};
    log(`Token OK for @${me.username} (${me.user_id}); posts used in the last 24 h: ${q.quota_usage ?? '?'} of ${q.config?.quota_total ?? '?'}`);
    if (me.username && me.username.toLowerCase() !== String(brand.handle).toLowerCase()) {
      log(`::warning::The token belongs to @${me.username}, but brand.json says @${brand.handle}`);
    }
  }

  return { publish, mark, refresh, check, brand };
}
