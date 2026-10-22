import { appendFileSync } from 'node:fs';

const vitest = await import(process.env.CUPEL_VITEST_IMPORT);
const mark = (kind, task) => {
  const names = [];
  for (let parent = task.parent; parent?.type === 'suite'; parent = parent.parent) names.unshift(parent.name);
  appendFileSync(process.env.CUPEL_VITEST_MUTATION_MARKS, `${kind} ${[...names, task.name].join(' > ')}\n`);
};
vitest.beforeEach((context) => mark('S', context.task));
vitest.afterEach((context) => vitest.onTestFinished(() => mark('E', context.task)));
