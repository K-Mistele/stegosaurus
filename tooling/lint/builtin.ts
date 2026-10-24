import type { Categories, Rules } from './types';

export const builtinCategories = {
    correctness: 'error',
    suspicious: 'warn',
} satisfies Categories;

export const builtinRules = {
    'no-console': 'error',
    'no-empty': 'error',
    'no-empty-function': 'warn',
    'no-eq-null': 'error',
    'oxc/no-accumulating-spread': 'error',
    'import/extensions': ['error', 'never', { ignorePackages: true }],
    'no-unused-vars': 'warn',
    'unicorn/filename-case': 'error',
    'require-yield': 'off',
    'no-shadow': 'off',
    'no-img-element': 'off',
    'react-in-jsx-scope': 'off',
    'exhaustive-deps': 'off',
    'no-underscore-dangle': 'off',
} satisfies Rules;
