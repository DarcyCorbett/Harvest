// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', 'apps/*', '.worktrees/*'],
  },
  {
    // Syncing local form state from props inside an effect is flagged across
    // ten older screens. It is a performance smell rather than a bug, so it is
    // reported without failing the build until those screens are reworked.
    rules: { 'react-hooks/set-state-in-effect': 'warn' },
  },
]);
