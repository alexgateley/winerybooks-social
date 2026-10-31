# winerybooks-social

Instagram auto-posting for [@TheWineryBooks](https://www.instagram.com/TheWineryBooks/) (winerybooks.com): Reels served from
GitHub Pages and published by GitHub Actions through the Instagram API.

**Nothing posts until a date is listed in `posts/schedule.json`.** The committed schedule is empty.

## How it works

- `.github/workflows/post.yml` runs Monday, Wednesday and Friday around 12:00 PM Pacific (its crons cover
  PDT, PST and a retry). `scripts/publish.mjs` looks up today's date in `posts/schedule.json`.
- A date that is not listed posts nothing. Two more layers stop a late rerun posting twice: the
  time-of-day check (a listed date is due only from noon Pacific) and the marker
  (`published/<date>.json`, committed by the job after each post).
- A date that is missed entirely is not caught up later: only today's date is looked at.
- The Reel goes to Instagram from its public URL, `https://alexgateley.github.io/winerybooks-social/posts/<folder>/reel.mp4`.
- Media of posts more than 30 days old is pruned from the site (`scripts/prune.mjs`).

## Schedule a post

1. Add a folder `posts/<folder>/` (lower case letters, digits and hyphens) with `reel.mp4`, `caption.txt`
   and, optionally, `meta.json` (`{ "thumbOffsetMs": 3000 }` picks the cover frame) and `cover.jpg`.
2. Add the date, a Monday, Wednesday or Friday, to `posts/schedule.json`:

   ```json
   {
     "2026-11-02": "my-first-reel",
     "2026-11-04": "my-second-reel"
   }
   ```

3. Check and push to main at least a few minutes before noon, so Pages has deployed the video:

   ```sh
   npm test
   POST_DATE=2026-11-02 npm run publish:dry
   git add posts && git commit -m "Schedule 2026-11-02" && git push origin main
   ```

To unschedule, remove the date and push. To stop everything, set the schedule back to `{}`.

## Other commands

| Command | What it does |
| --- | --- |
| `npm test` | Tests; nothing reaches the network |
| `npm run publish:dry` | Logs what is due today; calls nothing |
| `npm run mark -- --date 2026-11-02` | Records a post made by hand so the job never posts it |
| `npm run prune -- --dry-run` | Lists the media that would be pruned |
| `sh scripts/kick-post.sh` | Runs the workflow now; it still posts only what is due |

## Secrets and the token

`IG_USER_ID` and `IG_ACCESS_TOKEN` are GitHub Actions secrets. Never commit them: Pages serves every
committed file publicly.

**The stored token expires about 60 days after 2026-10-31, so about 2026-12-30.** Before then, do one of:

- Add `GH_PAT`, a fine-grained personal access token with "Secrets: write" on this repo:
  `gh secret set GH_PAT --repo alexgateley/winerybooks-social`. The job then refreshes the token every Monday.
- Or regenerate the token in the Meta dashboard and run
  `gh secret set IG_ACCESS_TOKEN --repo alexgateley/winerybooks-social`.

Without `GH_PAT` the Monday refresh skips with a notice.

## Keeping the schedule alive

GitHub turns off scheduled workflows in a public repository after 60 days without a commit, and its cron
can run late. Any push turns the clock back. `launchd/com.winerybooks.post.plist` is a proposed launch agent
that kicks the workflow at 12:05 and 2:05 PM on posting days; it is not installed. The commands are in
the plist.
