module.exports = {
  testEnvironment: 'node',
  testRunner: 'jest-circus/runner',
  testMatch: ['<rootDir>/tests/*.test.cjs', '<rootDir>/tests/*.test.ts'],
  transform: { '^.+\\.tsx?$': '<rootDir>/transform.cjs' },
  maxWorkers: 1,
  cache: false,
};
