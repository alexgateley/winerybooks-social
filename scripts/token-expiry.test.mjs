//   node --test scripts/token-expiry.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextExpiry } from './token-expiry.mjs';

const now = Date.parse('2026-11-08T14:00:00Z');
const sixty = 60 * 86400;

test('one account: only the two dates', () => {
  assert.deepEqual(nextExpiry(null, sixty, undefined, now), { expiresAt: '2027-01-07', refreshedAt: '2026-11-08' });
});

test('several accounts: each keeps its date and the top level is the first to expire', () => {
  const first = nextExpiry(null, sixty, 'icu', now);
  const second = nextExpiry(first, sixty, 'rn', now + 7 * 86400000);
  assert.deepEqual(second.brands.icu, { expiresAt: '2027-01-07', refreshedAt: '2026-11-08' });
  assert.deepEqual(second.brands.rn, { expiresAt: '2027-01-14', refreshedAt: '2026-11-15' });
  assert.equal(second.expiresAt, '2027-01-07');
  assert.equal(second.refreshedAt, '2026-11-08');
});
