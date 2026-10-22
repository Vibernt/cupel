import { writeFileSync } from 'node:fs';

export default class CupelVitestReporter {
  onTestRunEnd(modules, errors) {
    const tests = [];
    for (const module of modules) {
      for (const test of module.children.allTests()) {
        const names = [];
        for (let parent = test.parent; parent?.type === 'suite'; parent = parent.parent) names.unshift(parent.name);
        const state = test.result().state;
        tests.push({ taskId: test.id, file: module.moduleId, name: [...names, test.name].join(' > '),
          title: test.name, status: state === 'pending' ? 'skipped' : state,
          line: test.location?.line, column: test.location?.column,
          duration: test.diagnostic()?.duration ?? 0 });
      }
    }
    const modulesWithErrors = modules.flatMap((module) => module.errors().map((error) => ({ file: module.moduleId, error })));
    writeFileSync(process.env.CUPEL_VITEST_RESULTS, JSON.stringify({ tests, errors, modulesWithErrors }));
  }
}
