module.exports = {
  preset: 'jest-expo',
  clearMocks: true,
  // react-native-worklets (reanimated 4's runtime) throws on import under Jest unless its
  // ".native"-stripping resolver picks the mockable build (see its jest/resolver.js).
  resolver: 'react-native-worklets/jest/resolver.js',
  // Gesture-handler's official Jest mock, needed once tests render components that sit
  // inside a GestureHandlerRootView / GestureDetector (e.g. BottomSheet).
  setupFiles: ['react-native-gesture-handler/jestSetup.js'],
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  testMatch: ['<rootDir>/test/**/*.test.[jt]s?(x)'],
  moduleNameMapper: {
    '^@gorhom/bottom-sheet$': '<rootDir>/test/mocks/bottomSheet.tsx',
    '^react-native-track-player$': '<rootDir>/test/mocks/trackPlayer.ts',
    // Official mock: the real module binds native keyboard event emitters at import time,
    // which throws under Jest once a component imports KeyboardAvoidingView from it.
    '^react-native-keyboard-controller$': 'react-native-keyboard-controller/jest',
    '^@/(.*)$': '<rootDir>/src/$1',
  },
};
