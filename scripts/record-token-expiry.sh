#!/bin/sh
# Commits token-expiry.json after the refreshed token has been stored as a secret. Runs after the
# marker commit, with the same retry around pushes from other jobs. Never fails the job's posting: the
# workflow turns a failure here into a warning. Reads only new-token-expires-in.txt, never the token.
#
#   sh scripts/record-token-expiry.sh [brand]
set -u
BRAND="${1:-}"
LEFT=$(cat new-token-expires-in.txt 2>/dev/null)
rm -f new-token-expires-in.txt
case "$LEFT" in
  ''|*[!0-9]*) echo "::warning::Instagram gave no expires_in, so token-expiry.json was not updated"; exit 0 ;;
esac
git config user.name >/dev/null 2>&1 || git config user.name "token-expiry-bot"
git config user.email >/dev/null 2>&1 || git config user.email "token-expiry-bot@users.noreply.github.com"
for i in 1 2 3 4 5; do
  if git pull --rebase --autostash -q origin main; then
    node scripts/token-expiry.mjs "$LEFT" $BRAND || exit 1
    git add token-expiry.json
    git commit -q -m "Token date ${BRAND:+$BRAND }$(date -u +%F)" || { echo "token-expiry.json unchanged"; exit 0; }
    if git push -q; then echo "Recorded the token date"; exit 0; fi
    git reset -q --hard HEAD~1
  else
    git rebase --abort 2>/dev/null
  fi
  sleep $((i * 5))
done
exit 1
