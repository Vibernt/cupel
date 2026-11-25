import { join } from 'node:path';

// Hosted CI prepares these dependency trees explicitly. Keep the maintainer's
// read-only CodeCrystal trees as the local default so existing runs do not move.
export function vitestModulePaths(env = process.env) {
  return {
    v4: env.CUPEL_TEST_VITEST4_MODULES ?? '/Users/vid/codecrystal/hub-ts/node_modules',
    v5: env.CUPEL_TEST_VITEST5_MODULES ?? '/Users/vid/codecrystal/web/node_modules',
  };
}

const paths = vitestModulePaths();
export const VITEST4_MODULES = paths.v4;
export const VITEST5_MODULES = paths.v5;

export const VITEST_VERSIONS = [
  ['4.1.11', VITEST4_MODULES],
  ['5.0.1', VITEST5_MODULES],
];
export const VITEST4_TYPESCRIPT = join(VITEST4_MODULES, 'typescript');
export const VITEST5_TYPESCRIPT = join(VITEST5_MODULES, 'typescript');
export const VITEST5_REACT = join(VITEST5_MODULES, 'react');
