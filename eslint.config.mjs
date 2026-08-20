import js from '@eslint/js';
import prettier from 'eslint-config-prettier/flat';
import tseslint from 'typescript-eslint';

/**
 * Import boundaries that encode the architecture in `docs/architecture.md`.
 * These are cheap to write now and impossible to retrofit after the first
 * violation, so they are enforced in CI rather than by convention.
 */
const adapterPackages = [
  '@aiconfig/adapter-claude',
  '@aiconfig/adapter-codex',
  '@aiconfig/adapter-copilot',
  '@aiconfig/adapter-opencode',
];

const noFilesystem = [
  {
    name: 'node:fs',
    message: 'Adapters must not touch the filesystem. Return GeneratedFile descriptors instead.',
  },
  {
    name: 'node:fs/promises',
    message: 'Adapters must not touch the filesystem. Return GeneratedFile descriptors instead.',
  },
  {
    name: 'node:path',
    message: 'Adapters build repository-relative POSIX paths as plain strings; core resolves them.',
  },
];

const noVscode = {
  name: 'vscode',
  message: 'Only apps/vscode may import the VS Code API.',
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/out/**',
      '**/node_modules/**',
      '**/.vscode-test/**',
      '**/test/fixtures/**',
      'examples/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // An explicit list rather than `projectService`, because tests live
        // outside every package's own tsconfig and are typechecked as ESM by
        // the root test project.
        project: [
          './packages/*/tsconfig.json',
          './apps/vscode/tsconfig.json',
          './apps/vscode/tsconfig.test.json',
          './tsconfig.test.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      curly: 'error',
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
      'no-throw-literal': 'error',
      'no-else-return': 'error',
      'no-lonely-if': 'error',
      'object-shorthand': ['error', 'always'],
      'prefer-arrow-callback': 'error',
      'prefer-template': 'error',
      // One function form throughout. Arrow expressions are not hoisted, so a
      // helper called while its module is still evaluating has to be declared
      // above its first use, rather than working by accident.
      'func-style': ['error', 'expression', { allowArrowFunctions: true }],
      // Accessibility is stated rather than inferred, so widening a member to
      // the public surface is a visible edit in review.
      '@typescript-eslint/explicit-member-accessibility': 'error',
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/prefer-optional-chain': 'error',
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      '@typescript-eslint/array-type': ['error', { default: 'array' }],
      // Property signatures are checked contravariantly, method shorthand
      // bivariantly: the stricter form is the one that catches a wrong
      // implementation of `FileSystem` or `ProviderAdapter`.
      '@typescript-eslint/method-signature-style': ['error', 'property'],
      // `return promise` inside `try` settles after the block is left, so the
      // adjacent `catch` never sees the rejection.
      '@typescript-eslint/return-await': ['error', 'in-try-catch'],
      '@typescript-eslint/no-shadow': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },

  {
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            noVscode,
            ...adapterPackages.map((name) => ({
              name,
              message: 'Core must not depend on any adapter.',
            })),
          ],
        },
      ],
    },
  },

  {
    files: ['packages/adapter-*/src/**/*.ts', 'packages/agents-md/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            noVscode,
            ...noFilesystem,
            ...adapterPackages.map((name) => ({
              name,
              message:
                'An adapter must not import another adapter. Share code through @aiconfig/agents-md.',
            })),
          ],
          // Subpath specifiers would otherwise slip past the exact-name rules.
          patterns: [
            {
              group: ['@aiconfig/adapter-*/**'],
              message: 'An adapter must not import another adapter.',
            },
            {
              group: ['node:fs*', 'node:path*'],
              message: 'Adapters must not touch the filesystem.',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['apps/vscode/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          // The extension composes core and the provider set; it never reaches
          // past them into an individual adapter.
          patterns: [
            {
              group: ['@aiconfig/adapter-*', '@aiconfig/adapter-*/**'],
              message: 'apps/vscode depends on @aiconfig/core and @aiconfig/providers only.',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['packages/cli/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: [noVscode] }],
      // The CLI's entire job is writing to stdout.
      'no-console': 'off',
    },
  },

  {
    files: ['**/*.test.ts', '**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
    },
  },

  {
    files: ['**/*.mjs', '**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },

  {
    // Plain CommonJS build and launcher scripts, which run in Node directly.
    files: ['**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        console: 'readonly',
        module: 'readonly',
        process: 'readonly',
        require: 'readonly',
        __dirname: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  {
    // ESM maintenance scripts, run by hand or from a package script. Scoped to
    // 'scripts/' so the allowances do not reach the tool configuration files
    // that also end in .mjs.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
      },
    },
    rules: {
      // Reporting to the terminal is the entire purpose of these scripts.
      'no-console': 'off',
    },
  },

  // Last, so that it wins: formatting is Prettier's job, and a rule that
  // disagrees with the formatter is an unfixable lint error.
  prettier,
);
