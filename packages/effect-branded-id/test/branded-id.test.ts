import { it, expect } from '@effect/vitest';
import { Effect, Exit, Schema, String as Str } from 'effect';

import { makeBrandedId, type BrandedIdOf, isCuid } from '../src/index';

const UserId = makeBrandedId('usr', { brand: 'UserId' });

type UserId = BrandedIdOf<typeof UserId>;

const OrderId = makeBrandedId('ord', { brand: 'OrderId' });

type OrderId = BrandedIdOf<typeof OrderId>;

it('creates schema with correct brand', () => {
    expect(UserId.brand).toBe('UserId');
    expect(UserId.prefix).toBe('usr');
});

it('handles multi-word prefixes', () => {
    const UserAccountId = makeBrandedId('user_account', { brand: 'UserAccountId' });
    expect(UserAccountId.prefix).toBe('user_account');
    expect(Str.startsWith('user_account_')(UserAccountId.create())).toBe(true);
});

it('accepts custom brand name', () => {
    const CustomId = makeBrandedId('cst', { brand: 'MyCustomId' });
    expect(CustomId.brand).toBe('MyCustomId');
});

it('throws on invalid prefix', () => {
    expect(() => makeBrandedId('', { brand: 'BadId' })).toThrow('Invalid prefix');
    expect(() => makeBrandedId('123', { brand: 'BadId' })).toThrow('Invalid prefix');
    expect(() => makeBrandedId('UPPER', { brand: 'BadId' })).toThrow('Invalid prefix');
    expect(() => makeBrandedId('_starts_underscore', { brand: 'BadId' })).toThrow('Invalid prefix');
});

it('generates valid IDs with prefix', () => {
    const id = UserId.create();
    expect(Str.startsWith('usr_')(id)).toBe(true);
});

it('generates valid CUID2 suffix', () => {
    const id = UserId.create();
    const cuid = Str.slice(4)(id); // Remove "usr_"
    expect(isCuid(cuid)).toBe(true);
});

it('generates unique IDs', () => {
    const ids = Array.from({ length: 100 }, () => UserId.create());
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(100);
});

it('make() creates branded ID from valid string', () => {
    const id = UserId.create();
    const made = UserId.make(id);
    expect(made).toBe(id);
});

it('make() validates input and throws on invalid', () => {
    // In Effect Schema, make() validates. Use for trusted input that still needs type narrowing.
    expect(() => UserId.make('usr_invalid')).toThrow('Schema validation failed');
});

it('is() returns true for valid IDs', () => {
    const id = UserId.create();
    expect(UserId.is(id)).toBe(true);
});

it('is() returns false for wrong prefix', () => {
    const orderId = OrderId.create();
    expect(UserId.is(orderId)).toBe(false);
});

it('is() returns false for invalid CUID', () => {
    expect(UserId.is('usr_notacuid')).toBe(false);
});

it('is() returns false for malformed input', () => {
    expect(UserId.is('')).toBe(false);
    expect(UserId.is('usr')).toBe(false);
    expect(UserId.is('nounderscore')).toBe(false);
});

it.effect('decodes valid IDs', () =>
    Effect.gen(function* () {
        const id = UserId.create();
        const exit = yield* Effect.exit(Schema.decodeEffect(UserId)(id));
        expect(exit).toStrictEqual(Exit.succeed(id));
    }),
);

it.effect('fails to decode wrong prefix', () =>
    Effect.gen(function* () {
        const orderId = OrderId.create();
        const exit = yield* Effect.exit(Schema.decodeEffect(UserId)(orderId));
        expect(exit._tag).toBe('Failure');
    }),
);

it.effect('fails to decode invalid CUID', () =>
    Effect.gen(function* () {
        const exit = yield* Effect.exit(Schema.decodeEffect(UserId)('usr_invalid'));
        expect(exit._tag).toBe('Failure');
    }),
);

it.effect('fails to decode missing prefix', () =>
    Effect.gen(function* () {
        const exit = yield* Effect.exit(Schema.decodeEffect(UserId)('noprefixhere'));
        expect(exit._tag).toBe('Failure');
    }),
);

it('different ID types are incompatible at compile time', () => {
    // This test verifies compile-time behavior
    // TypeScript should prevent: getUser(OrderId.create())
    const orderId: OrderId = OrderId.create();

    // @ts-expect-error - UserId and OrderId should be incompatible
    const wrongAssignment: UserId = orderId;

    expect(wrongAssignment).toBe(orderId);
});
