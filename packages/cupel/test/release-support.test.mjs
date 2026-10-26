// Support claims are user-facing contracts. Check tiers, evidence and discoverability
// without coupling editorial prose or historical spike records to exact paragraphs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8');
const support = read('docs/support.md');
const entrypoints = [
  'README.md', 'docs/README.md', 'docs/private-use.md', 'docs/cli.md',
  'docs/mcp.md', 'docs/install.md', 'docs/jest.md', 'docs/go.md',
  'docs/ruby.md', 'docs/rust.md', 'docs/selective-pr.md',
  'plans/FIRST-RELEASE-CHECKLIST.md', 'plans/RELEASE-READINESS.md',
  'plans/RUNNER-COMPLETION.md', 'plans/ROADMAP.md', 'plans/DECISIONS.md',
];
const normalized = (text) => text.replace(/\s+/g, ' ');
const rows = support.split('\n').filter((line) => line.startsWith('| **'));

for (const path of entrypoints) {
  test(`${path} links to the authoritative support matrix`, () => {
    const text = read(path);
    const links = [...text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)];
    const link = links.find(([, target]) => resolve(ROOT, dirname(path), target) === resolve(ROOT, 'docs/support.md'));
    assert.ok(link, `${path} must make the support matrix discoverable`);
    assert.ok(existsSync(resolve(ROOT, dirname(path), link[1])));
  });
}

test('core full-guard matrix names every first-release runner and exact tested versions', () => {
  const core = rows.filter((row) => /\*\*Core/.test(row));
  for (const [runner, version] of [
    [/node:test/, /22\.23\.3.*26\.7\.0/],
    [/Vitest/, /4\.1\.11.*5\.0\.1/],
    [/Jest/, /30\.2\.0/],
    [/pytest/, /3\.12\+.*3\.14\.8.*9\.1\.1/],
  ]) {
    const row = core.find((candidate) => runner.test(candidate));
    assert.ok(row, `missing core runner ${runner}`);
    assert.match(row, version);
  }
  assert.match(support, /ordinary full guard/);
  // The promoted real-repository claim must remain tied to complete tracked evidence.
  const jest = core.find((row) => /Jest/.test(row));
  assert.match(jest, /Real-repository.*passed/);
  assert.match(jest, /2026-10-26-jest-acceptance\.md/);
  const acceptance = JSON.parse(read('plans/results/2026-10-26-jest-acceptance.json'));
  assert.equal(acceptance.status, 'passed');
  assert.equal(acceptance.subject.commit, 'f33e1f2c5bfb80e300cb5ed5734503d5d17f8ef0');
  assert.equal(acceptance.originalLane.tests, 51);
  assert.equal(acceptance.originalLane.files.length, 4);
  assert.equal(acceptance.originalLane.skipped, 0);
  assert.equal(acceptance.originalLane.configUnchanged, true);
  assert.equal(acceptance.originalLane.canonicalRowsMatch, true);
  assert.equal(acceptance.originalLane.collectionRuns, 2);
  assert.equal(acceptance.mutation.executed, 11);
  assert.equal(acceptance.mutation.sampled, false);
  assert.equal(acceptance.guards.unchanged.exit, 0);
  assert.equal(acceptance.guards.weakened.exit, 1);
  assert.equal(acceptance.guards.weakened.ordinaryTestsStillPassed, 51);
  assert.equal(acceptance.guards.weakened.coverageLoss, false);
  assert.equal(acceptance.guards.weakened.criticalKillLoss, 1);
  assert.equal(acceptance.mutation.supplementalInstalledConfirmationIterations, 2);
  assert.equal(acceptance.mcp.exactCliReportParity, true);
  assert.equal(acceptance.sourcePinControl.supplemental, true);
  assert.equal(acceptance.sourcePinControl.originalTests, 51);
  assert.equal(acceptance.sourcePinControl.addedPins, 2);
  assert.equal(acceptance.sourcePinControl.pinsKillerCredit, 0);
  assert.ok(support.includes(acceptance.artifact.tarballSha256));
  assert.match(normalized(support), /51 original tests \/ 4 files/);
  assert.match(normalized(support), /51 \+ 2/);
  assert.match(jest, /Native ESM test files.*transforms remain unsupported/);
});

test('native support remains bounded preview with fixture evidence and unrun real-repository gates', () => {
  for (const [runner, version] of [
    ['Go', /1\.27\.1/], ['Ruby', /4\.0\.7.*6\.0\.0/], ['Rust', /1\.97\.1/],
  ]) {
    const row = rows.find((candidate) => candidate.includes(`Bounded preview — ${runner}`));
    assert.ok(row, `${runner} must have a bounded preview row`);
    assert.match(row, version);
    assert.match(row, /installed fixture acceptance pass/);
    assert.match(row, /Real-repository acceptance is unrun/);
    const doc = normalized(read(`docs/${runner.toLowerCase()}.md`));
    assert.match(doc, /Bounded preview/);
    assert.match(doc, /real-repository.*acceptance is unrun/i);
  }
});

test('experimental selection is retained outside supported first-release claims', () => {
  const selection = rows.find((row) => /Experimental.*selective PR/.test(row));
  assert.ok(selection);
  assert.match(selection, /26\.7\.0/);
  assert.match(selection, /Outside the supported first release/);
  assert.match(selection, /Node 22 selective execution refuses/);
  for (const path of ['README.md', 'docs/selective-pr.md', 'docs/cli.md', 'docs/mcp.md']) {
    const text = normalized(read(path));
    assert.match(text, /experimental/i, path);
    assert.match(text, /outside the supported first release/i, path);
  }
  const cli = read('docs/cli.md');
  const mcp = read('docs/mcp.md');
  for (const command of ['pr-producer', 'pr-prepare', 'pr']) assert.ok(cli.includes(`\`${command}\``));
  for (const tool of ['cupel_pr_producer', 'cupel_pr_prepare', 'cupel_pr']) assert.ok(mcp.includes(`\`${tool}\``));
  assert.match(read('docs/selective-pr.md'), /wholeGuardPass: false/);
  assert.doesNotMatch(read('README.md'), /Selective PR execution is not shipped/);
});

test('support freeze retains unpublished package guards, refusals and unverified hosted enforcement', () => {
  const text = normalized(support);
  assert.match(text, /public GitHub source publication is authorized/);
  assert.match(text, /npm and PyPI remain unpublished/);
  assert.match(text, /Hosted required-check enforcement and branch protection remain unverified/);
  assert.match(text, /No automatic fallback/);
  assert.match(text, /no generic CI speedup is claimed/);
  assert.match(text, /Registry uploads.*publishing tags\/releases.*social posting.*separate explicit owner approval/);
  assert.equal(JSON.parse(read('packages/cupel/package.json')).private, true);
  assert.match(read('packages/cupel-py/pyproject.toml'), /Private :: Do Not Upload/);
});

const currentDocs = [
  'README.md', 'CONTRIBUTING.md', 'docs/README.md', 'docs/install.md',
  'docs/private-use.md', 'docs/support.md', 'docs/development.md',
  'docs/cli.md', 'docs/mcp.md', 'docs/python.md', 'docs/vitest.md',
];

test('current documentation distinguishes the versioned MIT source from historical artifacts', () => {
  const manifest = JSON.parse(read('packages/cupel/package.json'));
  const rootManifest = JSON.parse(read('package.json'));
  const readme = read('README.md');
  const install = read('docs/install.md');
  for (const text of [readme, install, support, read('docs/private-use.md')]) {
    assert.ok(text.includes(manifest.version), 'current source version must be discoverable');
  }
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.license, 'MIT');
  assert.equal(rootManifest.license, manifest.license);
  assert.match(readme, /\[MIT\]\(LICENSE\)/);
  assert.match(read('LICENSE'), /^MIT License/);
  assert.match(read('docs/private-use.md'), /historical private 0\.0\.0 artifact/);
  assert.match(install, new RegExp(`vibernt-cupel-${manifest.version.replaceAll('.', '\\.')}\\.tgz`));
  assert.match(install, new RegExp(`vibernt_cupel-${manifest.version.replaceAll('.', '\\.')}-py3-none-any\\.whl`));
  assert.match(install, /npm pack --offline --ignore-scripts/);
  assert.match(install, /npm install --offline --ignore-scripts --no-audit --no-fund/);
  assert.doesNotMatch(readme, /^\s*(?:npm|pnpm|yarn) (?:install|add).*@vibernt\/cupel\s*$/m);
  assert.match(readme, /Node \*\*22\+/);
  assert.match(readme, /Python \*\*3\.12\+/);
});

test('owner GitHub source authorization preserves separate package and posting decisions', () => {
  const agents = normalized(read('AGENTS.md'));
  assert.match(agents, /Public GitHub source authorized.*2026-10-26/);
  assert.match(agents, /Vibernt\/cupel.*public under MIT/);
  assert.match(agents, /Registry uploads.*publishing releases\/tags.*social posting.*separate explicit owner approval/);
  assert.doesNotMatch(agents, /The repo stays PRIVATE/);
  const decisions = read('plans/DECISIONS.md');
  const authorization = normalized(decisions.split('## Owner public GitHub launch authorization')[1]);
  assert.match(authorization, /Vibernt\/cupel public on GitHub/);
  assert.match(authorization, /0\.1\.0/);
  assert.match(authorization, /npm and PyPI remain unpublished/);
  assert.match(authorization, /L1–L7 remain locked/);
  assert.match(normalized(read('CONTRIBUTING.md')), /authorized public GitHub source publication/);
});

test('documentation index exposes usage, runner, extension and verification routes', () => {
  const index = read('docs/README.md');
  for (const path of ['install.md', 'private-use.md', 'support.md', 'cli.md', 'mcp.md',
    'jest.md', 'vitest.md', 'python.md', 'go.md', 'ruby.md', 'rust.md',
    'extending/README.md', 'development.md']) {
    assert.ok(index.includes(`](${path})`), `docs index missing ${path}`);
  }
  const development = read('docs/development.md');
  for (const flag of ['CUPEL_REQUIRE_JEST', 'CUPEL_REQUIRE_PACKAGE_SMOKE',
    'CUPEL_REQUIRE_RUBY_SMOKE', 'CUPEL_REQUIRE_GO_SMOKE', 'CUPEL_REQUIRE_NATIVE_MUTATION']) {
    assert.ok(development.includes(flag), `missing explicit gate ${flag}`);
  }
  assert.match(development, /CUPEL_PR_NODE/);
  assert.match(development, /no hosted CI/);
  assert.match(development, /skip/i);
});

// Resolve actual files and heading anchors so reorganizing docs cannot leave
// apparently useful navigation that only fails when a reader follows it.
const headingAnchor = (text) => text.toLowerCase().replace(/[`*_]/g, '')
  .replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-');
for (const path of currentDocs) {
  test(`${path} has no broken local documentation links`, () => {
    for (const [, raw] of read(path).matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      if (/^[a-z][a-z\d+.-]*:/i.test(raw)) continue;
      const [target, anchor] = raw.split('#');
      const file = resolve(ROOT, dirname(path), target || path.split('/').at(-1));
      assert.ok(existsSync(file), `${path}: missing link target ${raw}`);
      if (!anchor) continue;
      const headings = [...readFileSync(file, 'utf8').matchAll(/^#{1,6}\s+(.+)$/gm)]
        .map(([, heading]) => headingAnchor(heading));
      assert.ok(headings.includes(decodeURIComponent(anchor)), `${path}: missing heading ${raw}`);
    }
  });
}
