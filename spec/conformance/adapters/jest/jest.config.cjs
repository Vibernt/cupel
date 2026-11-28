module.exports = {
  testEnvironment: 'node',
  testRunner: 'jest-circus/runner',
  testMatch: ['**/tests/*.test.cjs', '**/tests/*.test.ts'], // <rootDir> globs break on Windows under a .scratch folder
  transform: { '^.+\\.tsx?$': '<rootDir>/transform.cjs' },
  maxWorkers: 1,
  cache: false,
};
