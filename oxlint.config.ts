import santux from '@santux/oxc-config/lint'
import { defineConfig } from 'oxlint'

export default defineConfig({
  extends: [santux],
  ignorePatterns: ['**/build', '**/dist'],
  overrides: [
    {
      // The CLI and dev scripts talk to the user through stdout and stderr
      files: ['src/cli/**', 'scripts/**'],
      rules: { 'no-console': 'off' },
    },
  ],
})
