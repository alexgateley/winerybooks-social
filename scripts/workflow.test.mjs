// The schedule as written down: the workflow's crons cover noon Pacific on Monday, Wednesday and
// Friday in both PDT and PST, every run checks out main as it is when it starts, the refresh skips
// without GH_PAT, and the launch agent kicks the same workflow. Nothing is dispatched or loaded: the
// agent's command runs once against a fake gh and curl in a temporary HOME.
//
//   npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localParts } from './lib/publisher.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const yml = read('.github/workflows/post.yml');
const brand = JSON.parse(read('brand.json'));
const workflow = `Post @${brand.handle}`;
const short = brand.repo.split('/')[1].replace(/-social$/, '');
const plistPath = `launchd/com.${short}.post.plist`;
const crons = [...yml.matchAll(/cron: '(\d+) (\d+) \* \* ([\d,]+)'/g)].map((m) => ({ minute: Number(m[1]), hour: Number(m[2]), days: m[3] }));

test('this repository\'s own settings', () => {
  assert.equal(brand.timezone, 'America/Los_Angeles');
  assert.equal(brand.post.hour, 12);
  assert.deepEqual(brand.post.days, ['Mon', 'Wed', 'Fri']);
  assert.equal(brand.pagesBaseUrl, `https://alexgateley.github.io/${brand.repo.split('/')[1]}`);
  assert.equal(yml.split('\n')[0], `name: ${workflow}`);
  assert.match(yml, new RegExp(`group: post-${short}\\n`));
  assert.match(yml, new RegExp(`git config user\\.name "${short}-social-bot"`));
  assert.match(yml, /node scripts\/prune\.mjs/);
  assert.match(yml, /POST_DATE: \$\{\{ inputs\.date \}\}/);
});

test('every run checks out main as it is when the run starts, so a queued run sees the marker a run before it pushed', () => {
  assert.match(yml, /- uses: actions\/checkout@v4\n\s+with:\n\s+ref: \$\{\{ github\.ref \}\}/);
});

test('by_hand records a post on main and posts nothing', () => {
  assert.match(yml, /by_hand:\n\s+description: .*\n\s+type: boolean\n\s+default: false/);
  assert.match(yml, /- name: Publish what is due\n\s+if: steps\.creds\.outputs\.ready == 'true' && inputs\.by_hand != true/);
  assert.match(yml, /- name: Record a post made by hand\n\s+if: inputs\.by_hand == true/);
  assert.match(yml, /- name: Record what was posted\n\s+if: always\(\) && \(steps\.creds\.outputs\.ready == 'true' \|\| inputs\.by_hand == true\)/);
});

test('the Monday refresh runs after a failed post, works at the noon crons, and skips with a notice without GH_PAT', () => {
  assert.match(yml, /- name: Refresh the Instagram token \(Mondays\)\n\s+if: always\(\) && /);
  const step = yml.slice(yml.indexOf('- name: Refresh the Instagram token'));
  assert.ok(step.indexOf('::notice::GH_PAT is not set') < step.indexOf('node scripts/publish.mjs refresh'));
  assert.match(step, /if \[ -z "\$GH_TOKEN" \]; then\n\s+echo "::notice::.*\n\s+exit 0/);
  assert.doesNotMatch(step, /date \+%H/); // an hour limit would never match runs that start at noon
});

test('crons run only on Monday, Wednesday and Friday, and one lands in the noon hour Pacific in summer and winter', () => {
  assert.equal(crons.length, 3);
  assert.equal(yml.match(/- cron:/g).length, 3);
  for (const c of crons) assert.equal(c.days, '1,3,5');
  for (const day of ['2026-07-13', '2026-07-15', '2026-07-17', '2026-12-14', '2026-12-16', '2026-12-18']) {
    const hits = crons.filter((c) => {
      const at = new Date(`${day}T${String(c.hour).padStart(2, '0')}:${String(c.minute).padStart(2, '0')}:00Z`);
      const local = localParts(at, brand.timezone);
      return local.date === day && local.hour === brand.post.hour;
    });
    assert.equal(hits.length, 1, `${day}: expected one cron in the noon hour Pacific`);
  }
});

test('kick-post.sh kicks the same workflow', () => {
  const dry = spawnSync('sh', [path.join(root, 'scripts/kick-post.sh')], { env: { ...process.env, KICK_DRY_RUN: 'true' }, encoding: 'utf8' });
  assert.equal(dry.stdout.trim(), `would run: gh workflow run "${workflow}" --repo ${brand.repo} -f dry_run=false`);
});

/** The agent's ProgramArguments, read from the plist's XML (plain strings, entities decoded). */
function programArguments(plist) {
  const block = plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)[1];
  const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  return [...block.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => decode(m[1]));
}

test('the launch agent kicks at 12:05 and 2:05 PM on Monday, Wednesday and Friday', () => {
  const plist = read(plistPath);
  assert.match(plist, new RegExp(`<string>com\\.${short}\\.post</string>`));
  const got = [...plist.matchAll(/<key>Weekday<\/key>\s*<integer>(\d)<\/integer>\s*<key>Hour<\/key>\s*<integer>(\d+)<\/integer>\s*<key>Minute<\/key>\s*<integer>5<\/integer>/g)].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(got, ['1 12', '1 14', '3 12', '3 14', '5 12', '5 14']);
  const argv = programArguments(plist);
  assert.deepEqual(argv.slice(0, 2), ['/bin/sh', '-c']);
  assert.ok(argv[2].includes(`gh workflow run "${workflow}" --repo ${brand.repo} -f dry_run=false`));
  if (process.platform === 'darwin' && fs.existsSync('/usr/bin/plutil')) {
    const lint = spawnSync('/usr/bin/plutil', ['-lint', path.join(root, plistPath)], { encoding: 'utf8' });
    assert.equal(lint.status, 0, lint.stdout + lint.stderr);
  }
});

test('the agent\'s command runs against a fake gh: it waits for the network, kicks and logs', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'social-agent-'));
  try {
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    // Fakes: curl answers at once, gh records its arguments and prints what the real one prints
    fs.writeFileSync(path.join(bin, 'curl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${tmp}/gh-args"\necho "Created workflow_dispatch event"\n`, { mode: 0o755 });
    const argv = programArguments(read(plistPath));
    const env = { HOME: tmp, PATH: `${bin}:/usr/bin:/bin` };
    const r = spawnSync(argv[0], argv.slice(1), { env, encoding: 'utf8', cwd: tmp });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(fs.readFileSync(path.join(tmp, 'gh-args'), 'utf8').trim().split('\n'), ['workflow', 'run', workflow, '--repo', brand.repo, '-f', 'dry_run=false']);
    const logFile = path.join(tmp, 'Library', 'Logs', `${brand.repo.split('/')[1]}.log`);
    assert.match(fs.readFileSync(logFile, 'utf8'), /kicked \(agent\): Created workflow_dispatch event/);
    // A failed kick is logged as FAILED and exits non-zero
    fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\necho "could not find workflow" >&2\nexit 1\n', { mode: 0o755 });
    const bad = spawnSync(argv[0], argv.slice(1), { env, encoding: 'utf8', cwd: tmp });
    assert.equal(bad.status, 1);
    assert.match(fs.readFileSync(logFile, 'utf8'), /FAILED to kick \(agent\): could not find workflow/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
