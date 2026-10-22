import { createHash } from 'node:crypto';
import { existsSync, globSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const configFiles = ['vitest.config.mts', 'vitest.config.ts', 'vitest.config.mjs', 'vitest.config.js',
  'vite.config.mts', 'vite.config.ts', 'vite.config.mjs', 'vite.config.js'];
const helperUrl = import.meta.url;

export function findVitestWorkspace(root) {
  for (const kind of ['workspace', 'projects']) for (const ext of ['mts', 'ts', 'mjs', 'js', 'json']) {
    const file = `vitest.${kind}.${ext}`;
    if (existsSync(join(root, file))) return file;
  }
  return undefined;
}

function projectName(path) {
  const dir = statSync(path).isDirectory() ? path : dirname(path);
  const packageFile = join(dir, 'package.json');
  if (existsSync(packageFile)) {
    const name = JSON.parse(readFileSync(packageFile, 'utf8')).name;
    if (name) return name;
  }
  return basename(dir);
}

function expandEntry(entry, root) {
  const pattern = entry.replaceAll('<rootDir>', root);
  const paths = /[*?{[\]]/.test(pattern) ? [...globSync(pattern, { cwd: root })].sort() : [pattern];
  return paths.map((path) => {
    const absolute = isAbsolute(path) ? path : resolve(root, path);
    if (!existsSync(absolute)) throw new Error(`Vitest project does not exist: ${absolute}`);
    if (statSync(absolute).isDirectory()) {
      const names = readdirSync(absolute);
      const config = configFiles.find((file) => names.includes(file));
      return config ? join(absolute, config) : absolute;
    }
    return absolute;
  });
}

function wrapProject(path, { work, setupFile, pluginModule }) {
  // Keep a file entry: Vitest 5 reads its name before resolving inline entries.
  // The wrapper loads the owner's config, then adds Cupel's hook inside that project.
  const file = statSync(path).isFile();
  const root = file ? dirname(path) : path;
  const hash = createHash('sha256').update(path).digest('hex').slice(0, 16);
  const wrapper = join(work, `vitest.cupel-${hash}.config.mjs`);
  const original = file ? `import original from ${JSON.stringify(pathToFileURL(path).href)};` : 'const original = {};';
  const plugin = pluginModule ? `import { createMutantPlugin } from ${JSON.stringify(pluginModule)};` : '';
  writeFileSync(wrapper, `${original}\n${plugin}\nimport { resolve } from 'node:path';\nimport { injectVitestProjects } from ${JSON.stringify(helperUrl)};\n` +
    `export default async (env) => { const base = typeof original === 'function' ? await original(env) : original;\n` +
    `const test = base.test ?? {}; const root = resolve(${JSON.stringify(root)}, test.root ?? base.root ?? '.');\n` +
    `return await injectVitestProjects({ ...base, root, test: { ...test, root, name: test.name ?? ${JSON.stringify(projectName(path))} } }, ` +
    `{ root, work: ${JSON.stringify(work)}, setupFile: ${JSON.stringify(setupFile)}, ` +
    `plugin: ${pluginModule ? 'createMutantPlugin()' : 'undefined'}, pluginModule: ${JSON.stringify(pluginModule)} }); };\n`);
  return wrapper;
}

function injectProject(project, setupFile, plugin) {
  const test = project.test ?? {};
  const setup = test.setupFiles;
  return { ...project,
    ...(plugin ? { plugins: [...(project.plugins ?? []), plugin] } : {}),
    test: { ...test, pool: 'forks', includeTaskLocation: true,
      setupFiles: [...(Array.isArray(setup) ? setup : setup ? [setup] : []), setupFile],
      coverage: { ...(test.coverage ?? {}), enabled: false } },
  };
}

async function workspaceDefinitions(path, root) {
  const absolute = resolve(root, path);
  if (!existsSync(absolute)) throw new Error(`Vitest workspace file does not exist: ${absolute}`);
  if (absolute.endsWith('.json')) return JSON.parse(readFileSync(absolute, 'utf8'));
  return (await import(pathToFileURL(absolute).href)).default;
}

export async function injectVitestProjects(base, { root, work, setupFile, plugin, pluginModule, include, workspaceFile }) {
  const { cache: ignoredCache, ...test } = base.test ?? {};
  const workspace = test.projects === undefined && (test.workspace ?? workspaceFile);
  const definitions = test.projects ?? (typeof workspace === 'string' ? await workspaceDefinitions(workspace, root) : workspace);
  if (definitions !== undefined && !Array.isArray(definitions)) throw new Error('Cupel requires an array in test.projects or test.workspace');
  const projects = definitions?.flatMap((entry) => {
    if (typeof entry !== 'string') return [injectProject(entry, setupFile, plugin)];
    return expandEntry(entry, root).map((path) => wrapProject(path, { work, setupFile, pluginModule }));
  });
  const setup = test.setupFiles;
  return { ...base,
    ...(plugin && !projects ? { plugins: [...(base.plugins ?? []), plugin] } : {}),
    test: { ...test, ...(projects ? { [test.projects === undefined ? 'workspace' : 'projects']: projects } : {}),
      ...(include && !projects ? { include } : {}),
      pool: 'forks', includeTaskLocation: true,
      ...(!projects ? { setupFiles: [...(Array.isArray(setup) ? setup : setup ? [setup] : []), setupFile] } : {}),
      coverage: { ...(test.coverage ?? {}), enabled: false } },
  };
}
