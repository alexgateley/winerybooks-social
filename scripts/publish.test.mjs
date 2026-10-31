// The publisher against a temporary repository folder, a fake fetch and a fixed clock: an empty
// schedule posts nothing, a listed date posts once from noon Pacific (daylight saving included),
// dry runs call nothing, plus the by-hand marker and the hashtag limit. Nothing here reaches the
// network. The last test checks the committed schedule.
//
//   npm test
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { byHandCommand, checkMarkBranch, createPublisher, FOLDER_RE, limitHashtags, localParts } from './lib/publisher.mjs';

const realRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const realBrand = JSON.parse(fs.readFileSync(path.join(realRoot, 'brand.json'), 'utf8'));
const BASE = 'https://pages.example.test/social';
const CAPTION = (title) => `${title}: test caption first line.\nLine two.\n\n#one #two #three #four #five`;

const roots = [];
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

/** A temporary repo with the real brand.json and one post folder per { date, folder }. */
function makeRepo({ posts = [], markers = [], schedule } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'social-publish-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'brand.json'), JSON.stringify(realBrand, null, 2));
  fs.mkdirSync(path.join(root, 'posts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'published'), { recursive: true });
  const dates = {};
  for (const p of posts) {
    const folder = p.folder || `post-${p.date}`;
    const dir = path.join(root, 'posts', folder);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'reel.mp4'), 'not really a video');
    fs.writeFileSync(path.join(dir, 'caption.txt'), (p.caption ?? CAPTION(p.date)) + '\n');
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ ...(p.metaDate ? { date: p.metaDate } : {}), thumbOffsetMs: 14100 }));
    dates[p.date] = folder;
  }
  if (schedule !== null) fs.writeFileSync(path.join(root, 'posts', 'schedule.json'), JSON.stringify(schedule ?? dates, null, 2));
  for (const date of markers) fs.writeFileSync(path.join(root, 'published', `${date}.json`), JSON.stringify({ date, mediaId: 'earlier' }));
  return root;
}

/** A fake Instagram + Pages: records every call; `failHead` makes HEAD fail for URLs containing it. */
function fakeFetch({ failHead } = {}) {
  const calls = [];
  let n = 0;
  const reply = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    const u = new URL(url);
    const params = Object.fromEntries(method === 'GET' ? u.searchParams : new URLSearchParams(init.body || ''));
    const hasToken = params.access_token === 'test-token';
    delete params.access_token;
    calls.push({ method, url: method === 'GET' ? `${u.origin}${u.pathname}` : url, params, hasToken });
    if (method === 'HEAD') return failHead && failHead() ? reply({}, false, 404) : reply({});
    if (method === 'GET' && params.fields === 'status_code') return reply({ status_code: 'FINISHED' });
    if (u.pathname.endsWith('/media_publish')) return reply({ id: `media-${++n}` });
    if (u.pathname.endsWith('/media')) return reply({ id: `container-${++n}` });
    return reply({ error: { message: `unexpected ${method} ${u.pathname}` } }, false, 400);
  };
  return { fetch, calls };
}

const failingFetch = () => { throw new Error('fetch must not be called'); };

function run(root, { at, env = {}, fetch } = {}) {
  const logs = [];
  const fake = fetch ? { fetch, calls: null } : fakeFetch();
  const publisher = createPublisher({
    root,
    fetch: fake.fetch,
    now: () => new Date(at),
    env: { IG_ACCESS_TOKEN: 'test-token', IG_USER_ID: '1789', PAGES_BASE_URL: BASE, ...env },
    log: (m) => logs.push(String(m)),
    warn: (m) => logs.push(String(m)),
    sleep: async () => {},
  });
  return publisher.publish().then((result) => ({ result, calls: fake.calls, logs: logs.join('\n') }));
}

const published = (root) => fs.readdirSync(path.join(root, 'published'));
const readMarker = (root, date) => JSON.parse(fs.readFileSync(path.join(root, 'published', `${date}.json`), 'utf8'));
const reelCalls = (calls) => calls.filter((c) => c.params.media_type === 'REELS');

// 2026-10-26 is a Monday in PDT (noon is 19:00 UTC); 2026-11-02 is a Monday in PST (noon is 20:00 UTC)
const PDT_DAY = '2026-10-26';
const PST_DAY = '2026-11-02';

test('Pacific wall clock: summer, winter and both daylight-saving change days', () => {
  assert.equal(localParts(new Date(`${PDT_DAY}T19:07:00Z`), 'America/Los_Angeles').hour, 12);
  assert.equal(localParts(new Date(`${PST_DAY}T19:07:00Z`), 'America/Los_Angeles').hour, 11);
  assert.equal(localParts(new Date(`${PST_DAY}T20:07:00Z`), 'America/Los_Angeles').hour, 12);
  assert.equal(localParts(new Date('2027-03-15T19:07:00Z'), 'America/Los_Angeles').hour, 12); // PDT from Mar 14
  assert.equal(localParts(new Date('2027-03-12T19:07:00Z'), 'America/Los_Angeles').hour, 11);
  assert.equal(localParts(new Date(`${PDT_DAY}T19:07:00Z`), 'America/Los_Angeles').weekday, 'Mon');
});

test('an empty schedule posts nothing: at noon, with POST_DATE, and in a dry run', async () => {
  const root = makeRepo({ posts: [{ date: 'unused', folder: 'ready-reel' }], schedule: {} });
  for (const env of [{}, { POST_DATE: PDT_DAY }, { DRY_RUN: 'true' }]) {
    const r = await run(root, { at: `${PDT_DAY}T19:07:00Z`, env, fetch: failingFetch });
    assert.deepEqual(r.result.errors, []);
    assert.deepEqual(r.result.posted, []);
    assert.deepEqual(r.result.dryRun, []);
    assert.deepEqual(r.result.skipped.map((s) => s.reason), ['not-scheduled']);
  }
  assert.deepEqual(published(root), []);
});

test('a missing schedule file posts nothing, and a broken one fails without posting', async () => {
  const none = makeRepo({ schedule: null });
  const a = await run(none, { at: `${PDT_DAY}T19:07:00Z`, fetch: failingFetch });
  assert.deepEqual(a.result.errors, []);
  assert.deepEqual(a.result.skipped.map((s) => s.reason), ['not-scheduled']);
  const broken = makeRepo({ schedule: null });
  fs.writeFileSync(path.join(broken, 'posts', 'schedule.json'), '{ not json');
  const b = await run(broken, { at: `${PDT_DAY}T19:07:00Z`, fetch: failingFetch });
  assert.equal(b.result.errors.length, 1);
  assert.deepEqual(published(broken), []);
});

test('only a listed date posts: another day with a schedule full of other dates posts nothing', async () => {
  const root = makeRepo({ posts: [{ date: '2026-10-28' }] });
  const r = await run(root, { at: `${PDT_DAY}T19:07:00Z`, fetch: failingFetch });
  assert.deepEqual(r.result.skipped.map((s) => s.reason), ['not-scheduled']);
  assert.deepEqual(published(root), []);
});

test('a listed date posts once from noon; later runs that day and the next day call nothing', async () => {
  const root = makeRepo({ posts: [{ date: PDT_DAY, folder: 'first-reel' }] });
  const first = await run(root, { at: `${PDT_DAY}T19:07:00Z` }); // 12:07 PM PDT
  assert.deepEqual(first.result.errors, []);
  assert.deepEqual(first.result.posted.map((p) => p.folder), ['first-reel']);
  const reels = reelCalls(first.calls);
  assert.equal(reels.length, 1);
  assert.equal(reels[0].params.video_url, `${BASE}/posts/first-reel/reel.mp4`);
  assert.equal(reels[0].params.share_to_feed, 'true');
  assert.equal(reels[0].params.thumb_offset, '14100');
  assert.equal(reels[0].params.caption, CAPTION(PDT_DAY));
  assert.ok(first.calls.every((c) => c.method === 'HEAD' || c.hasToken));
  assert.equal(first.calls[0].method, 'HEAD'); // the media URL is checked before Instagram is asked
  assert.equal(first.calls.filter((c) => c.url.endsWith('/media_publish')).length, 1);
  const m = readMarker(root, PDT_DAY);
  assert.equal(m.folder, 'first-reel');
  assert.equal(m.mediaId, first.result.posted[0].mediaId);

  for (const at of [`${PDT_DAY}T20:07:00Z`, `${PDT_DAY}T21:07:00Z`, '2026-10-27T06:50:00Z', '2026-10-27T19:07:00Z']) {
    const later = await run(root, { at, fetch: failingFetch });
    assert.deepEqual(later.result.posted, [], `a run at ${at} must post nothing`);
  }
  const forcedAgain = await run(root, { at: '2026-10-27T19:07:00Z', env: { POST_DATE: PDT_DAY }, fetch: failingFetch });
  assert.deepEqual(forcedAgain.result.skipped.map((s) => s.reason), ['posted']);
});

test('a date with a marker from an earlier run never posts', async () => {
  const root = makeRepo({ posts: [{ date: PDT_DAY }], markers: [PDT_DAY] });
  const r = await run(root, { at: `${PDT_DAY}T19:07:00Z`, fetch: failingFetch });
  assert.deepEqual(r.result.skipped.map((s) => s.reason), ['posted']);
  assert.equal(readMarker(root, PDT_DAY).mediaId, 'earlier');
});

test('before noon Pacific nothing is called, in summer and in winter', async () => {
  const summer = makeRepo({ posts: [{ date: PDT_DAY }] });
  const a = await run(summer, { at: `${PDT_DAY}T18:59:00Z`, fetch: failingFetch }); // 11:59 AM PDT
  assert.deepEqual(a.result.skipped.map((s) => s.reason), ['before-hour']);
  const winter = makeRepo({ posts: [{ date: PST_DAY }] });
  const b = await run(winter, { at: `${PST_DAY}T19:07:00Z`, fetch: failingFetch }); // 11:07 AM PST, the PDT cron
  assert.deepEqual(b.result.skipped.map((s) => s.reason), ['before-hour']);
  assert.deepEqual(published(winter), []);
  const c = await run(winter, { at: `${PST_DAY}T20:07:00Z` }); // 12:07 PM PST
  assert.equal(c.result.posted.length, 1);
});

test('POST_DATE posts a listed date now, whatever the hour, and only once', async () => {
  const root = makeRepo({ posts: [{ date: PDT_DAY, folder: 'forced-reel' }] });
  const env = { POST_DATE: PDT_DAY };
  const r = await run(root, { at: '2026-10-28T12:00:00Z', env }); // 5 AM two days later
  assert.deepEqual(r.result.posted.map((p) => [p.date, p.folder]), [[PDT_DAY, 'forced-reel']]);
  const again = await run(root, { at: '2026-10-28T12:00:00Z', env, fetch: failingFetch });
  assert.deepEqual(again.result.posted, []);
  await assert.rejects(run(root, { at: '2026-10-28T12:00:00Z', env: { POST_DATE: '10/26/2026' } }), /POST_DATE/);
});

test('dry run: calls nothing, writes nothing, shows the caption, and needs no credentials', async () => {
  const root = makeRepo({ posts: [{ date: PDT_DAY }] });
  const r = await run(root, { at: `${PDT_DAY}T10:00:00Z`, env: { DRY_RUN: 'true', IG_ACCESS_TOKEN: '', IG_USER_ID: '' }, fetch: failingFetch }); // 3 AM: dry runs skip the hour
  assert.deepEqual(r.result.errors, []);
  assert.equal(r.result.dryRun.length, 1);
  assert.match(r.logs, /test caption first line/);
  assert.deepEqual(published(root), []);
});

test('without credentials a real run calls nothing and reports the error', async () => {
  const root = makeRepo({ posts: [{ date: PDT_DAY }] });
  const r = await run(root, { at: `${PDT_DAY}T19:07:00Z`, env: { IG_ACCESS_TOKEN: '' }, fetch: failingFetch });
  assert.equal(r.result.errors.length, 1);
  assert.match(r.result.errors[0].message, /IG_ACCESS_TOKEN/);
});

test('a failed post leaves no marker, so the next run retries it and posts it once', async () => {
  const root = makeRepo({ posts: [{ date: PDT_DAY }] });
  let down = true;
  const fake = fakeFetch({ failHead: () => down });
  const r = await run(root, { at: `${PDT_DAY}T19:07:00Z`, fetch: fake.fetch });
  assert.equal(r.result.errors.length, 1);
  assert.match(r.result.errors[0].message, /Has GitHub Pages finished deploying/);
  assert.deepEqual(published(root), []);
  down = false;
  const retry = await run(root, { at: `${PDT_DAY}T20:07:00Z`, fetch: fake.fetch });
  assert.equal(retry.result.posted.length, 1);
  assert.equal(fake.calls.filter((c) => c.url.endsWith('/media_publish')).length, 1);
});

test('a folder that disagrees with the date, an unsafe folder name, or a missing file posts nothing', async () => {
  const wrong = makeRepo({ posts: [{ date: PDT_DAY, metaDate: '2026-10-28' }] });
  assert.match((await run(wrong, { at: `${PDT_DAY}T19:07:00Z`, fetch: failingFetch })).result.errors[0].message, /disagree/);
  const unsafe = makeRepo({ schedule: { [PDT_DAY]: '../secret' } });
  assert.match((await run(unsafe, { at: `${PDT_DAY}T19:07:00Z`, fetch: failingFetch })).result.errors[0].message, /not a post folder name/);
  const missing = makeRepo({ schedule: { [PDT_DAY]: 'no-such-reel' } });
  assert.match((await run(missing, { at: `${PDT_DAY}T19:07:00Z`, fetch: failingFetch })).result.errors[0].message, /reel\.mp4 is missing/);
});

test('a caption with more than five hashtags goes out with five', async () => {
  const caption = 'A test.\n\nFooter.\n\n#a #b #c #d #e #f #g';
  assert.equal(limitHashtags(caption, 5).caption, 'A test.\n\nFooter.\n\n#a #b #c #d #e');
  assert.equal(limitHashtags(CAPTION('x'), 5).caption, CAPTION('x'));
  const root = makeRepo({ posts: [{ date: PDT_DAY, caption }] });
  const r = await run(root, { at: `${PDT_DAY}T19:07:00Z` });
  assert.equal(reelCalls(r.calls)[0].params.caption, 'A test.\n\nFooter.\n\n#a #b #c #d #e');
  assert.match(r.logs, /more than 5 hashtags/);
});

test('mark: a by-hand marker stops the job and is never overwritten', async () => {
  const root = makeRepo({ posts: [{ date: PDT_DAY, folder: 'by-hand-reel' }] });
  const logs = [];
  const pub = createPublisher({ root, fetch: failingFetch, now: () => new Date(`${PDT_DAY}T17:00:00Z`), env: {}, log: (m) => logs.push(m) });
  assert.equal(pub.mark({ date: PDT_DAY, note: 'posted from the phone' }).written, true);
  const m = readMarker(root, PDT_DAY);
  assert.equal(m.mediaId, 'by-hand');
  assert.equal(m.note, 'posted from the phone');
  assert.equal(m.folder, 'by-hand-reel');
  assert.equal(pub.mark({ date: PDT_DAY }).written, false);
  assert.equal(readMarker(root, PDT_DAY).note, 'posted from the phone');
  assert.throws(() => pub.mark({}), /--date/);
  assert.match(logs.join('\n'), new RegExp(`git add published/${PDT_DAY}\\.json`));
  assert.match(logs.join('\n'), /&& git push origin main/); // never a bare push: it would go to the current branch
  const job = await run(root, { at: `${PDT_DAY}T19:07:00Z`, fetch: failingFetch });
  assert.deepEqual(job.result.posted, []);
});

test('a local mark refuses a clone that is not on main, or is behind origin/main', () => {
  const fake = ({ branch = 'main', fetchOk = true, behind = '0' } = {}) => {
    const calls = [];
    const git = (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'rev-parse') return { status: 0, stdout: `${branch}\n`, stderr: '' };
      if (args[0] === 'fetch') return fetchOk ? { status: 0, stdout: '', stderr: '' } : { status: 128, stdout: '', stderr: 'fatal: unable to access' };
      if (args[0] === 'rev-list') return { status: 0, stdout: `${behind}\n`, stderr: '' };
      return { status: 1, stdout: '', stderr: 'unexpected' };
    };
    return { git, calls };
  };
  const a = checkMarkBranch(fake({ branch: 'draft' }).git);
  assert.equal(a.ok, false);
  assert.match(a.reason, /on "draft", but the job reads main only/);
  const f = fake({ behind: '2' });
  const b = checkMarkBranch(f.git);
  assert.equal(b.ok, false);
  assert.match(b.reason, /2 commits behind origin\/main/);
  assert.equal(b.fix, 'git pull --rebase origin main');
  assert.deepEqual(f.calls, ['rev-parse --abbrev-ref HEAD', 'fetch --quiet origin main', 'rev-list --count HEAD..origin/main']);
  assert.equal(checkMarkBranch(fake({ fetchOk: false }).git).ok, false);
  assert.deepEqual(checkMarkBranch(fake().git), { ok: true });
  assert.equal(byHandCommand(realBrand, PDT_DAY), `gh workflow run "Post @${realBrand.handle}" --repo ${realBrand.repo} -f date=${PDT_DAY} -f by_hand=true`);
});

test('the committed schedule: Monday, Wednesday or Friday dates, each with a post ready or already out', () => {
  const schedule = JSON.parse(fs.readFileSync(path.join(realRoot, realBrand.post.schedule), 'utf8'));
  assert.equal(Array.isArray(schedule), false);
  for (const [date, folder] of Object.entries(schedule)) {
    const day = new Date(`${date}T12:00:00Z`);
    assert.equal(day.toISOString().slice(0, 10), date, `${date} is not a real date`);
    assert.ok(realBrand.post.days.includes(localParts(day, 'UTC').weekday), `${date} is not one of ${realBrand.post.days.join(', ')}`);
    assert.match(folder, FOLDER_RE, `${date}: bad folder name`);
    const dir = path.join(realRoot, 'posts', folder);
    assert.ok(fs.existsSync(path.join(dir, 'caption.txt')), `${date}: posts/${folder}/caption.txt is missing`);
    const posted = fs.existsSync(path.join(realRoot, 'published', `${date}.json`));
    assert.ok(posted || fs.existsSync(path.join(dir, 'reel.mp4')), `${date}: posts/${folder}/reel.mp4 is missing`);
  }
});
