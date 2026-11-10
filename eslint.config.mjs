/** ESLint configuration for source files and the VS Code test stub */

import tseslint from 'typescript-eslint';

export default tseslint.config(
    {
        ignores: ['out/**', 'out-test/**', 'node_modules/**', '.history/**', '.idea/**', 'tmp/**']
    },

    ...tseslint.configs.recommended,

    {
        files: ['**/*.ts'],

        rules: {
            indent: ['error', 4, { SwitchCase: 1, flatTernaryExpressions: true }],
            quotes: ['error', 'single', { avoidEscape: true }],
            semi: ['error', 'always'],
            'comma-dangle': ['error', 'never'],
            'object-curly-spacing': ['error', 'always'],
            'space-before-blocks': 'error',
            'keyword-spacing': 'error',
            'arrow-spacing': 'error',
            'no-trailing-spaces': 'error',
            'eol-last': ['error', 'always'],
            'no-multiple-empty-lines': ['error', { max: 1, maxBOF: 0, maxEOF: 1 }],
            'max-len': [
                'error',
                {
                    code: 100,
                    ignoreUrls: true,
                    ignoreStrings: true,
                    ignoreTemplateLiterals: true,
                    ignoreRegExpLiterals: true
                }
            ],

            'padding-line-between-statements': [
                'error',
                { blankLine: 'always', prev: '*', next: 'return' },
                { blankLine: 'any', prev: 'return', next: '*' }
            ],

            curly: ['error', 'multi-line'],
            eqeqeq: ['error', 'always'],
            'no-var': 'error',
            'prefer-const': 'error',
            'no-console': 'error',
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
            ]
        }
    },

    {
        // The editor stub needs dynamic API shapes and CommonJS module replacement
        files: ['test/**/*.ts'],

        rules: {
            'no-console': 'off',
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-require-imports': 'off'
        }
    }
);
