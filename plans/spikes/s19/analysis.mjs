function finite(value, label, positive = false) {
  if (!Number.isFinite(value) || (positive ? value <= 0 : value < 0))
    throw new Error(`invalid ${label}: ${value}`);
  return value;
}

function count(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid ${label}: ${value}`);
  return value;
}

export function median(values) {
  if (!values.length) throw new Error('median needs measured values');
  values.forEach((value, i) => finite(value, `median value ${i}`));
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export function totals(call) {
  if (!call?.profiles?.mutation || !call?.profiles?.confirmation)
    throw new Error('missing mutation or confirmation profile');
  const phases = [call.profiles.mutation, call.profiles.confirmation];
  for (const [index, phase] of phases.entries()) {
    const prefix = index ? 'confirmation' : 'mutation';
    for (const key of ['calls', 'selectNs', 'parseCalls', 'parseNs', 'firstParseCalls',
      'firstParseNs', 'repeatedParseCalls', 'repeatedParseNs', 'testRows', 'fileRows',
      'selectedTests', 'selectedFiles', 'targetedFull', 'uniqueCoverageStrings'])
      count(phase[key], `${prefix}.${key}`);
    if (phase.firstParseCalls + phase.repeatedParseCalls !== phase.parseCalls ||
      phase.firstParseNs + phase.repeatedParseNs !== phase.parseNs ||
      phase.uniqueCoverageStrings !== phase.firstParseCalls ||
      phase.parseNs > phase.selectNs || phase.targetedFull > phase.calls ||
      phase.parseCalls > phase.testRows + phase.fileRows)
      throw new Error(`inconsistent ${prefix} selection profile`);
  }
  const sum = key => phases.reduce((value, phase) => value + phase[key], 0);
  return { calls: sum('calls'), selectMs: sum('selectNs') / 1e6,
    parseCalls: sum('parseCalls'), parseMs: sum('parseNs') / 1e6,
    firstParseCalls: sum('firstParseCalls'), firstParseMs: sum('firstParseNs') / 1e6,
    repeatedParseCalls: sum('repeatedParseCalls'), repeatedParseMs: sum('repeatedParseNs') / 1e6,
    testRows: sum('testRows'), fileRows: sum('fileRows'),
    selectedTests: sum('selectedTests'), selectedFiles: sum('selectedFiles'),
    targetedFull: sum('targetedFull') };
}

export function decision(controlWalls, profiled, clockPairNs, outerSelectMs = null) {
  if (!controlWalls.length || !profiled.length) throw new Error('missing paired measurements');
  controlWalls.forEach((wall, i) => finite(wall, `control wall ${i}`, true));
  finite(clockPairNs, 'calibrated clock pair nanoseconds');
  if (outerSelectMs !== null) finite(outerSelectMs, 'outer-only selection milliseconds');
  const denominatorMs = median(controlWalls);
  const samples = profiled.map(totals);
  const selectMs = median(samples.map(row => row.selectMs));
  const repeatedParseMs = median(samples.map(row => row.repeatedParseMs));
  const selectShare = selectMs / denominatorMs;
  const repeatShare = repeatedParseMs / denominatorMs;
  const calibratedClockOverheadMs = median(samples.map(row =>
    (row.calls + row.parseCalls) * clockPairNs / 1e6));
  const selectionGate = selectMs >= 10 && selectShare >= 0.05;
  const savingCeilingGate = repeatedParseMs >= 10 && repeatShare >= 0.05;
  const near = (ms, share) => Math.abs(ms - 10) <= Math.max(2, calibratedClockOverheadMs) ||
    Math.abs(share - 0.05) <= 0.01;
  const outerTimerNeeded = selectionGate || savingCeilingGate ||
    near(selectMs, selectShare) || near(repeatedParseMs, repeatShare);
  const outerSelectionGate = outerSelectMs !== null && outerSelectMs >= 10 &&
    outerSelectMs / denominatorMs >= 0.05;
  return { denominatorMs, selectMs, selectShare, repeatedParseMs, repeatShare,
    calibratedClockOverheadMs, selectionGate, savingCeilingGate, outerSelectMs,
    eligibleForAstraReview: selectionGate && savingCeilingGate &&
      (!outerTimerNeeded || outerSelectionGate), outerTimerNeeded };
}
