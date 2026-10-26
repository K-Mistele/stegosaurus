/**
 * This file defines the identities of a delivery: the permanent batch ID, the public delivery ID,
 * the conversation ID, and the access token a remote worker presents.
 *
 * A batch ID names one frozen batch for good. A claim ID only names one attempt at it, and changes
 * on every retry or recovery. The public delivery ID carries the mailbox key and the batch ID, so a
 * host can route a request to the owning mailbox without a lookup table.
 */
import { Array as Arr, Crypto, Effect, Option, Result, Schema, String as Str } from 'effect';
import { Base64Url } from 'effect/encoding';

/** The longest public delivery ID, so it fits in a request path on every host. */
export const DELIVERY_ID_MAX_LENGTH = 2_048;

/** The longest mailbox key, once base64url-encoded, that still leaves room in a delivery ID. */
export const ENCODED_MAILBOX_KEY_MAX_LENGTH = 1_500;

const UrlSafe = /^[A-Za-z0-9_-]+$/;

/** The permanent identity of one frozen batch. Kept across every retry and recovery. */
export const BatchId = Schema.NonEmptyString.check(Schema.isMaxLength(64), Schema.isPattern(UrlSafe)).pipe(
    Schema.brand('BatchId'),
);

export type BatchId = typeof BatchId.Type;

/** The public identity of one callback step: `delivery:v2:<base64url mailbox key>:<batch ID>:<callback index>`. */
export const DeliveryId = Schema.NonEmptyString.check(
    Schema.isMaxLength(DELIVERY_ID_MAX_LENGTH),
    Schema.isPattern(/^delivery:v2:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:(0|[1-9][0-9]*)$/),
).pipe(Schema.brand('DeliveryId'));

export type DeliveryId = typeof DeliveryId.Type;

/**
 * The stable identity of the conversation a delivery belongs to: a Slack thread, a GitHub issue or
 * pull request, a Linear issue, or a Linear agent session. Each delivery is one turn in it.
 */
export const ConversationId = Schema.NonEmptyString.check(Schema.isPattern(/^conversation:v1:[A-Za-z0-9_-]+$/)).pipe(
    Schema.brand('ConversationId'),
);

export type ConversationId = typeof ConversationId.Type;

/**
 * The bearer token a remote worker presents for one delivery. It is random, saved with the batch,
 * and never logged or returned by status.
 */
export const DeliveryAccessToken = Schema.NonEmptyString.check(Schema.isPattern(UrlSafe));

export type DeliveryAccessToken = typeof DeliveryAccessToken.Type;

/** A delivery ID taken apart into the parts a host routes on. */
export const DeliveryReference = Schema.Struct({
    deliveryId: DeliveryId,
    mailboxKey: Schema.NonEmptyString,
    batchId: BatchId,
    callbackIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export type DeliveryReference = typeof DeliveryReference.Type;

/** Whether a mailbox key is short enough for its delivery IDs to fit in a request path. */
export const isRoutableMailboxKey = (mailboxKey: string) =>
    Base64Url.encode(mailboxKey).length <= ENCODED_MAILBOX_KEY_MAX_LENGTH;

/** The delivery ID of a batch. The mailbox key must be routable; see {@link isRoutableMailboxKey}. */
export const formatDeliveryId = (input: {
    readonly mailboxKey: string;
    readonly batchId: BatchId;
    readonly callbackIndex?: number;
}) => {
    const callbackIndex = DeliveryReference.fields.callbackIndex.make(input.callbackIndex ?? 0);

    return DeliveryId.make(`delivery:v2:${Base64Url.encode(input.mailboxKey)}:${input.batchId}:${callbackIndex}`);
};

/** The conversation ID of a mailbox. */
export const mailboxConversationId = (mailboxKey: string) =>
    ConversationId.make(`conversation:v1:${Base64Url.encode(mailboxKey)}`);

/**
 * Take a delivery ID apart. Returns none for anything that is not a canonical v2 delivery ID,
 * so a caller can answer "not found" without saying why.
 */
export const parseDeliveryId = (input: string): Option.Option<DeliveryReference> => {
    const deliveryId = Schema.decodeOption(DeliveryId)(input);

    if (Option.isNone(deliveryId)) return Option.none();
    const [, , encodedKey, rawBatchId, rawIndex] = Str.split(':')(deliveryId.value);
    const mailboxKey = Result.getOrUndefined(Base64Url.decodeString(encodedKey ?? ''));
    const batchId = Schema.decodeOption(BatchId)(rawBatchId);

    const callbackIndex = Schema.decodeOption(DeliveryReference.fields.callbackIndex)(Number(rawIndex));

    if (Option.isNone(callbackIndex)) return Option.none();

    if (mailboxKey === undefined || mailboxKey === '' || Option.isNone(batchId)) return Option.none();

    if (
        formatDeliveryId({ mailboxKey, batchId: batchId.value, callbackIndex: callbackIndex.value }) !==
        deliveryId.value
    )
        return Option.none();

    return Option.some(
        DeliveryReference.make({
            deliveryId: deliveryId.value,
            mailboxKey,
            batchId: batchId.value,
            callbackIndex: callbackIndex.value,
        }),
    );
};

/** A new batch ID. */
export const randomBatchId = Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;

    return BatchId.make(Base64Url.encode(yield* crypto.randomBytes(16)));
});

/** A new access token from a `Crypto` the caller already holds: 32 random bytes. */
export const randomDeliveryAccessTokenWith = (crypto: Crypto.Crypto) =>
    Effect.map(crypto.randomBytes(32), (bytes) => DeliveryAccessToken.make(Base64Url.encode(bytes)));

/** A new access token: 32 random bytes. */
export const randomDeliveryAccessToken = Effect.gen(function* () {
    return yield* randomDeliveryAccessTokenWith(yield* Crypto.Crypto);
});

/**
 * A UUID made from a delivery ID: the same on every attempt at the delivery, and different for every
 * delivery. It has the UUID v4 layout, because providers that take a client-chosen ID, such as Linear,
 * ask for one. A provider sends it with output it makes before the callback runs, so a retry cannot
 * make that output twice.
 */
export const deliveryIdempotencyKey = Effect.fn('delivery.make_idempotency_key')(function* (deliveryId: DeliveryId) {
    const crypto = yield* Crypto.Crypto;

    const digest = yield* crypto.digest('SHA-256', new TextEncoder().encode(`delivery-idempotency:v1:${deliveryId}`));

    /** The first sixteen bytes as a UUID v4 string: set the version and variant bits, then format them. */
    const hexByte = (byte: number) => Str.padStart(2, '0')(byte.toString(16));

    const hex = Arr.join(
        Array.from(digest.subarray(0, 16), (byte, index) => {
            if (index === 6) return hexByte((byte & 0x0f) | 0x40);

            if (index === 8) return hexByte((byte & 0x3f) | 0x80);

            return hexByte(byte);
        }),
        '',
    );

    return `${Str.slice(0, 8)(hex)}-${Str.slice(8, 12)(hex)}-${Str.slice(12, 16)(hex)}-${Str.slice(16, 20)(hex)}-${Str.slice(20, 32)(hex)}`;
});

/**
 * Compare a presented token with the saved one. Takes the same time for any presented token of the
 * saved token's length, so the comparison does not reveal how much of a guess was right.
 */
export const deliveryAccessTokenMatches = (input: { readonly saved: string; readonly presented: string }) => {
    const encoder = new TextEncoder();
    const saved = encoder.encode(input.saved);
    const presented = encoder.encode(input.presented);

    if (saved.length !== presented.length) return false;
    let difference = 0;

    for (let index = 0; index < saved.length; index += 1) {
        difference |= (saved[index] ?? 0) ^ (presented[index] ?? 0);
    }

    return difference === 0;
};
