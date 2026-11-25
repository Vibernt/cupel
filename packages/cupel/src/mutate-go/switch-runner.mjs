// Trust and verify a rendered switched overlay. GoSession supplies the existing
// baseline, compile, selection, timeout and classification behavior.

import { cmp } from '../engine/order.mjs';
import { refuse } from './errors.mjs';
import { selectGoTests } from './selection.mjs';

export async function prepareGoSwitches(session, rendered, candidates) {
  session.switchedOverlay = rendered.overlay;
  const plans = new Map();
  const neededByPackage = new Map();
  for (const site of candidates) {
    const numbered = rendered.switched.get(site.id);
    if (!numbered) continue;
    const selection = selectGoTests(session.input, session.inventory, site);
    if (!selection.packages.size) continue;
    const owner = session.inventory.sourcePkg.get(site.source);
    if (!owner) continue;
    const packages = new Set([owner, ...selection.packages.keys()]);
    plans.set(site.id, { site: numbered, selection });
    for (const pkg of packages) {
      if (!neededByPackage.has(pkg)) neededByPackage.set(pkg, new Set());
      neededByPackage.get(pkg).add(site.id);
    }
  }

  const unsafe = new Set();
  const compileFailures = [];
  for (const pkg of [...neededByPackage.keys()].sort(cmp)) {
    if (session.remaining() < 1) {
      for (const id of neededByPackage.get(pkg)) unsafe.add(id);
      continue;
    }
    const result = await session.compileSwitchedPackage(rendered.overlay, pkg);
    if (result.status !== 0 || result.signal || result.timedOut) {
      const detail = result.timedOut ? 'timed out' : result.signal ? `signal ${result.signal}`
        : result.stderr.trim().split('\n').slice(-2).join(' | ') || `exit ${result.status}`;
      compileFailures.push({ pkg, detail });
      for (const id of neededByPackage.get(pkg)) unsafe.add(id);
    }
  }

  const groups = new Map();
  for (const [id, plan] of plans) {
    if (unsafe.has(id)) continue;
    for (const [pkg, group] of plan.selection.packages) {
      if (!groups.has(pkg)) groups.set(pkg, { pkg, tests: new Map(), names: new Set() });
      const union = groups.get(pkg);
      for (const test of group.tests) { union.tests.set(test.id, test); union.names.add(test.name); }
    }
  }
  const sensitive = new Set();
  const switchOffFailures = [];
  for (const pkg of [...groups.keys()].sort(cmp)) {
    const union = groups.get(pkg);
    if (session.remaining() < 1) { sensitive.add(pkg); continue; }
    const group = { pkg, tests: [...union.tests.values()].sort((a, b) => cmp(a.id, b.id)), names: union.names };
    const outcome = await session.checkPackage(rendered.overlay, group, session.env);
    if (!outcome || outcome.status !== 'survived') {
      sensitive.add(pkg);
      switchOffFailures.push({ pkg, status: outcome?.status ?? 'incomplete' });
    }
  }
  for (const [id, plan] of plans) {
    if (unsafe.has(id) || [...plan.selection.packages.keys()].some((pkg) => sensitive.has(pkg))) continue;
    session.switches.set(id, plan.site);
  }
  return {
    rendered: rendered.switched.size,
    refused: rendered.refused.size,
    compileFallback: unsafe.size,
    sensitive: sensitive.size,
    switched: session.switches.size,
    compileFailures,
    switchOffFailures,
  };
}

/** Verify status and every credited catcher against one standalone mutant. */
export async function verifyGoSwitch(session, site, bytes, expected) {
  const actual = await session.withIndividual(site, bytes, async ({ overlay, selection }) => {
    const result = await session.evaluate(site, overlay, selection);
    if (!result || result.status !== expected.status)
      refuse('switched-verification', `CUPEL_GO_VERIFY_SWITCHED: ${site.id} differs (${expected.status} vs ${result?.status ?? 'incomplete'})`);
    const testById = new Map(session.input.tests.map((test) => [test.id, test]));
    for (const id of expected.killedBy ?? []) {
      const test = testById.get(id);
      const pkg = test ? session.inventory.testPkg.get(test.file) : null;
      if (!test || !pkg) refuse('switched-verification', `CUPEL_GO_VERIFY_SWITCHED: credited test is absent: ${id}`);
      const alone = await session.checkPackage(overlay, { pkg, tests: [test], names: new Set([test.name]) });
      if (!alone || alone.status !== 'killed' || !alone.killedBy.includes(id))
        refuse('switched-verification', `CUPEL_GO_VERIFY_SWITCHED: credited test does not fail alone: ${id} for ${site.id}`);
    }
    return result;
  });
  if (!actual || actual.invalid)
    refuse('switched-verification', `CUPEL_GO_VERIFY_SWITCHED: ${site.id} did not compile or complete individually`);
  session.verified++;
}
