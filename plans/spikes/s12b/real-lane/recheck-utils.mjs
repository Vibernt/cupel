export const FILES = [
  'tests/unit/rehype-accessible-tables.test.mjs',
  'tests/unit/rehype-rewrite-localized-links.test.mjs',
  'tests/unit/remark-code-tabs.test.mjs',
  'tests/unit/remark-rewrite-localized-links.test.mjs',
];

export function resultRows(output, root) {
  const counts = new Map();
  const rows = [];
  let plan = false;
  for (const line of output.split('\n').filter(Boolean)) {
    const event = JSON.parse(line);
    if (event.type === 'test:plan') plan = true;
    if (!['test:pass', 'test:fail'].includes(event.type) || event.data.details?.type === 'suite') continue;
    const file = event.data.file?.slice(root.length + 1);
    if (!file || !FILES.includes(file)) throw new Error(`unrecognized test file: ${file}`);
    const key = `${file}:${event.data.name}`;
    const ordinal = (counts.get(key) ?? 0) + 1;
    counts.set(key, ordinal);
    rows.push({ file, id: `${event.data.name}#${ordinal}`,
      status: event.data.skip || event.data.todo ? 'skipped' : event.type === 'test:fail' ? 'failed' : 'passed' });
  }
  if (!plan || !rows.length) throw new Error('incomplete ordinary runner stream');
  return rows;
}

export function assertRowsEqual(actual, expected, label) {
  const key = row => `${row.file}\0${row.id}\0${row.status}`;
  const left = actual.map(key).sort();
  const right = expected.map(key).sort();
  if (JSON.stringify(left) !== JSON.stringify(right)) throw new Error(`${label}: exact test rows differ`);
}

export function assertCapture(capture, files, expectedFailures, label) {
  if (capture.sidecar.completion.errors.length || capture.sidecar.denials.length ||
    capture.sidecar.global.unsupported.length ||
    JSON.stringify(capture.sidecar.completion.finishedFiles) !== JSON.stringify([...files].sort()))
    throw new Error(`${label}: incomplete or unsupported profile capture`);
  if (capture.ordinaryFull === null || capture.constrainedFull.parity !== true)
    throw new Error(`${label}: ordinary/constrained full parity missing`);
  if (capture.ordinaryFull.privacyGuarded !== true || !capture.sidecar.fullReferenceGuard)
    throw new Error(`${label}: privacy-guarded full reference proof missing`);
  const rows = capture.ordinaryFull.rows;
  if (rows.length !== 65 || rows.filter(row => row.status === 'failed').length !== expectedFailures)
    throw new Error(`${label}: expected 65 rows and ${expectedFailures} failures`);
  assertRowsEqual(capture.constrainedFull.rows, rows, label);
}

export const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
export const pairOrder = pair => pair % 2 === 0 ? ['selected', 'full'] : ['full', 'selected'];

export function originCounts(sidecar) {
  const counts = {};
  for (const channels of Object.values(sidecar.files)) for (const event of channels.filesystemEvents) {
    const key = `${event.channel}:${event.origin}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
