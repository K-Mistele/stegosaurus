/**
 * Slack's plan: the mapping from a delivery plan to a Slack plan block, the output processor over a
 * recording `SlackApi` (post, replace, no change, a deleted plan message, failures), and the
 * `chat.postMessage` and `chat.update` requests at the HTTP seam.
 */
import { describe, it } from '@effect/vitest';
import { ProviderOutputAttempt } from '@stegosaurus/channels-delivery/ProviderOutput';
import { BatchId, formatDeliveryId } from '@stegosaurus/channels-delivery/DeliveryReference';
import {
    DeliveryPlan,
    DeliveryPlanItem,
    DeliveryPlanItemId,
    DeliveryPlanItemState,
    ProviderRenderPlan,
    RenderedDeliveryPlan,
} from '@stegosaurus/channels-delivery/DeliveryPlan';
import { DeliveryOperationId } from '@stegosaurus/channels-delivery/DeliveryOperation';
import { PreparedDeliveryCallback } from '@stegosaurus/channels-delivery/DeliveryContext';
import { Effect, Layer, Option, Queue, Ref, Result, Schema } from 'effect';

import {
    SlackApi,
    SlackApiError,
    SlackChannelId,
    SlackDeliveryDestination,
    SlackDeliveryDestinationJson,
    SlackMessageRef,
    SlackMessageTs,
    SlackPlan,
    SlackPlanPresentation,
    SlackPlanPresentationJson,
    SlackPlanTask,
    SlackTeamId,
    SlackThreadRef,
    slackOutputProcessor,
    slackPlan,
    slackPresentationVersion,
    slackThreadSupportedOperations,
    type SlackPostPlanRequest,
    type SlackUpdatePlanRequest,
} from '../src';
import { makeRecordingSlackHttp, slackApiLayer, type RecordedSlackRequest } from './slack-file-fixtures';

const teamId = SlackTeamId.make('T_PLAN');

const channelId = SlackChannelId.make('C_PLAN');

const thread = SlackThreadRef.make({
    teamId,
    channelId,
    threadTs: SlackMessageTs.make('1700000000.000001'),
    isDm: false,
});

const messageRef = (ts: string) => SlackMessageRef.make({ teamId, channelId, messageTs: SlackMessageTs.make(ts) });

const shownMessage = messageRef('1700000001.000001');

const postedMessage = messageRef('1700000002.000001');

const item = (id: string, title: string, state: DeliveryPlanItemState) =>
    DeliveryPlanItem.make({ id: DeliveryPlanItemId.make(id), title, state });

const { Pending, InProgress, Completed, Failed } = DeliveryPlanItemState.cases;

const started = DeliveryPlan.make({
    title: 'Ship the fix',
    items: [
        item('inspect', 'inspect logs', InProgress.make({ details: 'Reading the logs' })),
        item('rotate', 'rotate secret', Pending.make({})),
    ],
});

const finished = DeliveryPlan.make({
    title: 'Ship the fix',
    items: [
        item('inspect', 'inspect logs', Completed.make({ result: 'Found expired credentials' })),
        item('rotate', 'rotate secret', Failed.make({ reason: 'No access' })),
    ],
});

const presentation = (message: SlackMessageRef) =>
    Schema.encodeEffect(SlackPlanPresentationJson)(SlackPlanPresentation.make({ message })).pipe(Effect.orDie);

const shown = (plan: DeliveryPlan) =>
    Effect.map(presentation(shownMessage), (encoded) =>
        RenderedDeliveryPlan.make({ revision: 1, plan, presentation: encoded }),
    );

const encodedDestination = Schema.encodeEffect(SlackDeliveryDestinationJson)(
    SlackDeliveryDestination.make({ thread }),
).pipe(Effect.orDie);

const attempt = (operation: ProviderRenderPlan, destination: Effect.Success<typeof encodedDestination>) =>
    ProviderOutputAttempt.make({
        deliveryId: formatDeliveryId({
            mailboxKey: 'slack:v1:mailbox',
            batchId: BatchId.make('batch-1'),
        }),
        operationId: DeliveryOperationId.make('plan-1'),
        attempt: 1,
        hadAmbiguousAttempt: false,
        idempotencyKey: '00000000-0000-4000-8000-000000000001',
        prepared: PreparedDeliveryCallback.make({
            name: 'onNewMention',
            presentationVersion: slackPresentationVersion,
            destination,
            supportedOperations: slackThreadSupportedOperations,
        }),
        operation,
    });

type PlanCalls = {
    readonly posts: ReadonlyArray<SlackPostPlanRequest>;
    readonly updates: ReadonlyArray<SlackUpdatePlanRequest>;
};

/** Slack's answer for each call; absent means it succeeds. */
type PlanFaults = { readonly post?: string; readonly update?: string };

/** A `SlackApi` that records plan posts and updates. A post makes `postedMessage`. */
const recordingSlackApi = (calls: Ref.Ref<PlanCalls>, faults: PlanFaults) =>
    Layer.mock(SlackApi, {
        postPlanToThread: (request) =>
            Effect.gen(function* () {
                yield* Ref.update(calls, (all) => ({ ...all, posts: [...all.posts, request] }));

                if (faults.post !== undefined)
                    return yield* SlackApiError.make({ operation: 'post_plan', message: faults.post });

                return postedMessage;
            }),
        updatePlan: (request) =>
            Effect.gen(function* () {
                yield* Ref.update(calls, (all) => ({ ...all, updates: [...all.updates, request] }));

                if (faults.update !== undefined) {
                    return yield* SlackApiError.make({ operation: 'update_plan', message: faults.update });
                }
            }),
    });

const run = (operation: ProviderRenderPlan, faults: PlanFaults = {}) =>
    Effect.gen(function* () {
        const calls = yield* Ref.make<PlanCalls>({ posts: [], updates: [] });
        const processor = yield* slackOutputProcessor({ namespace: 'slack-plan-test' });

        const destination = yield* encodedDestination;

        const result = yield* processor
            .process(attempt(operation, destination))
            .pipe(Effect.provide(recordingSlackApi(calls, faults)), Effect.result);

        const receipt = Result.isSuccess(result)
            ? Option.getOrUndefined(Schema.decodeUnknownOption(SlackPlanPresentationJson)(result.success.receipt))
                  ?.message
            : undefined;

        return { result, receipt, ...(yield* Ref.get(calls)) };
    });

describe('Slack plan block', () => {
    it('maps each state to its status, with details while in progress and output after', ({ expect }) => {
        expect(slackPlan(started)).toEqual(
            SlackPlan.make({
                title: 'Ship the fix',
                tasks: [
                    SlackPlanTask.make({
                        id: 'inspect',
                        title: 'inspect logs',
                        status: 'in_progress',
                        details: 'Reading the logs',
                    }),
                    SlackPlanTask.make({ id: 'rotate', title: 'rotate secret', status: 'pending' }),
                ],
            }),
        );
        expect(slackPlan(finished).tasks).toEqual([
            SlackPlanTask.make({
                id: 'inspect',
                title: 'inspect logs',
                status: 'complete',
                output: 'Found expired credentials',
            }),
            SlackPlanTask.make({
                id: 'rotate',
                title: 'rotate secret',
                status: 'error',
                output: 'No access',
            }),
        ]);
        expect(slackPlan(DeliveryPlan.make({ items: [] })).title).toEqual('Plan');
    });
});

describe('Slack plan output', () => {
    it.effect('posts the first plan as a plan message, and keeps the message as the presentation', ({ expect }) =>
        Effect.gen(function* () {
            const { posts, updates, receipt } = yield* run(ProviderRenderPlan.make({ revision: 1, plan: started }));

            expect(posts).toEqual([{ thread, plan: slackPlan(started) }]);
            expect(updates).toEqual([]);
            expect(receipt).toEqual(postedMessage);
        }),
    );

    it.effect('replaces the whole plan in the shown message, and makes no call for the same plan', ({ expect }) =>
        Effect.gen(function* () {
            const changed = yield* run(
                ProviderRenderPlan.make({ revision: 2, plan: finished, rendered: yield* shown(started) }),
            );

            expect(changed.updates).toEqual([{ message: shownMessage, plan: slackPlan(finished) }]);
            expect(changed.posts).toEqual([]);
            expect(changed.receipt).toEqual(shownMessage);

            const same = yield* run(
                ProviderRenderPlan.make({ revision: 2, plan: started, rendered: yield* shown(started) }),
            );

            expect([...same.posts, ...same.updates]).toEqual([]);
            expect(same.receipt).toEqual(shownMessage);
        }),
    );

    it.effect('posts the plan again when its message was deleted', ({ expect }) =>
        Effect.gen(function* () {
            const { posts, updates, receipt } = yield* run(
                ProviderRenderPlan.make({ revision: 2, plan: finished, rendered: yield* shown(started) }),
                { update: 'message_not_found' },
            );

            expect(updates).toHaveLength(1);
            expect(posts).toEqual([{ thread, plan: slackPlan(finished) }]);
            expect(receipt).toEqual(postedMessage);
        }),
    );

    it.effect('reports a failure Slack may get over as retryable, and one it will not as final', ({ expect }) =>
        Effect.gen(function* () {
            const render = ProviderRenderPlan.make({ revision: 1, plan: started });
            const unreachable = yield* run(render, { post: 'Could not reach Slack' });
            const archived = yield* run(render, { post: 'is_archived' });

            const uneditable = yield* run(
                ProviderRenderPlan.make({ revision: 2, plan: finished, rendered: yield* shown(started) }),
                {
                    update: 'cant_update_message',
                },
            );

            if (
                !Result.isFailure(unreachable.result) ||
                !Result.isFailure(archived.result) ||
                !Result.isFailure(uneditable.result)
            ) {
                return expect.unreachable();
            }

            expect(unreachable.result.failure).toMatchObject({
                retryable: true,
                safeCode: 'slack_plan_failed',
            });
            expect(archived.result.failure).toMatchObject({
                retryable: false,
                safeCode: 'slack_plan_failed',
            });
            expect(uneditable.result.failure).toMatchObject({
                retryable: false,
                safeCode: 'slack_plan_failed',
            });
        }),
    );
});

describe('Slack plan API', () => {
    it.effect('posts a plan block to the thread and replaces it with chat.update', ({ expect }) =>
        Effect.gen(function* () {
            const requests = yield* Queue.unbounded<RecordedSlackRequest>();

            const http = makeRecordingSlackHttp(requests, () => Response.json({ ok: true, ts: '1700000005.000001' }));

            const body = (request: RecordedSlackRequest) =>
                Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(new TextDecoder().decode(request.body)).pipe(
                    Effect.orDie,
                );

            const message = yield* Effect.gen(function* () {
                const slackApi = yield* SlackApi;
                const posted = yield* slackApi.postPlanToThread({ thread, plan: slackPlan(started) });
                yield* slackApi.updatePlan({ message: posted, plan: slackPlan(finished) });

                return posted;
            }).pipe(Effect.provide(slackApiLayer(http)));

            expect(message).toEqual(messageRef('1700000005.000001'));
            const [post, update] = yield* Queue.takeAll(requests);

            if (post === undefined || update === undefined) return expect.unreachable();

            const note = (text: string) => ({
                type: 'rich_text',
                elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text }] }],
            });

            expect(post.url).toEqual('https://slack.com/api/chat.postMessage');
            expect(yield* body(post)).toEqual({
                channel: channelId,
                thread_ts: thread.threadTs,
                text: 'Ship the fix\n- (in_progress) inspect logs\n- (pending) rotate secret',
                blocks: [
                    {
                        type: 'plan',
                        title: 'Ship the fix',
                        tasks: [
                            {
                                type: 'task_card',
                                task_id: 'inspect',
                                title: 'inspect logs',
                                status: 'in_progress',
                                details: note('Reading the logs'),
                            },
                            { type: 'task_card', task_id: 'rotate', title: 'rotate secret', status: 'pending' },
                        ],
                    },
                ],
            });
            expect(update.url).toEqual('https://slack.com/api/chat.update');
            expect(yield* body(update)).toMatchObject({
                channel: channelId,
                ts: '1700000005.000001',
                blocks: [
                    {
                        type: 'plan',
                        tasks: [
                            { task_id: 'inspect', status: 'complete', output: note('Found expired credentials') },
                            { task_id: 'rotate', status: 'error', output: note('No access') },
                        ],
                    },
                ],
            });
        }),
    );
});
