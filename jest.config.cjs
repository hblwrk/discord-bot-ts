/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testEnvironmentOptions: {
    globalsCleanup: 'off',
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  collectCoverageFrom: [
    'index.ts',
    'modules/**/*.ts',
    '!modules/**/*.test.ts',
    '!modules/test-utils/**',
  ],
  coverageThreshold: {
    global: {
      statements: 75,
      lines: 75,
      functions: 65,
      branches: 58,
    },
    './modules/crypto-dice.ts': {
      statements: 100,
      lines: 100,
      functions: 100,
      branches: 100,
    },
    './modules/discord-logger.ts': {
      statements: 85,
      lines: 85,
      functions: 80,
      branches: 50,
    },
    './modules/dracoon-downloader.ts': {
      statements: 90,
      lines: 90,
      functions: 100,
      branches: 75,
    },
    './modules/http-retry.ts': {
      statements: 95,
      lines: 95,
      functions: 100,
      branches: 85,
    },
    './modules/inline-response.ts': {
      statements: 85,
      lines: 85,
      functions: 100,
      branches: 60,
    },
    './modules/lmgtfy.ts': {
      statements: 100,
      lines: 100,
      functions: 100,
      branches: 100,
    },
    './modules/mnc-downloader.ts': {
      statements: 90,
      lines: 90,
      functions: 100,
      branches: 100,
    },
    './modules/random-quote.ts': {
      statements: 100,
      lines: 100,
      functions: 100,
      branches: 80,
    },
    './modules/slash-commands.ts': {
      statements: 70,
      lines: 70,
      functions: 45,
      branches: 50,
    },
    './modules/startup-state.ts': {
      statements: 95,
      lines: 95,
      functions: 100,
      branches: 75,
    },
    './modules/tickers.ts': {
      statements: 90,
      lines: 90,
      functions: 100,
      branches: 70,
    },
  },
};
