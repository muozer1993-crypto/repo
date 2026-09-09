// Expo's flat config. `npx expo lint` and `npm run lint -w apps/mobile` use this.
// The React Compiler rules matter here: `experiments.reactCompiler` is on in
// app.json, so a "cannot access refs during render" error is a real bug, not a
// style preference.
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', '.expo/*', 'android/*', 'ios/*'],
  },
  {
    files: ['**/__tests__/**/*.{ts,tsx}', 'jest.setup.js'],
    // `jest.mock` factories have to use require(): the module must not be
    // hoisted into an import.
    rules: { '@typescript-eslint/no-require-imports': 'off' },
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        jest: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
      },
    },
  },
]);
