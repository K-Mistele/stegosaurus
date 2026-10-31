import type { Categories, Rules } from './types';

export const builtinCategories = {
    correctness: 'error',
    suspicious: 'error',
} satisfies Categories;

export const builtinRules = {
    'no-console': 'error',
    'no-empty': 'error',
    'no-empty-function': 'error',
    'no-eq-null': 'error',
    'oxc/no-accumulating-spread': 'error',
    'import/extensions': ['error', 'never', { ignorePackages: true }],
    'no-unused-vars': 'error',
    'unicorn/filename-case': 'error',
    // Clashes with Effect's `if (bad) return yield* Err.make(...)` followed by an implicit void return.
    'typescript/consistent-return': 'off',
    'require-yield': 'off',
    'no-shadow': 'off',
    'no-img-element': 'off',
    'react-in-jsx-scope': 'off',
    'exhaustive-deps': 'off',
    'no-underscore-dangle': 'off',
} satisfies Rules;
