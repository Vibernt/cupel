import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadOriginalVitestConfig(original, root, env) {
  if (!original) return {};

  const projectRequire = createRequire(join(root, 'package.json'));
  let viteError;
  try {
    const vite = await import(pathToFileURL(projectRequire.resolve('vite')).href);
    if (typeof vite.loadConfigFromFile === 'function') {
      const loaded = await vite.loadConfigFromFile(env, original, root);
      if (loaded) return loaded.config;
    }
  } catch (error) {
    viteError = error;
  }

  const values = {
    __dirname: dirname(original),
    __filename: original,
    require: createRequire(original),
  };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, {
    exists: Object.hasOwn(globalThis, key), value: globalThis[key],
  }]));
  try {
    Object.assign(globalThis, values);
    const imported = (await import(pathToFileURL(original).href)).default;
    return typeof imported === 'function' ? await imported(env) : imported;
  } catch (error) {
    if (viteError) throw new AggregateError([viteError, error], `could not load ${original}`);
    throw error;
  } finally {
    for (const [key, prior] of Object.entries(previous)) {
      if (prior.exists) globalThis[key] = prior.value;
      else delete globalThis[key];
    }
  }
}
