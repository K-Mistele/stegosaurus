import { createId } from '@paralleldrive/cuid2';
import { type Brand, Option, Schema, String as Str } from 'effect';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Prefix validation regex - lowercase letters and underscores, 1-63 chars
 */
const prefixRegex = /^[a-z][a-z_]{0,61}[a-z]?$/;

/**
 * Validates that a prefix matches the allowed format
 */
const isValidPrefix = (prefix: string): boolean => prefixRegex.test(prefix);

/**
 * Validates a CUID2 string more strictly than the library's isCuid.
 * CUID2s are 24 characters of lowercase alphanumeric by default.
 */
const isValidCuid = (cuid: string): boolean => {
    // CUID2 default length is 24, all lowercase alphanumeric
    if (cuid.length < 21 || cuid.length > 32) return false;

    // Must be lowercase alphanumeric only
    return /^[a-z0-9]+$/.test(cuid);
};

/**
 * Extracts prefix and cuid from a branded ID string
 */
const parseId = (id: string, expectedPrefix: string): { prefix: string; cuid: string } | null => {
    const separatorIndex = Str.lastIndexOf('_')(id);

    if (Option.isNone(separatorIndex)) return null;

    const prefix = Str.slice(0, separatorIndex.value)(id);
    const cuid = Str.slice(separatorIndex.value + 1)(id);

    if (prefix !== expectedPrefix) return null;

    if (!isValidCuid(cuid)) return null;

    return { prefix, cuid };
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A branded ID type with a specific prefix brand
 */
export type BrandedId<Name extends string> = string & Brand.Brand<Name>;

/**
 * Infer the branded ID type from a BrandedIdSchema
 */
export type BrandedIdOf<T> = T extends { readonly Type: infer A } ? A : never;

/**
 * Extra methods added to branded ID schemas
 */
export interface BrandedIdMethods<Name extends string> {
    /** The brand name for this ID type */
    readonly brand: Name;
    /** The prefix used for this ID type */
    readonly prefix: string;
    /**
     * Create a new branded ID with a fresh CUID2
     * @example
     * const id = UserId.create() // "usr_ckopqwo2c0000ql08smxycfk"
     */
    readonly create: () => BrandedId<Name>;
    /**
     * Check if a string is a valid ID for this type
     * @example
     * UserId.is("usr_ckopqwo2c0000ql08smxycfk") // true
     * UserId.is("invalid") // false
     */
    readonly is: (input: string) => input is BrandedId<Name>;
}

/** A brand name `Schema.brand` accepts: one literal name, not a union or the whole of `string`. */
type SingleBrandName<Name extends string> = Parameters<typeof Schema.brand<Name>>[0];

/**
 * Options for creating a branded ID schema
 */
export interface BrandedIdOptions<Name extends string> {
    /**
     * The brand name for the ID type.
     * This becomes the TypeScript brand and appears in error messages.
     * @example "UserId", "OrderId", "SessionId"
     */
    readonly brand: SingleBrandName<Name>;
}

// ---------------------------------------------------------------------------
// Error Types
// ---------------------------------------------------------------------------

/**
 * Error thrown when a branded ID fails validation
 */
export class BrandedIdError extends Schema.TaggedError<BrandedIdError, { readonly brand: unique symbol }>()(
    'BrandedIdError',
    {
        input: Schema.String,
        message: Schema.String,
    },
) {}

// ---------------------------------------------------------------------------
// Schema Factory
// ---------------------------------------------------------------------------

/** Build the branded schema plus static helpers for one (prefix, brand) pair. */
const makeBrandedIdSchema = <const Name extends string>(prefix: string, brand: SingleBrandName<Name>) => {
    // Validation function that checks both prefix and CUID
    const isValid = (input: string): boolean => parseId(input, prefix) !== null;

    // Create error message based on input
    const getErrorMessage = (input: string): string => {
        const separatorIndex = Str.lastIndexOf('_')(input);

        if (Option.isNone(separatorIndex)) {
            return `Invalid ${brand}: missing prefix, expected format "${prefix}_<cuid2>"`;
        }

        const actualPrefix = Str.slice(0, separatorIndex.value)(input);

        if (actualPrefix !== prefix) {
            return `Invalid ${brand}: expected prefix "${prefix}_", got "${actualPrefix}_"`;
        }

        return `Invalid ${brand}: invalid CUID2 suffix`;
    };

    // Create a filter using Effect 4.x API: Schema.makeFilter
    const idFilter = Schema.makeFilter<string>((input) => (isValid(input) ? undefined : getErrorMessage(input)), {
        identifier: brand,
    });

    // String -> check with filter -> brand
    const base = Schema.String.check(idFilter).pipe(Schema.brand<Name>(brand));

    // The schema's own branded Type. For any concrete brand this is exactly `BrandedId<Name>`;
    // annotating against the schema type keeps `create`/`is` provable without assertions.
    type Id = (typeof base)['Type'];

    return Object.assign(base, {
        brand,
        prefix,
        create: (): Id => base.make(`${prefix}_${createId()}`),
        is: (input: string): input is Id => isValid(input),
    });
};

/**
 * The schema type produced by {@link makeBrandedId}: the branded string schema plus static helpers.
 */
export type BrandedIdSchema<Name extends string> = ReturnType<typeof makeBrandedIdSchema<Name>>;

/**
 * Creates a branded ID schema with a custom prefix and CUID2 suffix.
 *
 * The generated IDs follow the format: `{prefix}_{cuid2}`
 *
 * @example
 * ```ts
 * // Create a schema for user IDs
 * const UserId = makeBrandedId("usr", { brand: "UserId" })
 * type UserId = BrandedIdOf<typeof UserId>
 *
 * // Generate a new ID
 * const id = UserId.create() // "usr_ckopqwo2c0000ql08smxycfk"
 *
 * // Validate external input
 * const parsed = Schema.decodeUnknownSync(UserId)("usr_ckopqwo2c0000ql08smxycfk")
 *
 * // Type safety: UserId cannot be used where OrderId is expected
 * const OrderId = makeBrandedId("ord", { brand: "OrderId" })
 * type OrderId = BrandedIdOf<typeof OrderId>
 *
 * function getUser(id: UserId) { ... }
 * getUser(OrderId.create()) // Type error!
 * ```
 *
 * @param prefix - The prefix for generated IDs (e.g., "usr", "ord", "ses")
 * @param options - The brand name for the ID type
 * @returns A branded ID schema with create/make/is methods
 */
export const makeBrandedId = <const Name extends string>(
    prefix: string,
    options: BrandedIdOptions<Name>,
): BrandedIdSchema<Name> => {
    // Validate prefix at schema creation time
    if (!isValidPrefix(prefix)) {
        throw new Error(
            `Invalid prefix "${prefix}": must be 1-63 lowercase letters/underscores, starting with a letter`,
        );
    }

    return makeBrandedIdSchema<Name>(prefix, options.brand);
};

// ---------------------------------------------------------------------------
// Re-exports for convenience
// ---------------------------------------------------------------------------

export { isCuid, createId } from '@paralleldrive/cuid2';
