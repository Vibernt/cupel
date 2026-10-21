#!/usr/bin/env node
// S6: CLI wrapper around engine.mjs. Reads an input and a config, writes the report.
//
// Usage: node plans/spikes/s6/advise.mjs --input <input.json> --config plans/spikes/s6/config.json --out <report.json>
// Prints the advice counts.

import { readFileSync, writeFileSync } from 'node:fs';
import { args } from '../s2/exec.mjs';
import { advise } from './engine.mjs';

const opt = args(process.argv.slice(2));
if (!opt.input || !opt.config || !opt.out) { console.error('usage: advise.mjs --input <json> --config <json> --out <json>'); process.exit(2); }
const report = advise(JSON.parse(readFileSync(opt.input, 'utf8')), JSON.parse(readFileSync(opt.config, 'utf8')));
writeFileSync(opt.out, JSON.stringify(report, null, 1));
console.log(JSON.stringify(report.counts));
