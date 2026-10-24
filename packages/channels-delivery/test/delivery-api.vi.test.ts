/**
 * The delivery API end to end: a signed-in-by-token remote worker finishes a handed-off delivery
 * through `Channels.make`'s own routes, with in-memory storage and a real router. The provider's
 * output processor records what it is asked to send.
 */
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import { assert, describe, it } from '@effect/vitest';
import { Array as Arr, Clock, Context, Effect, Layer, Option, Queue, Redacted, Ref, Schedule, Schema } from 'effect';
import { FetchHttpClient, HttpClient } from 'effect/http';

import { ProviderWebhookEvent } from '../src/ProviderWebhooks';
import {
    DeliveryOutputApplied,
    DeliveryOutputFailed,
    ProviderPresentOutcome,
    type ProviderOutputAttempt,
} from '../src/ProviderOutput';
import { ProviderEventHandled } from '../src/ProviderEventProcessing';
import { QueueDeliveryMode } from '../src/MailboxPolicy';
import { DeliveryAdmission } from '../src/MailboxDelivery';
import { DeliveryReactionTarget, ProviderReactionTarget, ProviderSetMessageReaction } from '../src/DeliveryReaction';
import {
    DeliveryPlan,
    DeliveryPlanItem,
    DeliveryPlanItemId,
    DeliveryPlanItemState,
    DeliveryPlanRevision,
    ProviderRenderPlan,
    RenderedDeliveryPlan,
} from '../src/DeliveryPlan';
import { CreateMessage, MessageId, ProviderDeleteMessage, ProviderUpdateMessage } from '../src/DeliveryMessage';
import { type DeliveryClient, type DeliveryClientTarget } from '../src/DeliveryHttpClient';
import * as DeliveryHttpClient from '../src/DeliveryHttpClient';
import { PreparedDeliveryInvocation, type DeliveryContext, type DeliveryOperationKind } from '../src/DeliveryContext';
import { DeliveryActivity, SetActivity } from '../src/DeliveryActivity';
import { DeliveryOutcome } from '../src/DeliveryOutcome';
import { AddExternalLink, ExternalLink } from '../src/DeliveryLink';
import { DeliveryOperationUnsupported, DeliveryReactionTargetUnavailable } from '../src/DeliveryControl';
import { type ChannelsProvider } from '../src/ChannelsProvider';
import * as Channels from '../src/Channels';
import * as ChannelsMemory from '../src/ChannelsMemory';

const basePath = '/api/channels';

const JsonText = Schema.fromJsonString(Schema.Json);

/** A JSON request body, as a remote worker sends it. */
const jsonText = Schema.encodeEffect(JsonText);

/** A JSON value parsed from text, for bodies no schema here can make. */
const jsonValue = Schema.decodeEffect(JsonText);

const startBotWith = (
    supportedOperations: ReadonlyArray<DeliveryOperationKind>,
    /** What the test provider saves for reactions: what started the delivery, and what reactions can go on. */
    reactions: Pick<PreparedDeliveryInvocation['callbacks'][0], 'activationTarget' | 'reactionTargets'> = {},
) =>
    Effect.gen(function* () {
        const contexts = yield* Queue.unbounded<DeliveryContext>();
        const output = yield* Queue.unbounded<ProviderOutputAttempt>();
        const outputFailuresLeft = yield* Ref.make(0);

        /**
         * Accepts any webhook as one event, named by its `x-event-id` header. Every batch hands itself off.
         * Its output processor records each attempt, and fails the first `outputFailuresLeft` of them.
         */
        const provider: ChannelsProvider = {
            providerName: 'example',
            deliveryMode: QueueDeliveryMode.make({}),
            webhookProvider: ({ namespace }) =>
                Effect.succeed({
                    providerName: 'example',
                    handle: ({ headers }) =>
                        Effect.succeed(
                            ProviderWebhookEvent.make({
                                event: DeliveryAdmission.make({
                                    namespace,
                                    provider: 'example',
                                    installationId: 'installation',
                                    resourceId: 'resource',
                                    eventId: headers['x-event-id'] ?? 'event',
                                    payload: null,
                                }),
                            }),
                        ),
                }),
            eventProcessor: ({ namespace }) =>
                Effect.succeed({
                    namespace,
                    providerName: 'example',
                    process: (_admissions, execution) =>
                        Effect.gen(function* () {
                            if (Option.isNone(execution.prepared)) {
                                yield* execution.prepare(
                                    PreparedDeliveryInvocation.make({
                                        callbacks: [
                                            {
                                                name: 'onEvent',
                                                presentationVersion: 1,
                                                destination: { resource: 'resource' },
                                                supportedOperations,
                                                ...reactions,
                                            },
                                        ],
                                    }),
                                );
                            }

                            yield* Queue.offer(contexts, execution.context);
                            yield* execution.context.handoff();

                            return ProviderEventHandled.make({});
                        }).pipe(Effect.orDie),
                }),
            outputProcessor: ({ namespace }) =>
                Effect.succeed({
                    namespace,
                    providerName: 'example',
                    process: (attempt) =>
                        Effect.gen(function* () {
                            yield* Queue.offer(output, attempt);

                            const failing = yield* Ref.modify(outputFailuresLeft, (left) => [
                                left > 0,
                                Math.max(0, left - 1),
                            ]);

                            if (failing) {
                                return yield* DeliveryOutputFailed.make({
                                    provider: 'example',
                                    retryable: true,
                                    safeCode: 'example_unavailable',
                                    retryAfterMs: 0,
                                });
                            }

                            return DeliveryOutputApplied.make({ receipt: { sent: attempt.operationId } });
                        }),
                }),
        };

        const bot = Channels.make({
            namespace: 'channels-test',
            basePath,
            providers: [provider],
            eventProcessing: { concurrency: 1, leaseMs: 30_000 },
            storage: ChannelsMemory.make({ polling: { intervalMs: 10 } }),
        });

        const started = yield* Effect.promise(() => bot.start(NodeCrypto.layer, bot.deliveryApi));
        yield* Effect.addFinalizer(() => Effect.promise(started.stop));

        const webhook = (eventId: string) =>
            Effect.promise(() =>
                started.handle(
                    new Request(`http://localhost${basePath}/integrations/example/webhook`, {
                        method: 'POST',
                        headers: { 'x-event-id': eventId },
                    }),
                ),
            );

        /** The generated client, sending its requests straight to the bot's handler. */
        const httpClient = Context.get(
            yield* Layer.build(
                FetchHttpClient.layer.pipe(
                    Layer.provide(
                        Layer.succeed(FetchHttpClient.Fetch, (input, init) => started.handle(new Request(input, init))),
                    ),
                ),
            ),
            HttpClient.HttpClient,
        );

        const client = yield* DeliveryHttpClient.make({ baseUrl: 'http://localhost', basePath }).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
        );

        const raw = (path: string, init: RequestInit = {}) =>
            Effect.promise(() => started.handle(new Request(`http://localhost${basePath}${path}`, init)));

        return { contexts, output, outputFailuresLeft, webhook, client, raw };
    });

const startBot = startBotWith(['PresentOutcome', 'AddExternalLink', 'CreateMessage']);

/** Read the delivery's status until it retires. */
const awaitRetired = (client: DeliveryClient, target: DeliveryClientTarget) =>
    client.status(target).pipe(
        Effect.repeat({
            until: ({ stage }) => stage === 'Retired',
            schedule: Schedule.spaced('10 millis'),
        }),
    );

describe('delivery API', () => {
    it.live(
        'a remote worker finishes a handed-off delivery, and the next event waits until its output is sent',
        ({ expect }) =>
            Effect.gen(function* () {
                const { contexts, output, webhook, client } = yield* startBot;
                expect((yield* webhook('first')).status).toBe(200);
                const first = yield* Queue.take(contexts);
                expect(first.deliveryId.length).toBeGreaterThan(100);

                yield* webhook('second');
                yield* Effect.sleep('150 millis');
                expect(yield* Queue.size(contexts)).toBe(0);

                const delivery = { deliveryId: first.deliveryId, accessToken: first.accessToken };
                const waiting = yield* client.status(delivery);
                expect(waiting.stage).toBe('ExternalWaiting');
                expect(waiting.supportedOperations).toEqual(['PresentOutcome', 'AddExternalLink', 'CreateMessage']);
                expect(waiting.interruptRequested).toBe(false);

                expect((yield* client.complete({ ...delivery, payload: { markdown: 'done' } })).status).toBe(
                    'accepted',
                );
                expect((yield* client.complete({ ...delivery, payload: { markdown: 'done' } })).status).toBe(
                    'already_recorded',
                );
                expect((yield* client.fail(delivery).pipe(Effect.flip))._tag).toBe('DeliveryTerminalConflict');
                const presented = yield* Queue.take(output);
                expect(presented.deliveryId).toBe(first.deliveryId);
                expect(presented.operation).toEqual(
                    ProviderPresentOutcome.make({
                        outcome: DeliveryOutcome.cases.Completed.make({}),
                        markdown: 'done',
                        clearActivity: false,
                    }),
                );
                expect(presented.prepared.destination).toEqual({ resource: 'resource' });
                const retired = yield* awaitRetired(client, delivery);
                expect(retired.outcome?._tag).toBe('Completed');
                expect(retired.output).toEqual([
                    {
                        operationId: 'outcome',
                        kind: 'PresentOutcome',
                        state: 'Delivered',
                        attempts: 1,
                        hadAmbiguousAttempt: false,
                    },
                ]);

                const second = yield* Queue.take(contexts);
                expect(second.deliveryId === first.deliveryId).toBe(false);
                expect(second.conversationId).toBe(first.conversationId);
            }),
    );

    it.live('answers 401 without a token and 404 for a wrong token or an unknown delivery', ({ expect }) =>
        Effect.gen(function* () {
            const { contexts, webhook, client, raw } = yield* startBot;
            yield* webhook('first');
            const context = yield* Queue.take(contexts);
            const path = `/deliveries/${encodeURIComponent(context.deliveryId)}`;

            expect((yield* raw(path)).status).toBe(401);
            expect(
                (yield* raw(`${path}/complete`, {
                    method: 'POST',
                    body: '{}',
                    headers: { 'content-type': 'application/json' },
                })).status,
            ).toBe(401);
            const wrongToken = { headers: { authorization: 'Bearer wrong-token' } };
            expect((yield* raw(path, wrongToken)).status).toBe(404);
            expect((yield* raw('/deliveries/not-a-delivery', wrongToken)).status).toBe(404);

            const wrong = { deliveryId: context.deliveryId, accessToken: Redacted.make('wrong-token') };
            expect((yield* client.complete(wrong).pipe(Effect.flip))._tag).toBe('DeliveryNotFound');
            const right = { deliveryId: context.deliveryId, accessToken: context.accessToken };
            expect((yield* client.status(right)).stage).toBe('ExternalWaiting');
        }),
    );
});

describe('delivery API output', () => {
    it.live('retries failed output on its own, without running the callback again', ({ expect }) =>
        Effect.gen(function* () {
            const { contexts, output, outputFailuresLeft, webhook, client } = yield* startBot;
            yield* webhook('first');
            const context = yield* Queue.take(contexts);
            const delivery = { deliveryId: context.deliveryId, accessToken: context.accessToken };
            yield* Ref.set(outputFailuresLeft, 2);

            expect((yield* client.fail({ ...delivery, payload: { markdown: 'stopped' } })).status).toBe('accepted');

            const attempts = [yield* Queue.take(output), yield* Queue.take(output), yield* Queue.take(output)];

            expect(Arr.map(attempts, ({ operationId, attempt }) => [operationId, attempt])).toEqual([
                ['outcome', 1],
                ['outcome', 2],
                ['outcome', 3],
            ]);
            const retired = yield* awaitRetired(client, delivery);
            expect(retired.outcome?._tag).toBe('Failed');
            expect(retired.output).toEqual([
                {
                    operationId: 'outcome',
                    kind: 'PresentOutcome',
                    state: 'Delivered',
                    attempts: 3,
                    hadAmbiguousAttempt: false,
                },
            ]);
            expect(yield* Queue.size(contexts)).toBe(0);
        }),
    );

    it.live('adds links: https only, a repeated URL is a replay, and each new one is sent once', ({ expect }) =>
        Effect.gen(function* () {
            const { contexts, output, webhook, client, raw } = yield* startBot;
            yield* webhook('first');
            const context = yield* Queue.take(contexts);
            const delivery = { deliveryId: context.deliveryId, accessToken: context.accessToken };
            const pullRequest = { label: 'Pull request', url: 'https://github.com/org/repo/pull/1' };

            expect((yield* client.addLink({ ...delivery, link: pullRequest })).status).toBe('accepted');
            expect((yield* client.addLink({ ...delivery, link: { ...pullRequest, label: 'PR' } })).status).toBe(
                'already_recorded',
            );
            const sent = yield* Queue.take(output);
            expect(sent.operation).toEqual(AddExternalLink.make({ link: ExternalLink.make(pullRequest) }));

            const plainHttp = yield* raw(`/deliveries/${encodeURIComponent(context.deliveryId)}/links`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${Redacted.value(context.accessToken)}`,
                },
                body: yield* jsonText({ label: 'Run', url: 'http://example.com/run' }),
            });

            expect(plainHttp.status).toBe(400);

            yield* client.complete(delivery);
            yield* awaitRetired(client, delivery);
            const late = { label: 'Late', url: 'https://example.com/late' };
            expect((yield* client.addLink({ ...delivery, link: late }).pipe(Effect.flip))._tag).toBe('DeliveryClosed');
            expect((yield* client.addLink({ ...delivery, link: pullRequest })).status).toBe('already_recorded');
        }),
    );
});

describe('delivery API messages', () => {
    it.live('creates, updates, and deletes a message through the generated client, in order', ({ expect }) =>
        Effect.gen(function* () {
            const { contexts, output, webhook, client } = yield* startBotWith([
                'PresentOutcome',
                'CreateMessage',
                'UpdateMessage',
                'DeleteMessage',
            ]);

            yield* webhook('first');
            const context = yield* Queue.take(contexts);
            const delivery = { deliveryId: context.deliveryId, accessToken: context.accessToken };
            const messageId = MessageId.make('progress');

            const created = yield* client.messages.create({
                ...delivery,
                message: { messageId, markdown: 'Working' },
            });

            expect(created.status).toBe('accepted');

            const replayed = yield* client.messages.create({
                ...delivery,
                message: { messageId, markdown: 'Working' },
            });

            expect(replayed.status).toBe('already_recorded');

            const reused = yield* client.messages
                .create({ ...delivery, message: { messageId, markdown: 'Other' } })
                .pipe(Effect.flip);

            expect(reused._tag).toBe('DeliveryMessageConflict');
            yield* client.messages.update({ ...delivery, messageId, message: { markdown: 'Almost' } });
            yield* client.messages.delete({ ...delivery, messageId });

            const unknown = yield* client.messages
                .update({ ...delivery, messageId: MessageId.make('unknown'), message: { markdown: 'x' } })
                .pipe(Effect.flip);

            expect(unknown._tag).toBe('DeliveryMessageNotFound');

            const sent = [yield* Queue.take(output), yield* Queue.take(output), yield* Queue.take(output)];

            expect(Arr.map(sent, ({ operation }) => operation)).toEqual([
                CreateMessage.make({ messageId, markdown: 'Working' }),
                ProviderUpdateMessage.make({
                    messageId,
                    markdown: 'Almost',
                    reference: { sent: 'message-1' },
                }),
                ProviderDeleteMessage.make({ messageId, reference: { sent: 'message-1' } }),
            ]);
            const status = yield* client.status(delivery);
            expect(Arr.map(status.output, ({ kind, messageId, state }) => [kind, messageId, state])).toEqual([
                ['CreateMessage', 'progress', 'Delivered'],
                ['UpdateMessage', 'progress', 'Delivered'],
                ['DeleteMessage', 'progress', 'Delivered'],
            ]);

            yield* client.complete(delivery);
            yield* awaitRetired(client, delivery);

            const late = yield* client.messages
                .create({ ...delivery, message: { messageId: MessageId.make('late'), markdown: 'x' } })
                .pipe(Effect.flip);

            expect(late._tag).toBe('DeliveryClosed');
        }),
    );

    it.live('answers 409 for an operation the destination cannot do, and 400 for a bad message ID', ({ expect }) =>
        Effect.gen(function* () {
            const { contexts, webhook, client, raw } = yield* startBot;
            yield* webhook('first');
            const context = yield* Queue.take(contexts);
            const delivery = { deliveryId: context.deliveryId, accessToken: context.accessToken };
            const messageId = MessageId.make('progress');
            yield* client.messages.create({ ...delivery, message: { messageId, markdown: 'Working' } });

            const refused = yield* client.messages
                .update({ ...delivery, messageId, message: { markdown: 'Almost' } })
                .pipe(Effect.flip);

            expect(refused).toEqual(DeliveryOperationUnsupported.make({ operation: 'UpdateMessage' }));
            const messages = `/deliveries/${encodeURIComponent(context.deliveryId)}/messages`;
            const authorization = `Bearer ${Redacted.value(context.accessToken)}`;

            const deleted = yield* raw(`${messages}/progress`, {
                method: 'DELETE',
                headers: { authorization },
            });

            expect(deleted.status).toBe(409);

            const badId = yield* raw(messages, {
                method: 'POST',
                headers: { authorization, 'content-type': 'application/json' },
                body: yield* jsonText({ messageId: 'has spaces', markdown: 'x' }),
            });

            expect(badId.status).toBe(400);

            const empty = yield* raw(messages, {
                method: 'POST',
                headers: { authorization, 'content-type': 'application/json' },
                body: yield* jsonText({ messageId: 'other', markdown: '' }),
            });

            expect(empty.status).toBe(400);
            expect(Arr.map((yield* client.status(delivery)).output, ({ kind }) => kind)).toEqual(['CreateMessage']);
        }),
    );
});

describe('delivery API activity and supported operations', () => {
    it.live('sets activity through the generated client, keeps only the latest, and a result clears it', ({ expect }) =>
        Effect.gen(function* () {
            const { contexts, output, webhook, client } = yield* startBotWith(['PresentOutcome', 'SetActivity']);

            yield* webhook('first');
            const context = yield* Queue.take(contexts);
            const delivery = { deliveryId: context.deliveryId, accessToken: context.accessToken };
            const working = DeliveryActivity.cases.Working.make({ message: 'Running tests' });

            expect((yield* client.activity.set({ ...delivery, activity: working })).status).toBe('accepted');
            expect((yield* client.activity.set({ ...delivery, activity: working })).status).toBe('already_recorded');
            const shown = yield* Queue.take(output);
            expect(shown.operation).toEqual(SetActivity.make({ activity: working }));
            expect((yield* client.status(delivery)).activity).toEqual(working);

            yield* client.complete(delivery);
            const presented = yield* Queue.take(output);
            expect(presented.operation).toEqual(
                ProviderPresentOutcome.make({
                    outcome: DeliveryOutcome.cases.Completed.make({}),
                    clearActivity: true,
                }),
            );
            const retired = yield* awaitRetired(client, delivery);
            expect(Arr.map(retired.output, ({ kind }) => kind)).toEqual(['SetActivity', 'PresentOutcome']);
        }),
    );

    it.live('answers 409 for a link or activity the destination does not list, and saves nothing', ({ expect }) =>
        Effect.gen(function* () {
            const { contexts, webhook, client, raw } = yield* startBotWith(['PresentOutcome']);
            yield* webhook('first');
            const context = yield* Queue.take(contexts);
            const delivery = { deliveryId: context.deliveryId, accessToken: context.accessToken };

            const link = yield* raw(`/deliveries/${encodeURIComponent(context.deliveryId)}/links`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${Redacted.value(context.accessToken)}`,
                },
                body: yield* jsonText({ label: 'Run', url: 'https://example.com/run/1' }),
            });

            expect(link.status).toBe(409);

            const activity = yield* client.activity
                .set({ ...delivery, activity: DeliveryActivity.cases.Working.make({ message: 'x' }) })
                .pipe(Effect.flip);

            expect(activity).toEqual(DeliveryOperationUnsupported.make({ operation: 'SetActivity' }));
            expect((yield* client.status(delivery)).output).toEqual([]);
        }),
    );
});

describe('delivery API reactions', () => {
    const reactionOperations: ReadonlyArray<DeliveryOperationKind> = [
        'PresentOutcome',
        'CreateMessage',
        'SetMessageReaction',
    ];

    it.live(
        'sets reactions through the generated client on what started the delivery and on its messages',
        ({ expect }) =>
            Effect.gen(function* () {
                const { contexts, output, webhook, client } = yield* startBotWith(reactionOperations, {
                    activationTarget: { message: 'trigger' },
                    reactionTargets: ['ActivationTarget', 'MessageTarget'],
                });

                yield* webhook('first');
                const context = yield* Queue.take(contexts);
                const delivery = { deliveryId: context.deliveryId, accessToken: context.accessToken };
                const activation = DeliveryReactionTarget.cases.ActivationTarget.make({});
                const messageId = MessageId.make('summary');
                const onSummary = DeliveryReactionTarget.cases.MessageTarget.make({ messageId });
                expect((yield* client.status(delivery)).reactionTargets).toEqual(['ActivationTarget', 'MessageTarget']);

                const add = { ...delivery, target: activation, reaction: 'eyes' as const, active: true };
                expect((yield* client.reactions.set(add)).status).toBe('accepted');
                expect((yield* Queue.take(output)).operation).toEqual(
                    ProviderSetMessageReaction.make({
                        target: ProviderReactionTarget.cases.ActivationTarget.make({}),
                        reaction: 'eyes',
                        active: true,
                    }),
                );
                expect((yield* client.reactions.set(add)).status).toBe('already_recorded');
                expect((yield* client.reactions.set({ ...add, active: false })).status).toBe('accepted');
                expect((yield* Queue.take(output)).operation).toEqual(
                    ProviderSetMessageReaction.make({
                        target: ProviderReactionTarget.cases.ActivationTarget.make({}),
                        reaction: 'eyes',
                        active: false,
                        addedReference: { sent: 'reaction-1' },
                    }),
                );

                yield* client.messages.create({ ...delivery, message: { messageId, markdown: 'Summary' } });
                yield* client.reactions.set({
                    ...delivery,
                    target: onSummary,
                    reaction: 'hooray',
                    active: true,
                });
                yield* Queue.take(output);
                expect((yield* Queue.take(output)).operation).toEqual(
                    ProviderSetMessageReaction.make({
                        target: ProviderReactionTarget.cases.MessageTarget.make({
                            messageId,
                            reference: { sent: 'message-1' },
                        }),
                        reaction: 'hooray',
                        active: true,
                    }),
                );

                yield* client.complete(delivery);
                yield* awaitRetired(client, delivery);
                const late = yield* client.reactions.set(add).pipe(Effect.flip);
                expect(late._tag).toBe('DeliveryClosed');
            }),
    );

    it.live(
        'answers 409 for a target the destination cannot react on, and 400 for a reaction outside the set',
        ({ expect }) =>
            Effect.gen(function* () {
                const { contexts, webhook, client, raw } = yield* startBotWith(reactionOperations, {
                    reactionTargets: ['MessageTarget'],
                });

                yield* webhook('first');
                const context = yield* Queue.take(contexts);
                const delivery = { deliveryId: context.deliveryId, accessToken: context.accessToken };

                const refused = yield* client.reactions
                    .set({
                        ...delivery,
                        target: DeliveryReactionTarget.cases.ActivationTarget.make({}),
                        reaction: 'eyes',
                        active: true,
                    })
                    .pipe(Effect.flip);

                expect(refused).toEqual(DeliveryReactionTargetUnavailable.make({ target: 'ActivationTarget' }));

                const missing = yield* client.reactions
                    .set({
                        ...delivery,
                        target: DeliveryReactionTarget.cases.MessageTarget.make({
                            messageId: MessageId.make('none'),
                        }),
                        reaction: 'eyes',
                        active: true,
                    })
                    .pipe(Effect.flip);

                expect(missing._tag).toBe('DeliveryMessageNotFound');

                const reactions = `/deliveries/${encodeURIComponent(context.deliveryId)}/reactions`;

                const request = (
                    reaction: string,
                    body: { readonly target: DeliveryReactionTarget; readonly active: boolean },
                ) =>
                    Effect.flatMap(jsonText(body), (text) =>
                        raw(`${reactions}/${reaction}`, {
                            method: 'PUT',
                            headers: {
                                authorization: `Bearer ${Redacted.value(context.accessToken)}`,
                                'content-type': 'application/json',
                            },
                            body: text,
                        }),
                    );

                expect(
                    (yield* request('eyes', {
                        target: DeliveryReactionTarget.cases.PlanTarget.make({}),
                        active: true,
                    })).status,
                ).toBe(409);
                expect(
                    (yield* request('party_parrot', {
                        target: DeliveryReactionTarget.cases.ActivationTarget.make({}),
                        active: true,
                    })).status,
                ).toBe(400);
                expect((yield* client.status(delivery)).output).toEqual([]);
            }),
    );
});

describe('delivery API plan', () => {
    const step = (id: string, state: DeliveryPlanItemState) =>
        DeliveryPlanItem.make({ id: DeliveryPlanItemId.make(id), title: `Step ${id}`, state });

    const first = DeliveryPlan.make({
        title: 'Ship the fix',
        items: [
            step('a', DeliveryPlanItemState.cases.InProgress.make({})),
            step('b', DeliveryPlanItemState.cases.Pending.make({})),
        ],
    });

    const second = DeliveryPlan.make({
        title: 'Ship the fix',
        items: [
            step('a', DeliveryPlanItemState.cases.Completed.make({ result: 'done' })),
            step('b', DeliveryPlanItemState.cases.InProgress.make({})),
        ],
    });

    it.live(
        'puts the whole plan through the generated client; the provider gets the plan it last showed',
        ({ expect }) =>
            Effect.gen(function* () {
                const { contexts, output, webhook, client } = yield* startBotWith(['PresentOutcome', 'RenderPlan']);

                yield* webhook('first');
                const context = yield* Queue.take(contexts);
                const delivery = { deliveryId: context.deliveryId, accessToken: context.accessToken };

                expect((yield* client.plan.put({ ...delivery, plan: first })).status).toBe('accepted');
                expect((yield* Queue.take(output)).operation).toEqual(
                    ProviderRenderPlan.make({ revision: DeliveryPlanRevision.make(1), plan: first }),
                );
                expect((yield* client.plan.put({ ...delivery, plan: first })).status).toBe('already_recorded');
                expect((yield* client.plan.put({ ...delivery, plan: second })).status).toBe('accepted');
                expect((yield* Queue.take(output)).operation).toEqual(
                    ProviderRenderPlan.make({
                        revision: DeliveryPlanRevision.make(2),
                        plan: second,
                        rendered: RenderedDeliveryPlan.make({
                            revision: DeliveryPlanRevision.make(1),
                            plan: first,
                            presentation: { sent: 'plan-1' },
                        }),
                    }),
                );

                yield* client.complete(delivery);
                const retired = yield* awaitRetired(client, delivery);
                expect(retired.plan).toEqual({ revision: 2, plan: second, renderedRevision: 2 });
                expect((yield* client.plan.put({ ...delivery, plan: second })).status).toBe('already_recorded');
                expect((yield* client.plan.put({ ...delivery, plan: first }).pipe(Effect.flip))._tag).toBe(
                    'DeliveryClosed',
                );
            }),
    );

    it.live(
        'keeps a plan the destination cannot show, and answers 400 for repeated item IDs or too many items',
        ({ expect }) =>
            Effect.gen(function* () {
                const { contexts, webhook, client, raw } = yield* startBotWith(['PresentOutcome']);
                yield* webhook('first');
                const context = yield* Queue.take(contexts);
                const delivery = { deliveryId: context.deliveryId, accessToken: context.accessToken };
                expect((yield* client.plan.put({ ...delivery, plan: first })).status).toBe('accepted');
                const kept = yield* client.status(delivery);
                expect(kept.plan).toEqual({ revision: 1, plan: first });
                expect(kept.output).toEqual([]);

                const put = (plan: Schema.Json) =>
                    Effect.flatMap(jsonText({ plan }), (text) =>
                        raw(`/deliveries/${encodeURIComponent(context.deliveryId)}/plan`, {
                            method: 'PUT',
                            headers: {
                                authorization: `Bearer ${Redacted.value(context.accessToken)}`,
                                'content-type': 'application/json',
                            },
                            body: text,
                        }),
                    );

                const item = {
                    id: 'a',
                    title: 'Step a',
                    state: DeliveryPlanItemState.cases.Pending.make({}),
                };

                expect((yield* put({ items: [item, item] })).status).toBe(400);
                expect(
                    (yield* put({
                        items: Array.from({ length: 51 }, (_, index) => ({ ...item, id: `a${index}` })),
                    })).status,
                ).toBe(400);

                /** A state no plan item has, as a remote worker could send it. */
                const skipped = yield* jsonValue('{"_tag":"Skipped"}');
                expect((yield* put({ items: [{ ...item, state: skipped }] })).status).toBe(400);
                expect((yield* client.status(delivery)).plan).toEqual({ revision: 1, plan: first });
            }),
    );
});

describe('delivery API time limit', () => {
    it.live(
        'a handoff without failAfter gets 24 hours, and each request from the worker moves it later',
        ({ expect }) =>
            Effect.gen(function* () {
                const { contexts, webhook, client } = yield* startBotWith(['PresentOutcome', 'SetActivity']);

                const before = yield* Clock.currentTimeMillis;
                yield* webhook('first');
                const context = yield* Queue.take(contexts);
                const delivery = { deliveryId: context.deliveryId, accessToken: context.accessToken };
                const day = 24 * 60 * 60 * 1_000;
                const first = (yield* client.status(delivery)).failAt;

                assert.isDefined(first);
                expect(first).toBeGreaterThanOrEqual(before + day);
                expect(first).toBeLessThanOrEqual((yield* Clock.currentTimeMillis) + day);

                yield* Effect.sleep('20 millis');
                yield* client.activity.set({
                    ...delivery,
                    activity: DeliveryActivity.cases.Working.make({ message: 'Working' }),
                });
                const moved = (yield* client.status(delivery)).failAt;

                assert.isDefined(moved);
                expect(moved).toBeGreaterThan(first);
            }),
    );
});
