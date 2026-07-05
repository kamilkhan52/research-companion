module.exports = {
  preset: 'jest-expo',
  clearMocks: true,
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  testMatch: ['<rootDir>/test/**/*.test.[jt]s?(x)'],
  moduleNameMapper: {
    '^react-native-track-player$': '<rootDir>/test/mocks/trackPlayer.ts',
    '^@/(.*)$': '<rootDir>/src/$1',
  },
};
