// Untimed launch-count diagnostic, with the actual mutation session job log.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { newProfile, profileData } from './instrument.mjs';

const [modulePath, casePath, mode] = process.argv.slice(2);
assert.ok(modulePath && casePath && ['control', 'instrumented'].includes(mode));
const { root, input, options } = JSON.parse(readFileSync(casePath, 'utf8'));
assert.equal(Object.hasOwn(options, 'jobs'), false, 'diagnostic must use default jobs');
globalThis.__CUPEL_S19_PROFILE = newProfile();
const { mutateNode, confirmSurvivors } = await import(pathToFileURL(modulePath));
const metrics = {}, confirmationMetrics = {}, logs = [];
const mutation = await mutateNode({ root, input, ...options, metrics,
  log: line => logs.push(line) });
const mutationProfile = profileData(globalThis.__CUPEL_S19_PROFILE);
globalThis.__CUPEL_S19_PROFILE = newProfile();
const survivors = mutation.mutants.filter(row => row.status === 'survived').map(row => row.id);
const confirmed = await confirmSurvivors({ root, input, mutation, ids: survivors,
  collectorKind: options.collectorKind, config: options.config,
  metrics: confirmationMetrics, log: line => logs.push(line) });
const confirmationProfile = profileData(globalThis.__CUPEL_S19_PROFILE);
process.stdout.write(`${JSON.stringify({ mode, mutation, confirmed, metrics, confirmationMetrics,
  profiles: { mutation: mutationProfile, confirmation: confirmationProfile },
  counts: { tests: input.tests.length, mutants: mutation.mutants.length,
    survivorRechecks: survivors.length }, logs })}\n`);
