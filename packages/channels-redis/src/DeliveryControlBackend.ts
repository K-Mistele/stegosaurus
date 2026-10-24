/**
 * This file defines the store half of delivery control over Redis.
 *
 * The token check and the change are decided together, through the shared `DeliveryLifecycle` rules,
 * on one read of the mailbox, and written only if the mailbox has not changed since: the delivery
 * cannot change between the check and the write. A result, a link, a message, or an activity saves
 * its output operation in the same write and moves the mailbox's due time, so the next poll sends it.
 * No provider is called here.
 *
 * The delivery ID names the mailbox, so a request goes straight to its keys with no lookup.
 */
import { applyDeliverySlotMutation, readDeliverySlotStatus } from '@stegosaurus/channels-delivery/DeliveryLifecycle';
import {
    DeliveryControlBackend,
    DeliveryControlUnavailable,
    DeliveryNotFound,
    type ApplyDeliveryMutation,
    type ReadDeliveryStatus,
} from '@stegosaurus/channels-delivery/DeliveryControl';
import { Clock, Effect, Layer, Option } from 'effect';
import * as Redis from 'effect/persistence/Redis';

import { changeDeliverySlot, loadDeliverySlot, type NarrowRedisFailure } from './DeliverySlot';

/** Log a Redis, codec, or contention failure where it happens, then narrow it to `DeliveryControlUnavailable`. */
const narrowRedisFailure: NarrowRedisFailure<DeliveryControlUnavailable> = (reason) => (error) =>
    Effect.logError('Redis delivery control failed', error).pipe(
        Effect.andThen(Effect.fail(DeliveryControlUnavailable.make({ reason }))),
    );

/** Read what a remote worker may see. The read is one script, so it sees one moment of the mailbox. */
const readDeliveryStatus = Effect.fn('delivery.redis.read_delivery_status')(function* (input: ReadDeliveryStatus) {
    const now = yield* Clock.currentTimeMillis;

    const loaded = yield* loadDeliverySlot({ mailboxKey: input.reference.mailboxKey }).pipe(
        Effect.catchTags({
            RedisError: narrowRedisFailure('redis_unavailable'),
            SchemaError: narrowRedisFailure('redis_codec_unavailable'),
        }),
    );

    if (Option.isNone(loaded)) return yield* DeliveryNotFound.make();

    return yield* readDeliverySlotStatus(loaded.value.slot, { ...input, now });
});

/** Check the token and apply the change, with the output it needs, in one write. */
const applyDeliveryMutation = Effect.fn('delivery.redis.apply_delivery_mutation')(function* (
    input: ApplyDeliveryMutation,
) {
    const now = yield* Clock.currentTimeMillis;

    return yield* changeDeliverySlot({
        mailboxKey: input.reference.mailboxKey,
        onMissing: Effect.fail(DeliveryNotFound.make()),
        change: (loaded) =>
            applyDeliverySlotMutation(loaded.slot, { ...input, now, hasWaiting: loaded.hasWaiting }).pipe(
                Effect.map(({ slot, receipt }) => ({ slot, value: receipt })),
            ),
        narrowRedisFailure,
    });
});

/** Delivery control over the application's `Redis` client. */
export const DeliveryControlBackendRedis = Layer.effect(
    DeliveryControlBackend,
    Effect.gen(function* () {
        const services = yield* Effect.context<Redis.Redis>();

        return DeliveryControlBackend.of({
            readDeliveryStatus: (input) => readDeliveryStatus(input).pipe(Effect.provide(services)),
            applyDeliveryMutation: (input) => applyDeliveryMutation(input).pipe(Effect.provide(services)),
        });
    }),
);
