import { describe, it } from '@effect/vitest';
import {
    DeliveryOutputApplied,
    DeliveryOutputFailed,
    ProviderOutputAttempt,
    ProviderPresentOutcome,
    type ProviderOutputOperation,
} from '@stegosaurus/channels-delivery/ProviderOutput';
import { BatchId, formatDeliveryId } from '@stegosaurus/channels-delivery/DeliveryReference';
import { ProviderReactionTarget, ProviderSetMessageReaction } from '@stegosaurus/channels-delivery/DeliveryReaction';
import {
    ProviderRenderPlan,
    RenderedDeliveryPlan,
    DeliveryPlan,
    DeliveryPlanItem,
    DeliveryPlanItemId,
    DeliveryPlanItemState,
} from '@stegosaurus/channels-delivery/DeliveryPlan';
import { DeliveryOutcome } from '@stegosaurus/channels-delivery/DeliveryOutcome';
import { DeliveryOperationId } from '@stegosaurus/channels-delivery/DeliveryOperation';
import {
    CreateMessage,
    MessageId,
    ProviderDeleteMessage,
    ProviderUpdateMessage,
} from '@stegosaurus/channels-delivery/DeliveryMessage';
import { AddExternalLink, ExternalLink } from '@stegosaurus/channels-delivery/DeliveryLink';
import { PreparedDeliveryCallback } from '@stegosaurus/channels-delivery/DeliveryContext';
import { DeliveryActivity, SetActivity } from '@stegosaurus/channels-delivery/DeliveryActivity';
import { Effect, Layer, Option, Ref, Result, Schema, Array as Arr } from 'effect';

import {
    commentOutputScenarios,
    planCommentScenarios,
    type CommentOutputHarness,
} from '../../channels-delivery/test/comment-output-scenarios';
import {
    LinearActivityContent,
    LinearAgentActivityReceipt,
    LinearCommentRef,
    LinearContent,
    LinearIssueRef,
    LinearReactionTarget,
    type LinearCreateAgentActivityRequest,
    type LinearCreateCommentRequest,
    type LinearDeleteCommentRequest,
    type LinearUpdateAgentSessionRequest,
    type LinearUpdateCommentRequest,
} from '../src';
import {
    LinearApi,
    LinearApiError,
    type LinearCreateReactionRequest,
    type LinearDeleteReactionRequest,
} from '../src/LinearApi';
import {
    LinearActivationTarget,
    LinearAgentSessionDestination,
    LinearCommentActivationTarget,
    LinearDeliveryDestination,
    LinearIssueActivationTarget,
    LinearIssueDestination,
    linearSupportedOperations,
} from '../src/LinearDeliveryDestination';
import {
    LinearActivityReceipt,
    LinearAgentPlanReceipt,
    LinearCommentReceipt,
    LinearOutputReceipt,
    LinearPlanThoughtReceipt,
    LinearReactionReceipt,
    linearDefaultOutcomeText,
    makeLinearOutputProcessor,
} from '../src/LinearDeliveryOutput';
import {
    LinearAgentActivityId,
    LinearAgentSessionId,
    LinearCommentId,
    LinearIssueId,
    LinearOrganizationId,
    LinearReactionId,
    LinearUserId,
} from '../src/LinearIdentity';
import { LinearCommentRecord, LinearReactionRecord } from '../src/LinearResourceRecords';
import { linearAppUserId, linearOrganizationId } from './fixtures';

const idempotencyKey = '5b0c3a1e-8d2f-4c61-9a57-1f2e3d4c5b6a';

const sessionId = LinearAgentSessionId.make('71000000-0000-4000-8000-000000000001');

const issueId = LinearIssueId.make('b33fb278-fbe0-45e4-b4eb-94b0839f51b9');

const bot = { organizationId: linearOrganizationId, appUserId: linearAppUserId };

const sessionDestination = LinearAgentSessionDestination.make({
    organizationId: linearOrganizationId,
    appUserId: linearAppUserId,
    sessionId,
    issueId,
});

const issueDestination = LinearIssueDestination.make({
    organizationId: linearOrganizationId,
    issueId,
});

const encodeDestination = Schema.encodeResult(Schema.toCodecJson(LinearDeliveryDestination));

const encodeActivationTarget = Schema.encodeResult(Schema.toCodecJson(LinearActivationTarget));

const encodeReceipt = Schema.encodeResult(Schema.toCodecJson(LinearOutputReceipt));

/** A receipt as the store saves it. Throws, failing the test, when it cannot be encoded. */
const encodeLinearReceipt = (receipt: LinearOutputReceipt) => Result.getOrThrow(encodeReceipt(receipt));

/** The failure of a run that failed. Throws, failing the test, when the run succeeded. */
const failureOf = <A, E>(result: Result.Result<A, E>) => Option.getOrThrow(Result.getFailure(result));

const prepared = (
    destination: LinearDeliveryDestination,
    presentationVersion: number,
    activationTarget: LinearActivationTarget | null,
) => {
    const fields = {
        name: 'onAgentSessionCreated',
        presentationVersion,
        destination: Result.getOrThrow(encodeDestination(destination)),
        supportedOperations: linearSupportedOperations(destination),
    };

    return PreparedDeliveryCallback.make(
        activationTarget === null
            ? fields
            : {
                  ...fields,
                  activationTarget: Result.getOrThrow(encodeActivationTarget(activationTarget)),
              },
    );
};

const attempt = (
    operation: ProviderOutputOperation,
    destination: LinearDeliveryDestination = sessionDestination,
    activationTarget: LinearActivationTarget | null = null,
) =>
    ProviderOutputAttempt.make({
        deliveryId: formatDeliveryId({
            mailboxKey: 'linear:v1:agent-session:x',
            batchId: BatchId.make('batch-1'),
        }),
        operationId: DeliveryOperationId.make('outcome'),
        attempt: 1,
        hadAmbiguousAttempt: false,
        idempotencyKey,
        prepared: prepared(destination, 1, activationTarget),
        operation,
    });

const outcome = (result: DeliveryOutcome, markdown: string | null = null) =>
    ProviderPresentOutcome.make(
        markdown === null
            ? { outcome: result, clearActivity: true }
            : { outcome: result, markdown, clearActivity: true },
    );

const commentRef = LinearCommentRef.make({
    organizationId: linearOrganizationId,
    teamId: null,
    issueId,
    commentId: LinearCommentId.make('72000000-0000-4000-8000-00000000c0de'),
});

const commentReceipt = encodeLinearReceipt(LinearCommentReceipt.make({ comment: commentRef }));

type Calls = {
    readonly activities: ReadonlyArray<LinearCreateAgentActivityRequest>;
    readonly sessionUpdates: ReadonlyArray<LinearUpdateAgentSessionRequest>;
    readonly comments: ReadonlyArray<LinearCreateCommentRequest>;
    readonly commentUpdates: ReadonlyArray<LinearUpdateCommentRequest>;
    readonly commentDeletes: ReadonlyArray<LinearDeleteCommentRequest>;
    readonly reactions: ReadonlyArray<LinearCreateReactionRequest>;
    readonly reactionDeletes: ReadonlyArray<LinearDeleteReactionRequest>;
};

/**
 * Run one attempt through the Linear output processor over a recording `LinearApi`. `activityError`,
 * when given, is how Linear answers every activity; `deleteError` how it answers a comment delete.
 */
const run = (
    input: ProviderOutputAttempt,
    options: {
        readonly activityError?: LinearApiError;
        readonly deleteError?: LinearApiError;
        /** How Linear answers every comment create, update, and delete. */
        readonly commentError?: LinearApiError;
        /** How Linear answers every reaction create and delete. */
        readonly reactionError?: LinearApiError;
        /** How Linear answers every session update. */
        readonly sessionUpdateError?: LinearApiError;
    } = {},
) =>
    Effect.gen(function* () {
        const calls = yield* Ref.make<Calls>({
            activities: [],
            sessionUpdates: [],
            comments: [],
            commentUpdates: [],
            commentDeletes: [],
            reactions: [],
            reactionDeletes: [],
        });

        const record = <K extends keyof Calls>(key: K, value: Calls[K][number]) =>
            Ref.update(calls, (all) => ({ ...all, [key]: [...all[key], value] }));

        const commentAnswer = options.commentError === undefined ? Effect.void : Effect.fail(options.commentError);

        const reactionAnswer = options.reactionError === undefined ? Effect.void : Effect.fail(options.reactionError);

        const api = Layer.mock(LinearApi, {
            createReaction: (request) =>
                record('reactions', request).pipe(
                    Effect.andThen(reactionAnswer),
                    Effect.as(
                        LinearReactionRecord.make({
                            id: request.reactionId ?? LinearReactionId.make('assigned-by-linear'),
                            issueId,
                            commentId: null,
                            emoji: request.emoji,
                            author: null,
                            ref: {
                                issue: LinearIssueRef.make({
                                    organizationId: linearOrganizationId,
                                    teamId: null,
                                    issueId,
                                }),
                                reactionId: request.reactionId ?? LinearReactionId.make('assigned-by-linear'),
                            },
                        }),
                    ),
                ),
            deleteReaction: (request) => record('reactionDeletes', request).pipe(Effect.andThen(reactionAnswer)),
            createAgentActivity: (request) =>
                record('activities', request).pipe(
                    Effect.andThen(
                        options.activityError === undefined
                            ? Effect.succeed(
                                  LinearAgentActivityReceipt.make({
                                      activityId:
                                          request.activityId ?? LinearAgentActivityId.make('assigned-by-linear'),
                                      sessionId: request.sessionId,
                                  }),
                              )
                            : Effect.fail(options.activityError),
                    ),
                ),
            updateAgentSession: (request) =>
                record('sessionUpdates', request).pipe(
                    Effect.andThen(
                        options.sessionUpdateError === undefined
                            ? Effect.void
                            : Effect.fail(options.sessionUpdateError),
                    ),
                ),
            createComment: (request) =>
                record('comments', request).pipe(
                    Effect.andThen(commentAnswer),
                    Effect.as(
                        LinearCommentRecord.make({
                            ref: commentRef,
                            issue: LinearIssueRef.make({
                                organizationId: linearOrganizationId,
                                teamId: null,
                                issueId,
                            }),
                            parentCommentId: null,
                            content: request.content,
                            author: null,
                            files: [],
                        }),
                    ),
                ),
            updateComment: (request) =>
                record('commentUpdates', request).pipe(
                    Effect.andThen(commentAnswer),
                    Effect.as(
                        LinearCommentRecord.make({
                            ref: request.comment,
                            issue: LinearIssueRef.make({
                                organizationId: linearOrganizationId,
                                teamId: null,
                                issueId,
                            }),
                            parentCommentId: null,
                            content: request.content,
                            author: null,
                            files: [],
                        }),
                    ),
                ),
            deleteComment: (request) =>
                record('commentDeletes', request).pipe(
                    Effect.andThen(options.deleteError === undefined ? Effect.void : Effect.fail(options.deleteError)),
                    Effect.andThen(commentAnswer),
                ),
        });

        const processor = yield* makeLinearOutputProcessor({ namespace: 'linear-output-test', bot });

        const result = yield* processor.process(input).pipe(Effect.provide(api), Effect.result);

        return { result, calls: yield* Ref.get(calls) };
    });

const activityReference = encodeLinearReceipt(
    LinearActivityReceipt.make({ activityId: LinearAgentActivityId.make(idempotencyKey) }),
);

const activityReceipt = DeliveryOutputApplied.make({ receipt: activityReference });

const linearError = (reason: LinearApiError['reason'], retryable: boolean, retryAfterMs: number | null = null) =>
    LinearApiError.make(
        retryAfterMs === null
            ? { operation: 'create_agent_activity', reason, retryable }
            : { operation: 'create_agent_activity', reason, retryable, retryAfterMs },
    );

const commentFault = {
    retryable: LinearApiError.make({
        operation: 'create_comment',
        reason: 'unavailable',
        retryable: true,
    }),
    final: LinearApiError.make({
        operation: 'create_comment',
        reason: 'forbidden',
        retryable: false,
    }),
    gone: LinearApiError.make({ operation: 'update_comment', reason: 'not_found', retryable: false }),
} as const;

const linearIssueHarness: CommentOutputHarness = {
    provider: 'Linear issue',
    optionBullet: '- ',
    run: (operation, options = {}) => {
        const base = attempt(operation, issueDestination);

        const input =
            options.futureVersion === true
                ? ProviderOutputAttempt.make({ ...base, prepared: prepared(issueDestination, 2, null) })
                : base;

        return run(input, options.fault === undefined ? {} : { commentError: commentFault[options.fault] }).pipe(
            Effect.map(({ result, calls }) => ({
                result,
                shown: [
                    ...Arr.map(calls.comments, ({ content }) => `post: ${content.markdown}`),
                    ...Arr.map(calls.commentUpdates, ({ content }) => `edit: ${content.markdown}`),
                    ...Arr.map(calls.commentDeletes, () => 'delete'),
                ],
            })),
        );
    },
};

commentOutputScenarios(linearIssueHarness);

planCommentScenarios(linearIssueHarness);

const planItem = (id: string, title: string, state: DeliveryPlanItemState) =>
    DeliveryPlanItem.make({ id: DeliveryPlanItemId.make(id), title, state });

const sessionPlan = DeliveryPlan.make({
    title: 'Ship the fix',
    items: [
        planItem(
            'inspect',
            'Inspect logs',
            DeliveryPlanItemState.cases.Completed.make({ result: 'Found expired credentials' }),
        ),
        planItem(
            'rotate',
            'Rotate secret',
            DeliveryPlanItemState.cases.InProgress.make({ details: 'Updating production' }),
        ),
        planItem('notify', 'Notify owner', DeliveryPlanItemState.cases.Failed.make({ reason: 'No owner listed' })),
        planItem('verify', 'Verify deployment', DeliveryPlanItemState.cases.Pending.make({})),
    ],
});

const thoughtShown = (text: string | null = null) =>
    RenderedDeliveryPlan.make({
        revision: 1,
        plan: sessionPlan,
        presentation: encodeLinearReceipt(
            text === null ? LinearPlanThoughtReceipt.make({}) : LinearPlanThoughtReceipt.make({ text }),
        ),
    });

describe('Linear output: session plan', () => {
    it.effect('replaces the whole Agent Plan, with a failed item canceled and its reason in its text', ({ expect }) =>
        Effect.gen(function* () {
            const { result, calls } = yield* run(attempt(ProviderRenderPlan.make({ revision: 1, plan: sessionPlan })));

            expect(calls.sessionUpdates).toEqual([
                {
                    organizationId: linearOrganizationId,
                    sessionId,
                    plan: [
                        { content: 'Inspect logs: Found expired credentials', status: 'completed' },
                        { content: 'Rotate secret: Updating production', status: 'inProgress' },
                        { content: 'Notify owner (failed: No owner listed)', status: 'canceled' },
                        { content: 'Verify deployment', status: 'pending' },
                    ],
                },
            ]);
            expect(calls.activities).toEqual([]);
            expect(result).toEqual(
                Result.succeed(
                    DeliveryOutputApplied.make({ receipt: encodeLinearReceipt(LinearAgentPlanReceipt.make({})) }),
                ),
            );
        }),
    );

    it.effect(
        'falls back to a thought for the item in progress when Linear refuses the Agent Plan, and keeps it',
        ({ expect }) =>
            Effect.gen(function* () {
                const refused = LinearApiError.make({
                    operation: 'update_agent_session',
                    reason: 'validation',
                    retryable: false,
                });

                const first = yield* run(attempt(ProviderRenderPlan.make({ revision: 1, plan: sessionPlan })), {
                    sessionUpdateError: refused,
                });

                expect(first.calls.activities).toEqual([
                    {
                        organizationId: linearOrganizationId,
                        sessionId,
                        content: LinearActivityContent.cases.Thought.make({
                            body: 'Rotate secret: Updating production',
                        }),
                        ephemeral: true,
                        activityId: idempotencyKey,
                    },
                ]);
                expect(first.result).toEqual(
                    Result.succeed(
                        DeliveryOutputApplied.make({
                            receipt: encodeLinearReceipt(
                                LinearPlanThoughtReceipt.make({ text: 'Rotate secret: Updating production' }),
                            ),
                        }),
                    ),
                );

                const unchanged = yield* run(
                    attempt(
                        ProviderRenderPlan.make({
                            revision: 2,
                            plan: sessionPlan,
                            rendered: thoughtShown('Rotate secret: Updating production'),
                        }),
                    ),
                );

                expect(unchanged.calls.sessionUpdates).toEqual([]);
                expect(unchanged.calls.activities).toEqual([]);

                const moved = DeliveryPlan.make({
                    items: [planItem('verify', 'Verify deployment', DeliveryPlanItemState.cases.InProgress.make({}))],
                });

                const next = yield* run(
                    attempt(
                        ProviderRenderPlan.make({
                            revision: 2,
                            plan: moved,
                            rendered: thoughtShown('Rotate secret: Updating production'),
                        }),
                    ),
                );

                expect(next.calls.sessionUpdates).toEqual([]);
                expect(Arr.map(next.calls.activities, ({ content }) => content)).toEqual([
                    LinearActivityContent.cases.Thought.make({ body: 'Verify deployment' }),
                ]);
            }),
    );

    it.effect('reports an Agent Plan failure Linear may get over as retryable, without a fallback', ({ expect }) =>
        Effect.gen(function* () {
            const { result, calls } = yield* run(attempt(ProviderRenderPlan.make({ revision: 1, plan: sessionPlan })), {
                sessionUpdateError: LinearApiError.make({
                    operation: 'update_agent_session',
                    reason: 'unavailable',
                    retryable: true,
                }),
            });

            expect(calls.activities).toEqual([]);
            expect(failureOf(result)).toMatchObject({ retryable: true, safeCode: 'linear_plan_failed' });
        }),
    );
});

describe('Linear output: Agent Session', () => {
    it.effect(
        'posts one final activity for each outcome, with a default text when there is no Markdown',
        ({ expect }) =>
            Effect.gen(function* () {
                const cases = [
                    [
                        outcome(DeliveryOutcome.cases.Completed.make({}), 'Fixed.'),
                        LinearActivityContent.cases.Response.make({ body: 'Fixed.' }),
                    ],
                    [
                        outcome(DeliveryOutcome.cases.Completed.make({})),
                        LinearActivityContent.cases.Response.make({ body: linearDefaultOutcomeText.Completed }),
                    ],
                    [
                        outcome(DeliveryOutcome.cases.Failed.make({}), 'Stopped as requested.'),
                        LinearActivityContent.cases.Error.make({ body: 'Stopped as requested.' }),
                    ],
                    [
                        outcome(DeliveryOutcome.cases.Failed.make({})),
                        LinearActivityContent.cases.Error.make({ body: linearDefaultOutcomeText.Failed }),
                    ],
                    [
                        outcome(
                            DeliveryOutcome.cases.AwaitingInput.make({ options: ['staging', 'production'] }),
                            'Where to?',
                        ),
                        LinearActivityContent.cases.Elicitation.make({
                            body: 'Where to?',
                            options: ['staging', 'production'],
                        }),
                    ],
                    [
                        outcome(DeliveryOutcome.cases.AwaitingInput.make({})),
                        LinearActivityContent.cases.Elicitation.make({ body: linearDefaultOutcomeText.AwaitingInput }),
                    ],
                ] as const;

                for (const [operation, expected] of cases) {
                    const { result, calls } = yield* run(attempt(operation));
                    expect(result).toEqual(Result.succeed(activityReceipt));
                    expect(calls.activities).toHaveLength(1);
                    const [request] = calls.activities;
                    expect(request).toEqual({
                        organizationId: linearOrganizationId,
                        sessionId,
                        content: expected,
                        ephemeral: false,
                        activityId: idempotencyKey,
                    });
                }
            }),
    );

    it.effect(
        'shows Working as an ephemeral thought under the operation key, and applies Idle without a call',
        ({ expect }) =>
            Effect.gen(function* () {
                const working = yield* run(
                    attempt(
                        SetActivity.make({
                            activity: DeliveryActivity.cases.Working.make({ message: 'Running tests' }),
                        }),
                    ),
                );

                expect(working.result).toEqual(Result.succeed(activityReceipt));
                expect(working.calls.activities).toEqual([
                    {
                        organizationId: linearOrganizationId,
                        sessionId,
                        content: LinearActivityContent.cases.Thought.make({ body: 'Running tests' }),
                        ephemeral: true,
                        activityId: idempotencyKey,
                    },
                ]);

                const idle = yield* run(attempt(SetActivity.make({ activity: DeliveryActivity.cases.Idle.make({}) })));

                expect(idle.result).toEqual(Result.succeed(DeliveryOutputApplied.make({})));
                expect(idle.calls.activities).toEqual([]);
            }),
    );

    it.effect('posts a message as a lasting thought', ({ expect }) =>
        Effect.gen(function* () {
            const { result, calls } = yield* run(
                attempt(CreateMessage.make({ messageId: MessageId.make('summary'), markdown: 'Summary' })),
            );

            expect(result).toEqual(Result.succeed(activityReceipt));
            expect(calls.activities[0]).toMatchObject({
                content: LinearActivityContent.cases.Thought.make({ body: 'Summary' }),
                ephemeral: false,
            });
        }),
    );

    it.effect('counts an activity Linear already has under the same ID as applied', ({ expect }) =>
        Effect.gen(function* () {
            const { result, calls } = yield* run(attempt(outcome(DeliveryOutcome.cases.Completed.make({}), 'Done')), {
                activityError: linearError('already_exists', false),
            });

            expect(result).toEqual(Result.succeed(activityReceipt));
            expect(calls.activities).toHaveLength(1);
        }),
    );

    it.effect('sorts other Linear failures into retryable and final', ({ expect }) =>
        Effect.gen(function* () {
            const retryable = yield* run(attempt(outcome(DeliveryOutcome.cases.Completed.make({}))), {
                activityError: linearError('rate_limited', true, 2_000),
            });

            expect(failureOf(retryable.result)).toBeInstanceOf(DeliveryOutputFailed);
            expect(failureOf(retryable.result)).toMatchObject({
                retryable: true,
                retryAfterMs: 2_000,
                safeCode: 'linear_activity_failed',
            });

            const invalidId = yield* run(attempt(outcome(DeliveryOutcome.cases.Completed.make({}))), {
                activityError: linearError('rejected', false),
            });

            expect(failureOf(invalidId.result)).toMatchObject({ retryable: false, safeCode: 'linear_activity_failed' });
        }),
    );

    it.effect('refuses message update and delete, which a session cannot show', ({ expect }) =>
        Effect.gen(function* () {
            const messageId = MessageId.make('summary');
            const reference = activityReference;

            for (const operation of [
                ProviderUpdateMessage.make({ messageId, markdown: 'x', reference }),
                ProviderDeleteMessage.make({ messageId, reference }),
            ] as const) {
                const { result, calls } = yield* run(attempt(operation));
                expect(failureOf(result)).toMatchObject({ retryable: false, safeCode: 'unsupported_operation' });
                expect(calls.activities).toEqual([]);
            }

            expect(linearSupportedOperations(sessionDestination)).not.toContain('UpdateMessage');
            expect(linearSupportedOperations(sessionDestination)).not.toContain('DeleteMessage');
            expect(linearSupportedOperations(sessionDestination)).toContain('SetActivity');
        }),
    );

    it.effect('adds a link to the session', ({ expect }) =>
        Effect.gen(function* () {
            const link = ExternalLink.make({ label: 'Run log', url: 'https://example.com/run/1' });
            const { result, calls } = yield* run(attempt(AddExternalLink.make({ link })));
            expect(result).toEqual(Result.succeed(DeliveryOutputApplied.make({})));
            expect(calls.sessionUpdates).toEqual([
                {
                    organizationId: linearOrganizationId,
                    sessionId,
                    addedExternalUrls: [{ label: 'Run log', url: 'https://example.com/run/1' }],
                },
            ]);
        }),
    );

    it.effect(
        'refuses a destination for another workspace or app user, or an unknown presentation version',
        ({ expect }) =>
            Effect.gen(function* () {
                const operation = outcome(DeliveryOutcome.cases.Completed.make({}));

                const otherOrganization = LinearAgentSessionDestination.make({
                    ...sessionDestination,
                    organizationId: LinearOrganizationId.make('other-organization'),
                });

                const otherApp = LinearAgentSessionDestination.make({
                    ...sessionDestination,
                    appUserId: LinearUserId.make('other-app'),
                });

                for (const destination of [otherOrganization, otherApp]) {
                    const { result, calls } = yield* run(attempt(operation, destination));
                    expect(failureOf(result)).toMatchObject({
                        retryable: false,
                        safeCode: 'destination_identity_mismatch',
                    });
                    expect(calls.activities).toEqual([]);
                }

                const version = yield* run(
                    ProviderOutputAttempt.make({
                        ...attempt(operation),
                        prepared: prepared(sessionDestination, 2, null),
                    }),
                );

                expect(failureOf(version.result)).toMatchObject({ safeCode: 'unsupported_presentation_version' });
            }),
    );
});

describe('Linear output: issue', () => {
    it.effect(
        'comments a result with Markdown, listing any options, and applies one without Markdown silently',
        ({ expect }) =>
            Effect.gen(function* () {
                const asked = yield* run(
                    attempt(
                        outcome(
                            DeliveryOutcome.cases.AwaitingInput.make({ options: ['staging', 'production'] }),
                            'Where to?',
                        ),
                        issueDestination,
                    ),
                );

                expect(asked.result).toEqual(Result.succeed(DeliveryOutputApplied.make({ receipt: commentReceipt })));
                expect(asked.calls.comments).toEqual([
                    {
                        issue: { organizationId: linearOrganizationId, teamId: null, issueId },
                        content: LinearContent.make({ markdown: 'Where to?\n\n- staging\n- production' }),
                    },
                ]);

                const silent = yield* run(attempt(outcome(DeliveryOutcome.cases.Completed.make({})), issueDestination));

                expect(silent.result).toEqual(Result.succeed(DeliveryOutputApplied.make({})));
                expect(silent.calls.comments).toEqual([]);
                expect(silent.calls.activities).toEqual([]);
            }),
    );

    it.effect(
        'creates, edits, and removes a message as a comment, and counts a comment already gone as removed',
        ({ expect }) =>
            Effect.gen(function* () {
                const messageId = MessageId.make('progress');

                const created = yield* run(
                    attempt(CreateMessage.make({ messageId, markdown: 'Running' }), issueDestination),
                );

                expect(created.result).toEqual(Result.succeed(DeliveryOutputApplied.make({ receipt: commentReceipt })));

                const updated = yield* run(
                    attempt(
                        ProviderUpdateMessage.make({ messageId, markdown: 'Passed', reference: commentReceipt }),
                        issueDestination,
                    ),
                );

                expect(updated.calls.commentUpdates).toEqual([
                    { comment: commentRef, content: { markdown: 'Passed' } },
                ]);

                const removed = yield* run(
                    attempt(ProviderDeleteMessage.make({ messageId, reference: commentReceipt }), issueDestination),
                );

                expect(removed.calls.commentDeletes).toEqual([{ comment: commentRef }]);

                const gone = yield* run(
                    attempt(ProviderDeleteMessage.make({ messageId, reference: commentReceipt }), issueDestination),
                    {
                        deleteError: LinearApiError.make({
                            operation: 'delete_comment',
                            reason: 'not_found',
                            retryable: false,
                        }),
                    },
                );

                expect(gone.result).toEqual(Result.succeed(DeliveryOutputApplied.make({})));

                const badReference = yield* run(
                    attempt(
                        ProviderDeleteMessage.make({ messageId, reference: { something: 'else' } }),
                        issueDestination,
                    ),
                );

                expect(failureOf(badReference.result)).toMatchObject({ safeCode: 'message_reference_invalid' });
            }),
    );

    it.effect('applies a link without a call, and refuses activity, which an issue cannot show', ({ expect }) =>
        Effect.gen(function* () {
            const link = ExternalLink.make({ label: 'Run log', url: 'https://example.com/run/1' });
            const linked = yield* run(attempt(AddExternalLink.make({ link }), issueDestination));
            expect(linked.result).toEqual(Result.succeed(DeliveryOutputApplied.make({})));
            expect(linked.calls.sessionUpdates).toEqual([]);

            const activity = yield* run(
                attempt(
                    SetActivity.make({ activity: DeliveryActivity.cases.Working.make({ message: 'x' }) }),
                    issueDestination,
                ),
            );

            expect(failureOf(activity.result)).toMatchObject({ safeCode: 'unsupported_operation' });
            expect(linearSupportedOperations(issueDestination)).not.toContain('SetActivity');
        }),
    );
});

describe('Linear output: portable reactions', () => {
    const issueRef = LinearIssueRef.make({
        organizationId: linearOrganizationId,
        teamId: null,
        issueId,
    });

    const onIssue = LinearIssueActivationTarget.make({
        organizationId: linearOrganizationId,
        issueId,
    });

    const onComment = LinearCommentActivationTarget.make({
        organizationId: linearOrganizationId,
        issueId,
        commentId: commentRef.commentId,
    });

    const onActivation = ProviderReactionTarget.cases.ActivationTarget.make({});

    const react = (
        target: ProviderReactionTarget,
        reaction: ProviderSetMessageReaction['reaction'],
        active: boolean,
        addedReference: Schema.Json | null = null,
    ) =>
        ProviderSetMessageReaction.make(
            addedReference === null ? { target, reaction, active } : { target, reaction, active, addedReference },
        );

    const reactionReceipt = encodeLinearReceipt(
        LinearReactionReceipt.make({ issue: issueRef, reactionId: LinearReactionId.make(idempotencyKey) }),
    );

    it.effect("reacts on a session's source comment, else its issue, under the operation key", ({ expect }) =>
        Effect.gen(function* () {
            const comment = yield* run(attempt(react(onActivation, 'thumbs_up', true), sessionDestination, onComment));

            expect(comment.result).toEqual(Result.succeed(DeliveryOutputApplied.make({ receipt: reactionReceipt })));
            expect(comment.calls.reactions).toEqual([
                {
                    target: LinearReactionTarget.cases.Comment.make({ comment: commentRef }),
                    emoji: '+1',
                    reactionId: idempotencyKey,
                },
            ]);

            const issue = yield* run(attempt(react(onActivation, 'hooray', true), sessionDestination, onIssue));

            expect(issue.calls.reactions).toEqual([
                {
                    target: LinearReactionTarget.cases.Issue.make({ issue: issueRef }),
                    emoji: 'tada',
                    reactionId: idempotencyKey,
                },
            ]);
        }),
    );

    it.effect('counts a reaction Linear already has under the same ID as applied', ({ expect }) =>
        Effect.gen(function* () {
            const again = yield* run(attempt(react(onActivation, 'eyes', true), sessionDestination, onIssue), {
                reactionError: linearError('already_exists', false),
            });

            expect(again.result).toEqual(Result.succeed(DeliveryOutputApplied.make({ receipt: reactionReceipt })));
        }),
    );

    it.effect(
        'removes the reaction its add made, counts one already gone as removed, and makes no call with no add',
        ({ expect }) =>
            Effect.gen(function* () {
                const added = encodeLinearReceipt(
                    LinearReactionReceipt.make({ issue: issueRef, reactionId: LinearReactionId.make('reaction-1') }),
                );

                const removed = yield* run(
                    attempt(react(onActivation, 'eyes', false, added), sessionDestination, onIssue),
                );

                expect(removed.result).toEqual(Result.succeed(DeliveryOutputApplied.make({})));
                expect(removed.calls.reactionDeletes).toEqual([{ issue: issueRef, reactionId: 'reaction-1' }]);

                const gone = yield* run(
                    attempt(react(onActivation, 'eyes', false, added), sessionDestination, onIssue),
                    {
                        reactionError: linearError('not_found', false),
                    },
                );

                expect(Result.isSuccess(gone.result)).toBe(true);

                const nothing = yield* run(attempt(react(onActivation, 'eyes', false), sessionDestination, onIssue));

                expect(nothing.result).toEqual(Result.succeed(DeliveryOutputApplied.make({})));
                expect(nothing.calls.reactionDeletes).toEqual([]);
            }),
    );

    it.effect('reacts on a comment an issue delivery posted, and refuses one on a session message', ({ expect }) =>
        Effect.gen(function* () {
            const onPosted = ProviderReactionTarget.cases.MessageTarget.make({
                messageId: MessageId.make('summary'),
                reference: commentReceipt,
            });

            const posted = yield* run(attempt(react(onPosted, 'rocket', true), issueDestination));
            expect(posted.calls.reactions).toEqual([
                {
                    target: LinearReactionTarget.cases.Comment.make({ comment: commentRef }),
                    emoji: 'rocket',
                    reactionId: idempotencyKey,
                },
            ]);

            const session = yield* run(attempt(react(onPosted, 'rocket', true), sessionDestination, onIssue));

            expect(failureOf(session.result)).toMatchObject({ safeCode: 'unsupported_operation' });
            expect(session.calls.reactions).toEqual([]);
        }),
    );

    it.effect('refuses an activation target in another workspace, and sorts Linear failures', ({ expect }) =>
        Effect.gen(function* () {
            const elsewhere = LinearIssueActivationTarget.make({
                organizationId: LinearOrganizationId.make('other-org'),
                issueId,
            });

            const mismatch = yield* run(attempt(react(onActivation, 'eyes', true), issueDestination, elsewhere));

            expect(failureOf(mismatch.result)).toMatchObject({ safeCode: 'destination_identity_mismatch' });
            const missing = yield* run(attempt(react(onActivation, 'eyes', true), issueDestination));
            expect(failureOf(missing.result)).toMatchObject({ safeCode: 'activation_target_missing' });

            const outage = yield* run(attempt(react(onActivation, 'eyes', true), issueDestination, onIssue), {
                reactionError: linearError('unavailable', true, 2_000),
            });

            expect(failureOf(outage.result)).toMatchObject({
                safeCode: 'linear_reaction_failed',
                retryable: true,
                retryAfterMs: 2_000,
            });

            const refused = yield* run(attempt(react(onActivation, 'eyes', true), issueDestination, onIssue), {
                reactionError: linearError('forbidden', false),
            });

            expect(failureOf(refused.result)).toMatchObject({ safeCode: 'linear_reaction_failed', retryable: false });
        }),
    );
});
