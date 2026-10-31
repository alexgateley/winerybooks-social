// Publishes @TheWineryBooks's Reels to Instagram through the Instagram API (with Instagram Login):
// whatever posts/schedule.json lists for today, from 12:00 PM Pacific, once. An empty schedule posts
// nothing. The logic is in scripts/lib/publisher.mjs (tested by scripts/publish.test.mjs with a fake
// fetch); this file is the command the workflow runs.
//
//   node scripts/publish.mjs            # post today's Reel if it is due and not yet posted
//   node scripts/publish.mjs refresh    # refresh the long-lived token, write it to new-token.txt
//   node scripts/publish.mjs check      # verify the token, the account and the publishing quota
//   node scripts/publish.mjs mark --date 2026-11-02 [--note "posted from the app"]
//                                       # record a post put up by hand, so the job never posts it
//
// A by-hand marker counts only once it is on main (the job reads nothing else). The simplest way is
// the workflow itself, which writes the marker on main from anywhere:
//   gh workflow run "Post @TheWineryBooks" --repo alexgateley/winerybooks-social -f date=2026-11-02 -f by_hand=true
// Run locally, `mark` first checks that this clone is on main and up to date with origin/main
// (it fetches), and refuses otherwise; then commit and `git push origin main`.
// `--no-git-check` skips that check.
//
// Environment:
//   IG_ACCESS_TOKEN   long-lived token from the Meta app dashboard (Instagram API with Instagram Login)
//   IG_USER_ID        the Instagram professional account id shown next to the token
//   PAGES_BASE_URL    where posts/ is served; defaults to pagesBaseUrl in brand.json
//   POST_DATE         optional YYYY-MM-DD: post that date now if it is scheduled, skipping the time-of-day check
//   DRY_RUN           "true" to log what would be posted without calling the API
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { byHandCommand, checkMarkBranch, createPublisher } from './lib/publisher.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const mode = args[0] && !args[0].startsWith('--') ? args[0] : 'post';
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

const fail = (msg) => { console.error(`ERROR: ${msg}`); process.exit(1); };

async function main() {
  const publisher = createPublisher({ root });
  if (mode === 'refresh') return void (await publisher.refresh());
  if (mode === 'check') return void (await publisher.check());
  if (mode === 'mark') {
    const date = opt('--date');
    if (process.env.GITHUB_ACTIONS !== 'true' && !args.includes('--no-git-check')) {
      const git = (gitArgs) => {
        const r = spawnSync('git', ['-C', root, ...gitArgs], { encoding: 'utf8' });
        return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr || (r.error ? String(r.error.message) : '') };
      };
      const branch = checkMarkBranch(git);
      if (!branch.ok) {
        fail(`not writing the marker: ${branch.reason}.\n${branch.fix ? `  Fix it with: ${branch.fix}\n  then run this mark command again.\n` : ''}`
          + `  Or record it on GitHub, which writes it on main from anywhere:\n    ${byHandCommand(publisher.brand, date || 'YYYY-MM-DD')}`);
      }
    }
    return void publisher.mark({ date, note: opt('--note') });
  }
  if (mode !== 'post') fail(`Unknown mode "${mode}" (post, refresh, check or mark)`);
  const result = await publisher.publish();
  if (result.errors.length) process.exit(1);
}

main().catch((e) => fail(e.message));
