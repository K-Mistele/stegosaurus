import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import { describe, it, layer } from '@effect/vitest';
import { Context, Deferred, Effect, Layer, Queue, Ref } from 'effect';
import { HttpRouter } from 'effect/http';
import { TestClock } from 'effect/testing';

import { ProviderWebhookEvent } from '../src/ProviderWebhooks';
import { ProviderEventHandled, type DeliveryAdmissionBatch } from '../src/ProviderEventProcessing';
import { QueueDeliveryMode } from '../src/MailboxPolicy';
import { DeliveryAdmission, MailboxDelivery } from '../src/MailboxDelivery';
import { type ChannelsProvider } from '../src/ChannelsProvider';
import * as Channels from '../src/Channels';
import * as ChannelsMemory from '../src/ChannelsMemory';

/** A provider that accepts any webhook as one event and hands each batch to `onBatch`. */
const makeExampleProvider = (
    onBatch: (input: {
        readonly namespace: string;
        readonly admissions: DeliveryAdmissionBatch;
    }) => Effect.Effect<unknown>,
): ChannelsProvider => ({
    providerName: 'example',
    deliveryMode: QueueDeliveryMode.make({}),
    webhookProvider: ({ namespace }) =>
        Effect.succeed({
            providerName: 'example',
            handle: () =>
                Effect.succeed(
                    ProviderWebhookEvent.make({
                        event: DeliveryAdmission.make({
                            namespace,
                            provider: 'example',
                            installationId: 'installation',
                            resourceId: 'resource',
                            eventId: 'event',
                            payload: { type: 'example' },
                        }),
                    }),
                ),
        }),
    eventProcessor: ({ namespace }) =>
        Effect.succeed({
            namespace,
            providerName: 'example',
            process: (admissions: DeliveryAdmissionBatch) =>
                onBatch({ namespace, admissions }).pipe(Effect.as(ProviderEventHandled.make({}))),
        }),
});

const eventProcessing = { concurrency: 1, leaseMs: 30_000 };

const post = (path: string) => new Request(`http://localhost${path}`, { method: 'POST' });

describe('Channels.make', () => {
    it.live('routes carry a webhook through storage to the provider callback, under the base path', ({ expect }) =>
        Effect.gen(function* () {
            const batches = yield* Queue.unbounded<{
                readonly namespace: string;
                readonly events: number;
            }>();

            const bot = Channels.make({
                namespace: 'channels-test',
                basePath: '/api/channels',
                providers: [
                    makeExampleProvider(({ namespace, admissions }) =>
                        Queue.offer(batches, { namespace, events: admissions.length }),
                    ),
                ],
                eventProcessing,
                storage: ChannelsMemory.make({ polling: { intervalMs: 10 } }),
            });

            const web = HttpRouter.toWebHandler(bot.routes.pipe(Layer.provide(NodeCrypto.layer)), {
                disableLogger: true,
            });

            yield* Effect.addFinalizer(() => Effect.promise(web.dispose));

            const unprefixed = yield* Effect.promise(() => web.handler(post('/integrations/example/webhook')));

            const accepted = yield* Effect.promise(() =>
                web.handler(post('/api/channels/integrations/example/webhook')),
            );

            expect(unprefixed.status).toBe(404);
            expect(accepted.status).toBe(200);
            expect(yield* Queue.take(batches)).toEqual({ namespace: 'channels-test', events: 1 });
        }),
    );

    it.effect('layer alone works through mailboxes with no HTTP', ({ expect }) =>
        Effect.gen(function* () {
            const ran = yield* Deferred.make<number>();

            const bot = Channels.make({
                namespace: 'channels-test',
                providers: [makeExampleProvider(({ admissions }) => Deferred.succeed(ran, admissions.length))],
                eventProcessing,
                storage: ChannelsMemory.make({ polling: { intervalMs: 1_000 } }),
            });

            const services = yield* Layer.build(bot.layer.pipe(Layer.provide(NodeCrypto.layer)));
            const delivery = Context.get(services, MailboxDelivery);
            yield* delivery.deliver(
                DeliveryAdmission.make({
                    namespace: 'channels-test',
                    provider: 'example',
                    installationId: 'installation',
                    resourceId: 'resource',
                    eventId: 'event',
                    payload: null,
                }),
            );
            yield* TestClock.adjust(1_000);

            expect(yield* Deferred.await(ran)).toBe(1);
        }),
    );

    layer(NodeCrypto.layer)((it) => {
        it.effect('a program that uses routes and layer builds storage and the event processors once', ({ expect }) =>
            Effect.gen(function* () {
                const storageBuilds = yield* Ref.make(0);
                const processorBuilds = yield* Ref.make(0);
                const memory = ChannelsMemory.make({ polling: { intervalMs: 1_000 } });
                const provider = makeExampleProvider(() => Effect.void);

                const countedProvider: ChannelsProvider = {
                    ...provider,
                    eventProcessor: (input) =>
                        Ref.update(processorBuilds, (n) => n + 1).pipe(Effect.andThen(provider.eventProcessor(input))),
                };

                const bot = Channels.make({
                    namespace: 'channels-test',
                    providers: [countedProvider],
                    eventProcessing,
                    storage: {
                        polling: memory.polling,
                        layer: Layer.merge(memory.layer, Layer.effectDiscard(Ref.update(storageBuilds, (n) => n + 1))),
                    },
                });

                const app = yield* HttpRouter.toHttpEffect(Layer.merge(bot.routes, bot.layer));

                expect(Effect.isEffect(app)).toBe(true);

                expect(yield* Ref.get(storageBuilds)).toBe(1);
                expect(yield* Ref.get(processorBuilds)).toBe(1);
            }),
        );
    });

    it.live('start serves plain requests and polls without an Effect program', ({ expect }) =>
        Effect.gen(function* () {
            const ran = yield* Deferred.make<number>();

            const bot = Channels.make({
                namespace: 'channels-test',
                providers: [makeExampleProvider(({ admissions }) => Deferred.succeed(ran, admissions.length))],
                eventProcessing,
                storage: ChannelsMemory.make({ polling: { intervalMs: 10 } }),
            });

            const started = yield* Effect.promise(() => bot.start(NodeCrypto.layer));
            yield* Effect.addFinalizer(() => Effect.promise(started.stop));

            const response = yield* Effect.promise(() => started.handle(post('/integrations/example/webhook')));

            expect(response.status).toBe(200);
            expect(yield* Deferred.await(ran)).toBe(1);
        }),
    );
});
