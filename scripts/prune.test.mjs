// scripts/prune.mjs against a temporary repository: only media of posts that went out more than N
// days ago is removed; posts not yet out never are.
//
//   npm test
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prune } from './prune.mjs';

const realRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const realBrand = JSON.parse(fs.readFileSync(path.join(realRoot, 'brand.json'), 'utf8'));
const NOW = new Date('2026-12-15T20:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const roots = [];
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'social-prune-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'brand.json'), JSON.stringify(realBrand));
  const post = (folder) => {
    const dir = path.join(root, 'posts', folder);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of ['reel.mp4', 'cover.jpg', 'caption.txt', 'meta.json']) fs.writeFileSync(path.join(dir, f), f);
  };
  const mark = (file, data) => fs.writeFileSync(path.join(root, 'published', file), JSON.stringify(data));
  fs.mkdirSync(path.join(root, 'published'), { recursive: true });
  // Posted 40 days ago
  post('old-post'); mark('2026-11-05.json', { date: '2026-11-05', folder: 'old-post', postedAt: daysAgo(40) });
  // Posted 10 days ago
  post('recent-post'); mark('2026-12-04.json', { date: '2026-12-04', folder: 'recent-post', postedAt: daysAgo(10) });
  // An old marker without a folder field: found through the schedule
  post('no-folder-field'); mark('2026-11-02.json', { date: '2026-11-02', postedAt: daysAgo(44) });
  // Never posted (an old date with no marker)
  post('never-posted');
  // An old marker whose folder the schedule still lists for a date with no marker: protected
  post('shared'); mark('2026-11-04.json', { date: '2026-11-04', folder: 'shared', postedAt: daysAgo(42) });
  // A marker that tries to point outside posts/
  fs.mkdirSync(path.join(root, 'outside'), { recursive: true });
  fs.writeFileSync(path.join(root, 'outside', 'reel.mp4'), 'x');
  mark('2026-11-06.json', { date: '2026-11-06', folder: '../outside', postedAt: daysAgo(41) });
  fs.writeFileSync(path.join(root, 'posts', 'schedule.json'), JSON.stringify({
    '2026-11-02': 'no-folder-field', '2026-11-04': 'shared', '2026-11-05': 'old-post', '2026-11-09': 'never-posted', '2026-12-04': 'recent-post', '2026-12-18': 'shared',
  }));
  return root;
}

const exists = (root, p) => fs.existsSync(path.join(root, p));

test('removes reel.mp4 and cover.jpg of posts posted more than 30 days ago, keeping caption and meta', () => {
  const root = makeRepo();
  const r = prune({ root, now: NOW, log: () => {} });
  assert.deepEqual(r.removed.sort(), [
    'posts/no-folder-field/cover.jpg', 'posts/no-folder-field/reel.mp4',
    'posts/old-post/cover.jpg', 'posts/old-post/reel.mp4',
  ]);
  for (const f of r.removed) assert.ok(!exists(root, f));
  assert.ok(exists(root, 'posts/old-post/caption.txt'));
  assert.ok(exists(root, 'posts/old-post/meta.json'));
});

test('never touches recent posts, unposted posts, or anything outside posts/', () => {
  const root = makeRepo();
  const r = prune({ root, now: NOW, log: () => {} });
  assert.ok(exists(root, 'posts/recent-post/reel.mp4'));
  assert.ok(exists(root, 'posts/never-posted/reel.mp4'));
  assert.ok(exists(root, 'posts/shared/reel.mp4'));
  assert.deepEqual(r.protected, ['shared']);
  assert.ok(exists(root, 'outside/reel.mp4'));
});

test('--dry-run lists the same files and deletes nothing; --days changes the window', () => {
  const root = makeRepo();
  const dry = prune({ root, now: NOW, dryRun: true, log: () => {} });
  assert.equal(dry.removed.length, 4);
  for (const f of dry.removed) assert.ok(exists(root, f));
  assert.equal(prune({ root, now: NOW, days: 60, dryRun: true, log: () => {} }).removed.length, 0);
  assert.equal(prune({ root, now: NOW, days: 5, dryRun: true, log: () => {} }).removed.length, 6);
  assert.throws(() => prune({ root, now: NOW, days: 0, log: () => {} }), /--days/);
});
