// Build the deterministic Go schemata overlay. This module only renders files;
// runner.mjs owns compilation and the switches-off trust check.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { cmp } from '../engine/order.mjs';
import { goBodyVariants, goFaultHelper } from './schemata.mjs';

export const GO_FAULT_HELPER = '_cupelFaultActive';
const STATE_NAMES = [GO_FAULT_HELPER, `${GO_FAULT_HELPER}Value`];
const HELPER_FILE = '0000_cupel_fault.go';
const word = (value) => new RegExp(`(^|[^A-Za-z0-9_])${value}([^A-Za-z0-9_]|$)`);

/** Stable numbers depend on the whole scoped file set, never the run subset. */
export function numberGoSites(sites) {
  return [...sites]
    .sort((a, b) => cmp(a.source, b.source) || a.start - b.start || cmp(a.operator, b.operator) || cmp(a.id, b.id))
    .map((site, index) => ({ ...site, number: index + 1 }));
}

/** Conservative package-wide reasons that make source-position-preserving schemata unsafe. */
export function goPackageSwitchReason(pkg) {
  if (!pkg || typeof pkg.name !== 'string' || typeof pkg.dir !== 'string') return 'package';
  if (existsSync(join(pkg.dir, HELPER_FILE))) return 'helper-file';
  for (const file of pkg.files ?? []) {
    // The captured switch must initialize before project variables that may
    // clear CUPEL_FAULT. Refuse packages with an even earlier compiled name.
    if (Buffer.compare(Buffer.from(basename(file.path)), Buffer.from(HELPER_FILE)) < 0) return 'helper-order';
    const text = readFileSync(file.path, 'utf8');
    if (STATE_NAMES.some((name) => word(name).test(text))) return 'helper-name';
    if (/\.\s*(?:Caller|Callers|CallersFrames|FuncForPC)\s*\(/.test(text)) return 'position';
    if (file.production && /\.\s*Helper\s*\(/.test(text)) return 'position';
  }
  return null;
}

/**
 * Render every numbered site in every scoped file once. Refused sites remain
 * absent from `switched`, so the runner necessarily uses an individual build.
 */
export function renderGoSwitches({ root, scratch, inventory, sites, bytes }) {
  const byPackage = new Map();
  for (const site of sites) {
    const owner = inventory.sourcePkg.get(site.source);
    if (!owner) continue;
    if (!byPackage.has(owner)) byPackage.set(owner, new Map());
    const files = byPackage.get(owner);
    if (!files.has(site.source)) files.set(site.source, []);
    files.get(site.source).push(site);
  }

  const replace = {};
  const switched = new Map();
  const refused = new Map();
  let serial = 0;
  for (const owner of [...byPackage.keys()].sort(cmp)) {
    const pkg = inventory.packageByImport.get(owner);
    const reason = goPackageSwitchReason(pkg);
    const files = byPackage.get(owner);
    if (reason) {
      for (const list of files.values()) for (const site of list) refused.set(site.id, reason);
      continue;
    }
    let accepted = 0;
    for (const source of [...files.keys()].sort(cmp)) {
      const text = bytes(source).toString('utf8');
      const rendered = goBodyVariants(text, files.get(source), { helper: GO_FAULT_HELPER });
      const acceptedNumbers = new Set(rendered.switched);
      for (const site of files.get(source)) {
        if (acceptedNumbers.has(site.number)) switched.set(site.id, site);
        else refused.set(site.id, rendered.refused.find((row) => row.number === site.number)?.reason ?? 'renderer');
      }
      if (!rendered.switched.length) continue;
      const backing = join(scratch, `switched-source-${++serial}.go`);
      writeFileSync(backing, rendered.text);
      replace[join(root, source)] = backing;
      accepted += rendered.switched.length;
    }
    if (!accepted) continue;
    const helper = join(scratch, `switched-helper-${++serial}.go`);
    writeFileSync(helper, goFaultHelper(pkg.name, GO_FAULT_HELPER));
    replace[join(pkg.dir, HELPER_FILE)] = helper;
  }

  const overlay = join(scratch, 'switched-overlay.json');
  writeFileSync(overlay, JSON.stringify({ Replace: replace }));
  return { overlay, switched, refused };
}
