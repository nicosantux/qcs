import eslint from '@eslint/js'
import { defineConfig, globalIgnores } from 'eslint/config'
import eslintConfigPrettier from 'eslint-config-prettier/flat'
import checkFilePlugin from 'eslint-plugin-check-file'
import importOrderPlugin from 'eslint-plugin-import'
import reactHooksPlugin from 'eslint-plugin-react-hooks'
import unicornPlugin from 'eslint-plugin-unicorn'
import globals from 'globals'
import tsEslint from 'typescript-eslint'

export default defineConfig([
  globalIgnores(['node_modules', 'dist', '.dev-home']),
  // Vanilla ESLint
  {
    extends: [eslint.configs.recommended],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-await-in-loop': 'error',
      'no-console': 'error',
      'no-else-return': 'warn',
      'no-implicit-coercion': 'error',
      'no-param-reassign': 'error',
      'no-return-await': 'error',
      'no-self-compare': 'error',
      'no-undef-init': 'warn',
      'no-unneeded-ternary': 'error',
      'no-var': 'error',
      'object-shorthand': 'warn',
      'prefer-const': 'warn',
      'prefer-object-spread': 'warn',
      'prefer-rest-params': 'error',
      'prefer-spread': 'error',
      'prefer-template': 'warn',
    },
  },
  // The CLI and dev scripts talk to the user through stdout and stderr
  {
    files: ['src/cli/**', 'scripts/**'],
    rules: { 'no-console': 'off' },
  },
  // Check files
  {
    plugins: { 'check-file': checkFilePlugin },
    rules: {
      'check-file/filename-naming-convention': [
        'error',
        { '**/*.{js,jsx,ts,tsx}': 'KEBAB_CASE' },
        { ignoreMiddleExtensions: true },
      ],
    },
  },
  // Import order
  {
    plugins: { import: importOrderPlugin },
    rules: {
      'import/first': 'error',
      'import/newline-after-import': 'warn',
      'import/no-cycle': 'error',
      'import/no-mutable-exports': 'error',
      'import/no-self-import': 'error',
      'import/no-useless-path-segments': 'error',
      'import/order': [
        'warn',
        {
          alphabetize: { order: 'asc', caseInsensitive: true },
          groups: ['type', 'builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          'newlines-between': 'always',
          pathGroups: [
            {
              pattern: '{react,react/**}',
              group: 'builtin',
              position: 'before',
            },
          ],
          pathGroupsExcludedImportTypes: ['builtin', 'internal'],
          warnOnUnassignedImports: true,
        },
      ],
    },
  },
  // React (the TUI renders opentui elements, so the DOM-oriented React rules do not apply)
  {
    files: ['**/*.{jsx,tsx}'],
    extends: [reactHooksPlugin.configs.flat['recommended-latest']],
  },
  // Stylistic
  {
    rules: {
      'padding-line-between-statements': [
        'warn',
        { blankLine: 'always', prev: 'directive', next: '*' },
        { blankLine: 'always', prev: '*', next: 'block-like' },
        { blankLine: 'always', prev: 'block-like', next: '*' },
        { blankLine: 'always', prev: '*', next: 'return' },
        { blankLine: 'always', prev: ['const', 'let', 'var'], next: '*' },
        {
          blankLine: 'any',
          prev: ['singleline-const', 'singleline-let', 'singleline-var'],
          next: ['singleline-const', 'singleline-let', 'singleline-var'],
        },
      ],
    },
  },
  // TypeScript
  {
    extends: [tsEslint.configs.recommendedTypeChecked, tsEslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true },
    },
    rules: {
      '@typescript-eslint/consistent-type-exports': [
        'warn',
        { fixMixedExportsWithInlineTypeSpecifier: true },
      ],
      '@typescript-eslint/consistent-type-imports': ['warn', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/default-param-last': 'error',
      '@typescript-eslint/member-ordering': [
        'error',
        { interfaces: { order: 'natural-case-insensitive' } },
      ],
      '@typescript-eslint/method-signature-style': 'warn',
      '@typescript-eslint/naming-convention': [
        'error',
        { format: ['PascalCase'], selector: ['typeLike', 'enumMember'] },
        {
          custom: {
            match: false,
            regex: '^I[A-Z]|^(Interface|Props|State)$',
          },
          format: ['PascalCase'],
          selector: 'interface',
        },
      ],
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
      '@typescript-eslint/no-loop-func': 'error',
      '@typescript-eslint/no-redundant-type-constituents': 'warn',
      '@typescript-eslint/no-unnecessary-qualifier': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'all',
          argsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      '@typescript-eslint/prefer-nullish-coalescing': [
        'error',
        {
          ignorePrimitives: {
            bigint: true,
            boolean: true,
            number: true,
            string: true,
          },
        },
      ],
      '@typescript-eslint/require-array-sort-compare': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/triple-slash-reference': 'off',
    },
  },
  // Disable type checked in .js files
  {
    files: ['**/*.{js,cjs,mjs}'],
    ...tsEslint.configs.disableTypeChecked,
  },
  // Unicorn
  {
    plugins: { unicorn: unicornPlugin },
    rules: {
      'unicorn/error-message': 'error',
      'unicorn/no-empty-file': 'error',
      'unicorn/prefer-node-protocol': 'warn',
    },
  },
  // Prettier
  eslintConfigPrettier,
])
