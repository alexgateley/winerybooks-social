#!/usr/bin/env node
// Keeps the GitHub Pages site small: removes reel.mp4 and cover.jpg of every post that went out more
// than N days ago (brand.json prune.afterDays, 30). Instagram has the media once a post is up;
// caption.txt and meta.json stay, and git history keeps every file.
//
//   npm run prune                       # 30 days (the workflow runs this after each post)
//   npm run prune -- --days 45 --dry-run
//
// Safe by construction: only a post with a marker in published/ older than N days is a candidate, and
// a folder the schedule still lists for a date without a marker is never touched.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FOLDER_RE } from './lib/publisher.mjs';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKER_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;
const DAY_MS = 86_400_000;
const readJson = (file, fallback) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback);

/** prune({ root, days, now, dryRun, log }) → { removed: [relative paths], kept, protected } */
export function prune({ root = DEFAULT_ROOT, days, now = new Date(), dryRun = false, log = console.log } = {}) {
  const brand = readJson(path.join(root, 'brand.json'), null);
  if (!brand) throw new Error(`No brand.json in ${root}`);
  const afterDays = days ?? brand.prune?.afterDays ?? 30;
  if (!Number.isFinite(afterDays) || afterDays < 1) throw new Error(`--days must be 1 or more, not ${days}`);
  const files = brand.prune?.files || ['reel.mp4', 'cover.jpg'];
  const postsDir = path.join(root, brand.postsDir || 'posts');
  const publishedDir = path.join(root, brand.publishedDir || 'published');
  const cutoff = now.getTime() - afterDays * DAY_MS;

  // Folders the schedule lists for a date with no marker yet: never pruned
  const schedule = readJson(path.join(root, brand.post.schedule), {});
  const unposted = new Set();
  for (const [date, folder] of Object.entries(schedule)) {
    if (!fs.existsSync(path.join(publishedDir, `${date}.json`))) unposted.add(folder);
  }

  const result = { removed: [], kept: 0, protected: [] };
  const markers = fs.existsSync(publishedDir) ? fs.readdirSync(publishedDir).filter((f) => MARKER_RE.test(f)).sort() : [];
  for (const file of markers) {
    const [, date] = file.match(MARKER_RE);
    let marker;
    try { marker = JSON.parse(fs.readFileSync(path.join(publishedDir, file), 'utf8')); } catch { log(`Skipping ${file}: not JSON`); continue; }
    const posted = Date.parse(marker.postedAt) || Date.parse(`${date}T12:00:00Z`);
    if (!(posted < cutoff)) { result.kept++; continue; }
    const folder = marker.folder || schedule[date];
    if (!folder || !FOLDER_RE.test(folder)) continue;
    const dir = path.join(postsDir, folder);
    if (path.dirname(dir) !== postsDir) continue;
    if (unposted.has(folder)) { result.protected.push(folder); continue; }
    for (const f of files) {
      const target = path.join(dir, f);
      if (!fs.existsSync(target)) continue;
      if (!dryRun) fs.rmSync(target);
      result.removed.push(path.relative(root, target));
    }
  }
  log(`${dryRun ? 'Would remove' : 'Removed'} ${result.removed.length} media files of posts posted more than ${afterDays} days ago${result.removed.length ? `:\n  ${result.removed.join('\n  ')}` : '.'}`);
  if (result.protected.length) log(`Kept (the schedule still lists them for a date not yet posted): ${result.protected.join(', ')}`);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const days = args.includes('--days') ? Number(args[args.indexOf('--days') + 1]) : undefined;
  try {
    prune({ days, dryRun: args.includes('--dry-run') });
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
  }
}
