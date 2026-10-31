#!/bin/sh
# Kicks the "Post @TheWineryBooks" GitHub workflow from this Mac, by hand. GitHub's own cron schedule
# fires late or not at all on a quiet repository, so a launchd agent can kick the workflow at 12:05
# and 2:05 PM Pacific on Monday, Wednesday and Friday (launchd/com.winerybooks.post.plist). The agent
# carries the same command written out in its plist, not a call to this file (scripts/workflow.test.mjs
# keeps the two in step).
#
# The workflow decides whether to post: only a date listed in posts/schedule.json, only from noon
# Pacific, and only once (a marker per date in published/). Extra kicks are harmless. Needs the GitHub
# CLI logged in as the repository owner (gh auth status). KICK_DRY_RUN=true prints the command
# instead of running it.
set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
REPO="alexgateley/winerybooks-social"
WORKFLOW="Post @TheWineryBooks"
LOG="$HOME/Library/Logs/winerybooks-social.log"
mkdir -p "$(dirname "$LOG")"
stamp() { date '+%Y-%m-%d %H:%M:%S %Z'; }

if [ "${KICK_DRY_RUN:-}" = "true" ]; then
  echo "would run: gh workflow run \"$WORKFLOW\" --repo $REPO -f dry_run=false"
  exit 0
fi

# Wait briefly for the network after wake-up
n=0
until curl -s -o /dev/null --max-time 5 https://api.github.com/ || [ $n -ge 12 ]; do n=$((n+1)); sleep 10; done

if out=$(gh workflow run "$WORKFLOW" --repo "$REPO" -f dry_run=false 2>&1); then
  echo "$(stamp) kicked (by hand): $out" >> "$LOG"
else
  echo "$(stamp) FAILED to kick: $out" >> "$LOG"
  exit 1
fi
