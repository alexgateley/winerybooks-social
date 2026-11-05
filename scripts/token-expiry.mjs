// Writes token-expiry.json at the repository root: the date Instagram says the stored posting token
// expires, from the expires_in it returned to `publish.mjs refresh`. No token goes in this file, and it is
// public (GitHub Pages serves the repository), so it holds dates only.
//
//   node scripts/token-expiry.mjs <expires_in seconds> [brand]
//
// Shape: { "expiresAt": "YYYY-MM-DD", "refreshedAt": "YYYY-MM-DD" }. A repository with several accounts
// passes a brand and also gets "brands": { <brand>: { expiresAt, refreshedAt } }; the top level is then
// the account whose token expires first.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const day = (ms) => new Date(ms).toISOString().slice(0, 10);

export function nextExpiry(previous, seconds, brand, now = Date.now()) {
  const entry = { expiresAt: day(now + seconds * 1000), refreshedAt: day(now) };
  if (!brand) return entry;
  const brands = { ...previous?.brands, [brand]: entry };
  const first = Object.values(brands).reduce((a, b) => (b.expiresAt < a.expiresAt ? b : a));
  return { ...first, brands };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const seconds = Number(process.argv[2]);
  if (!Number.isFinite(seconds) || seconds <= 0) { console.error('expires_in must be a positive number of seconds'); process.exit(1); }
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync('token-expiry.json', 'utf8')); } catch { /* first time */ }
  fs.writeFileSync('token-expiry.json', `${JSON.stringify(nextExpiry(previous, seconds, process.argv[3]), null, 2)}\n`);
}
