// Each completed Vitest case is persisted immediately, including when a later case hangs or crashes.
import { appendFileSync } from 'node:fs';

export default class CupelMutantVitestReporter {
  onTestCaseResult(test) {
    const names = [];
    for (let parent = test.parent; parent?.type === 'suite'; parent = parent.parent) names.unshift(parent.name);
    const state = test.result().state;
    appendFileSync(process.env.CUPEL_VITEST_MUTATION_REPORT,
      `${JSON.stringify({ s: state === 'failed' ? 'fail' : state === 'passed' ? 'pass' : 'skip', t: [...names, test.name].join(' > ') })}\n`);
  }
}
