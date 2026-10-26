const validStatus = new Set(['passed', 'failed', 'skipped']);

export function reporterRows(output, root, files) {
  const counts = new Map();
  const rows = [];
  let plan = false;
  for (const line of output.split('\n').filter(Boolean)) {
    const event = JSON.parse(line);
    if (event.type === 'test:plan') plan = true;
    if (!['test:pass', 'test:fail'].includes(event.type) || event.data.details?.type === 'suite') continue;
    const file = event.data.file?.startsWith(`${root}/`) ? event.data.file.slice(root.length + 1) : null;
    if (!files.includes(file)) throw new Error('full reference has foreign test file');
    const key = `${file}\0${event.data.name}`;
    const ordinal = (counts.get(key) ?? 0) + 1;
    counts.set(key, ordinal);
    rows.push({ file, id: `${event.data.name}#${ordinal}`,
      status: event.data.skip || event.data.todo ? 'skipped' :
        event.type === 'test:fail' ? 'failed' : 'passed' });
  }
  if (!plan || !rows.length) throw new Error('full reference result stream incomplete');
  return exactRows(rows, 'full reference');
}

export function exactRows(rows, label) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`${label}: missing test rows`);
  const seen = new Set();
  return rows.map(row => {
    if (typeof row?.file !== 'string' || !row.file || typeof row.id !== 'string' || !row.id ||
      !validStatus.has(row.status)) throw new Error(`${label}: invalid test row`);
    const key = `${row.file}\0${row.id}`;
    if (seen.has(key)) throw new Error(`${label}: duplicate test ID`);
    seen.add(key);
    return { file: row.file, id: row.id, status: row.status };
  }).sort((a, b) => `${a.file}\0${a.id}`.localeCompare(`${b.file}\0${b.id}`));
}

export function assertSameRows(left, right, label) {
  if (JSON.stringify(exactRows(left, `${label} left`)) !==
      JSON.stringify(exactRows(right, `${label} right`)))
    throw new Error(`${label}: exact IDs/statuses differ`);
}

export function assertSelectedCatches(fullRows, selectedRows, files, allFiles, expectedFailures) {
  if (!Array.isArray(files) || !files.length ||
    files.some(file => !allFiles.includes(file)) || new Set(files).size !== files.length)
    throw new Error('selected file inventory invalid');
  const full = exactRows(fullRows, 'full oracle');
  const selected = exactRows(selectedRows, 'selected head');
  const failures = full.filter(row => row.status === 'failed');
  if (failures.length !== expectedFailures) throw new Error('full oracle failure count differs');
  if (failures.some(row => !files.includes(row.file)))
    throw new Error('selected files miss a full-oracle failure');
  assertSameRows(selected, full.filter(row => files.includes(row.file)), 'selected versus full');
  return { fullTests: full.length, selectedTests: selected.length,
    fullFailures: failures.length, selectedFiles: files.length,
    strictSubset: files.length < allFiles.length };
}

export function assertFullCapture(capture, files, failures, label) {
  const sidecar = capture?.sidecar;
  const guard = sidecar?.fullReferenceGuard;
  if (capture?.ordinaryFull?.privacyGuarded !== true ||
    capture?.constrainedFull?.parity !== true ||
    guard?.mode !== 'privacy-guarded' ||
    JSON.stringify(guard.expectedFiles) !== JSON.stringify(files) ||
    JSON.stringify(guard.finishedFiles) !== JSON.stringify(files) ||
    guard.errors?.length || guard.denials?.length || sidecar.denials?.length ||
    sidecar.global?.unsupported?.length || sidecar.completion?.errors?.length ||
    JSON.stringify(sidecar.completion?.finishedFiles) !== JSON.stringify(files))
    throw new Error(`${label}: full privacy/parity proof incomplete`);
  assertSameRows(capture.ordinaryFull.rows, capture.constrainedFull.rows, label);
  const rows = exactRows(capture.ordinaryFull.rows, label);
  if (rows.length !== 65 || rows.filter(row => row.status === 'failed').length !== failures)
    throw new Error(`${label}: 65-test full oracle or failure count differs`);
  return rows;
}
