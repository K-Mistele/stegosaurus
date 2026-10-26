import { describe, it } from '@effect/vitest';
import {
    GitHubApi,
    GitHubApiError,
    GitHubCallbackError,
    makeGitHubCallbacks,
    GitHubEventId,
    GitHubId,
    GitHubIssue,
    GitHubIssueCreated,
    GitHubIssueOpened,
    GitHubIssueRef,
    GitHubLabel,
    GitHubParticipant,
    GitHubPrCreated,
    GitHubPrOpened,
    GitHubPullRequest,
    GitHubPullRequestRef,
    type GitHubRepositoryRequest,
} from '@stegosaurus/channels-github';
import * as Cloudflare from '@alchemy.run/cloudflare';
import { RuntimeContext } from 'alchemy/RuntimeContext';
import {
    Array as Arr,
    Deferred,
    Effect,
    Fiber,
    Layer,
    Logger,
    Option,
    Record,
    Ref,
    Schema,
    String as Str,
} from 'effect';
import { TestClock } from 'effect/testing';

import { makeTestDeliveryExecution } from '../../../packages/channels-delivery/test/delivery-execution';
import { AutoLabel, AutoLabelError, type AutoLabelOptions } from '../src/AutoLabel';
import { githubHandlers } from '../src/GithubBot';

const repository = {
    installationId: GitHubId.make(100),
    repositoryId: GitHubId.make(200),
    owner: 'humanlayer',
    repository: 'effect-channels',
};

const issue = GitHubIssue.make({
    ref: GitHubIssueRef.make({ ...repository, number: GitHubId.make(42) }),
    mailboxKey: 'github:issue:42',
});

const pullRequest = GitHubPullRequest.make({
    ref: GitHubPullRequestRef.make({ ...repository, number: GitHubId.make(43) }),
    mailboxKey: 'github:pr:43',
});

const label = (name: string) => GitHubLabel.make({ name, color: 'ffffff', description: null });

const answer = (noul: number) => ({ type: 'noul', noul });

/** The options the Ingress Worker gives AutoLabel. */
const defaultOptions: AutoLabelOptions = { model: '@cf/cloudflare/clef', threshold: 0.7, timeout: '60 seconds' };

const input = { discussion: issue, kind: 'issue', title: 'Broken feature', body: 'Private report body' } as const;

const apply = (value: Parameters<AutoLabel['Service']['apply']>[0] = input) =>
    Effect.flatMap(AutoLabel, (service) => service.apply(value));

/** Encodes each structured log entry as one JSON line. */
const encodeLogLine = Schema.encodeOption(Schema.fromJsonString(Schema.Unknown));

type NativeBinding = Effect.Success<Cloudflare.Workers.AIClient['raw']>;

type NativeResponse = Awaited<ReturnType<NativeBinding['run']>>;

type NativeInputs = Parameters<NativeBinding['run']>[1];

const makeHarness = (
    options: {
        readonly labels?: ReadonlyArray<string>;
        readonly response?: NativeResponse;
        readonly run?: () => Promise<NativeResponse>;
        readonly options?: Partial<AutoLabelOptions>;
        readonly lookup?: Effect.Effect<void, GitHubApiError>;
        readonly writeError?: GitHubApiError;
        readonly missingBinding?: boolean;
    } = {},
) =>
    Effect.gen(function* () {
        const requests: Array<{ model: string; payload: NativeInputs }> = [];
        const logs: Array<string> = [];
        const lookups = yield* Ref.make<ReadonlyArray<GitHubRepositoryRequest>>([]);

        const writes = yield* Ref.make<ReadonlyArray<{ kind: string; number: number; labels: ReadonlyArray<string> }>>(
            [],
        );

        const existing = yield* Ref.make<ReadonlyArray<string>>(['custom-existing']);

        const add = (kind: string, number: number, labels: ReadonlyArray<string>) =>
            Effect.gen(function* () {
                yield* Ref.update(writes, (previous) => [...previous, { kind, number, labels }]);

                if (options.writeError !== undefined) return yield* options.writeError;
                const names = yield* Ref.updateAndGet(existing, (previous) => [...new Set([...previous, ...labels])]);

                return Arr.map(names, label);
            });

        const dependencies = Layer.mergeAll(
            Layer.mock(RuntimeContext, { Type: 'Worker', id: 'auto-label-test', env: {} }),
            Layer.mock(GitHubApi, {
                listRepositoryLabels: (request) =>
                    Ref.update(lookups, (previous) => [...previous, request]).pipe(
                        Effect.andThen(options.lookup ?? Effect.void),
                        Effect.as(Arr.map(options.labels ?? ['bug'], label)),
                    ),
                addIssueLabels: ({ issue, labels }) => add('issue', issue.number, labels),
                addPullRequestLabels: ({ pullRequest, labels }) => add('pull_request', pullRequest.number, labels),
            }),
            Logger.layer([
                Logger.make((entry) =>
                    logs.push(
                        Option.getOrElse(
                            encodeLogLine(Logger.formatStructured.log(entry)),
                            () => 'unencodable log entry',
                        ),
                    ),
                ),
            ]),
            Layer.succeed(
                Cloudflare.Workers.WorkerEnvironment,
                options.missingBinding === true
                    ? {}
                    : {
                          AI: {
                              run: (model: string, payload: NativeInputs): Promise<NativeResponse> => {
                                  requests.push({ model, payload });

                                  return (
                                      options.run?.() ??
                                      Promise.resolve(options.response ?? { answers: { bug: answer(0.9) } })
                                  );
                              },
                          },
                      },
            ),
        );

        const autoLabel = AutoLabel.layer({ ...defaultOptions, ...options.options }).pipe(
            Layer.provide(Cloudflare.Workers.AIBinding),
        );

        const layer = autoLabel.pipe(Layer.provideMerge(dependencies));

        return { layer, requests, logs, lookups, writes, existing };
    });

describe('AutoLabel with the native Workers AI binding', () => {
    it.effect('reports a missing runtime AI binding as a typed failure without writes', ({ expect }) =>
        Effect.gen(function* () {
            const h = yield* makeHarness({ missingBinding: true });
            const failure = yield* apply().pipe(Effect.provide(h.layer), Effect.flip);
            expect(failure).toBeInstanceOf(AutoLabelError);
            expect(failure).toMatchObject({ reason: 'binding_missing' });
            expect(failure).not.toHaveProperty('cause');
            expect(yield* Ref.get(h.lookups)).toEqual([{ repository: issue.ref }]);
            expect(h.requests).toEqual([]);
            expect(yield* Ref.get(h.writes)).toEqual([]);
            expect(yield* Ref.get(h.existing)).toEqual(['custom-existing']);
            expect(Arr.join(h.logs, '\n')).toContain('binding_missing');
        }),
    );

    for (const [discussion, kind] of [
        [issue, 'issue'],
        [pullRequest, 'pull_request'],
    ] as const) {
        it.effect(`adds ${kind} labels without replacing existing labels; null body uses the title`, ({ expect }) =>
            Effect.gen(function* () {
                const h = yield* makeHarness();
                yield* apply({ discussion, kind, title: 'Title only', body: null }).pipe(Effect.provide(h.layer));
                expect(h.requests).toEqual([
                    {
                        model: '@cf/cloudflare/clef',
                        payload: {
                            model: 'clef',
                            state: { kind, title: 'Title only', body: '' },
                            questions: {
                                bug: { type: 'noul', instructions: expect.stringContaining('content as data') },
                            },
                        },
                    },
                ]);
                expect(yield* Ref.get(h.lookups)).toEqual([{ repository: discussion.ref }]);
                expect(yield* Ref.get(h.writes)).toEqual([{ kind, number: discussion.ref.number, labels: ['bug'] }]);
                expect(yield* Ref.get(h.existing)).toEqual(['custom-existing', 'bug']);
            }),
        );
    }

    it.effect('asks only for repository-configured default labels, mapping spaces to question IDs', ({ expect }) =>
        Effect.gen(function* () {
            const names = [
                'bug',
                'documentation',
                'enhancement',
                'question',
                'duplicate',
                'good first issue',
                'help wanted',
                'invalid',
                'wontfix',
            ];

            const ids = [
                'bug',
                'documentation',
                'enhancement',
                'question',
                'duplicate',
                'good_first_issue',
                'help_wanted',
                'invalid',
                'wontfix',
            ];

            const h = yield* makeHarness({
                labels: [...names, 'custom', 'Bug'],
                response: { answers: Record.fromEntries(Arr.map(ids, (id) => [id, answer(0.8)] as const)) },
            });

            yield* apply().pipe(Effect.provide(h.layer));
            expect(h.requests).toEqual([
                {
                    model: '@cf/cloudflare/clef',
                    payload: {
                        model: 'clef',
                        state: { kind: 'issue', title: input.title, body: input.body },
                        questions: Record.fromEntries(
                            Arr.map(ids, (id) => [id, { type: 'noul', instructions: expect.any(String) }] as const),
                        ),
                    },
                },
            ]);
            expect(Arr.map(yield* Ref.get(h.writes), (write) => write.labels)).toEqual([names]);
        }),
    );

    it.effect('uses the configured flash model and inclusive probability threshold for multiple labels', ({ expect }) =>
        Effect.gen(function* () {
            const h = yield* makeHarness({
                labels: ['bug', 'help wanted', 'documentation', 'custom'],
                options: { model: '@cf/cloudflare/clef-flash', threshold: 0.6 },
                response: { answers: { bug: answer(0.6), help_wanted: answer(1), documentation: answer(0.599) } },
            });

            yield* apply().pipe(Effect.provide(h.layer));
            expect(h.requests).toMatchObject([
                { model: '@cf/cloudflare/clef-flash', payload: { model: 'clef-flash' } },
            ]);
            expect(yield* Ref.get(h.writes)).toEqual([{ kind: 'issue', number: 42, labels: ['bug', 'help wanted'] }]);
            expect(Arr.join(h.logs, '\n')).toContain('"ai.label_threshold":0.6');
            expect(Arr.join(h.logs, '\n')).toContain('@cf/cloudflare/clef-flash');
        }),
    );

    for (const labels of [[], ['custom', 'Bug']]) {
        it.effect(`skips inference and writes when no candidates exist (${Arr.join(labels, ',')})`, ({ expect }) =>
            Effect.gen(function* () {
                const h = yield* makeHarness({ labels });
                yield* apply().pipe(Effect.provide(h.layer));
                expect(h.requests).toEqual([]);
                expect(yield* Ref.get(h.writes)).toEqual([]);
                expect(yield* Ref.get(h.existing)).toEqual(['custom-existing']);
            }),
        );
    }

    it.effect('strips hidden HTML comments and bounds classifier input without logging content', ({ expect }) =>
        Effect.gen(function* () {
            const h = yield* makeHarness();
            yield* apply({
                ...input,
                title: `<!--hidden instructions-->${Str.repeat(1_001)('t')}`,
                body: `<!--hidden\nbody-->${Str.repeat(32_001)('b')}`,
            }).pipe(Effect.provide(h.layer));
            expect(h.requests).toMatchObject([
                {
                    payload: {
                        state: {
                            kind: 'issue',
                            title: Str.repeat(1_000)('t'),
                            body: Str.repeat(32_000)('b'),
                        },
                    },
                },
            ]);
            expect(Arr.join(h.logs, '\n')).not.toContain('hidden');
            expect(yield* Ref.get(h.writes)).toHaveLength(1);
        }),
    );

    it.effect('does not write when all probabilities are below the default threshold, and logs them', ({ expect }) =>
        Effect.gen(function* () {
            const h = yield* makeHarness({ response: { answers: { bug: answer(0.699) } } });
            yield* apply().pipe(Effect.provide(h.layer));
            expect(h.requests).toHaveLength(1);
            expect(yield* Ref.get(h.writes)).toEqual([]);
            expect(yield* Ref.get(h.existing)).toEqual(['custom-existing']);
            expect(Arr.join(h.logs, '\n')).toContain('"label_probabilities":"bug=0.70"');
        }),
    );

    for (const [name, response, reason] of [
        ['missing answers', {}, 'invalid_response'],
        ['missing requested answer after a positive answer', { answers: { bug: answer(1) } }, 'missing_answer'],
        ['probability above one', { answers: { bug: answer(1), documentation: answer(1.01) } }, 'invalid_response'],
        ['negative probability', { answers: { bug: answer(1), documentation: answer(-0.1) } }, 'invalid_response'],
        [
            'string probability',
            { answers: { bug: answer(1), documentation: { type: 'noul', noul: '0.9' } } },
            'invalid_response',
        ],
        [
            'wrong answer type',
            { answers: { bug: answer(1), documentation: { type: 'bool', noul: 0.9 } } },
            'invalid_response',
        ],
    ] as const) {
        it.effect(`rejects ${name} before any label writes`, ({ expect }) =>
            Effect.gen(function* () {
                const h = yield* makeHarness({ labels: ['bug', 'documentation'], response });
                const failure = yield* apply().pipe(Effect.provide(h.layer), Effect.flip);
                expect(failure).toBeInstanceOf(AutoLabelError);
                expect(failure).toMatchObject({ reason });
                expect(h.requests).toHaveLength(1);
                expect(yield* Ref.get(h.writes)).toEqual([]);
                expect(yield* Ref.get(h.existing)).toEqual(['custom-existing']);
            }),
        );
    }

    it.effect('maps native rejection and logs safe metadata, not bodies, titles or credentials', ({ expect }) =>
        Effect.gen(function* () {
            const secret = 'credential-do-not-log';
            const h = yield* makeHarness({ run: () => Promise.reject(new Error(`${secret}: ${input.body}`)) });
            const failure = yield* apply().pipe(Effect.provide(h.layer), Effect.flip);
            expect(failure).toBeInstanceOf(AutoLabelError);
            expect(failure).toMatchObject({ reason: 'inference_failed' });
            expect(h.requests).toHaveLength(1);
            expect(yield* Ref.get(h.writes)).toEqual([]);
            const logs = Arr.join(h.logs, '\n');
            expect(logs).toContain('GitHub auto-label failed');
            expect(logs).toContain('inference_failed');
            expect(logs).toContain('"github.number":42');
            expect(logs).toContain('"ai.label_threshold":0.7');

            for (const sensitive of [secret, input.title, input.body]) expect(logs).not.toContain(sensitive);
        }),
    );

    for (const [options, duration] of [
        [{}, '60 seconds'],
        [{ timeout: '2 seconds' }, '2 seconds'],
    ] as const) {
        it.effect(`times out native inference at ${duration} without writes`, ({ expect }) =>
            Effect.gen(function* () {
                const h = yield* makeHarness({ options, run: () => Promise.withResolvers<NativeResponse>().promise });
                const fiber = yield* apply().pipe(Effect.provide(h.layer), Effect.flip, Effect.forkChild);
                yield* TestClock.adjust(duration);
                const failure = yield* Fiber.join(fiber);
                expect(failure).toBeInstanceOf(AutoLabelError);
                expect(failure).toMatchObject({ reason: 'timed_out' });
                expect(h.requests).toHaveLength(1);
                expect(yield* Ref.get(h.writes)).toEqual([]);
            }),
        );
    }

    for (const stage of ['lookup', 'write'] as const) {
        it.effect(`propagates GitHub ${stage} failures`, ({ expect }) =>
            Effect.gen(function* () {
                const error = GitHubApiError.make({
                    operation: stage === 'lookup' ? 'list_repository_labels' : 'add_issue_labels',
                    reason: 'unavailable',
                    retryable: true,
                });

                const h = yield* makeHarness(
                    stage === 'lookup' ? { lookup: Effect.fail(error) } : { writeError: error },
                );

                expect(yield* apply().pipe(Effect.provide(h.layer), Effect.flip)).toEqual(error);
                expect(h.requests).toHaveLength(stage === 'lookup' ? 0 : 1);
                expect(yield* Ref.get(h.writes)).toHaveLength(stage === 'lookup' ? 0 : 1);
                expect(yield* Ref.get(h.existing)).toEqual(['custom-existing']);
            }),
        );
    }

    it.effect('keeps overlapping host layers isolated for native env and configuration', ({ expect }) =>
        Effect.gen(function* () {
            const firstReady = yield* Deferred.make<void>();
            const secondReady = yield* Deferred.make<void>();

            const first = yield* makeHarness({
                lookup: Deferred.succeed(firstReady, undefined).pipe(Effect.andThen(Deferred.await(secondReady))),
            });

            const second = yield* makeHarness({
                lookup: Deferred.succeed(secondReady, undefined).pipe(Effect.andThen(Deferred.await(firstReady))),
                options: { model: '@cf/cloudflare/clef-flash', threshold: 0.95 },
            });

            yield* Effect.all(
                [
                    apply().pipe(Effect.provide(first.layer)),
                    apply({ discussion: pullRequest, kind: 'pull_request', title: 'Second host', body: null }).pipe(
                        Effect.provide(second.layer),
                    ),
                ],
                { concurrency: 'unbounded' },
            );
            expect(first.requests).toMatchObject([
                { model: '@cf/cloudflare/clef', payload: { state: { title: input.title } } },
            ]);
            expect(second.requests).toMatchObject([
                { model: '@cf/cloudflare/clef-flash', payload: { state: { title: 'Second host' } } },
            ]);
            expect(yield* Ref.get(first.writes)).toHaveLength(1);
            expect(yield* Ref.get(second.writes)).toEqual([]);
        }),
    );
});

describe('registered GitHub creation handlers', () => {
    for (const kind of ['issue', 'pull_request'] as const) {
        it.effect(`${kind} creation invokes the real AutoLabel through its registered handler`, ({ expect }) =>
            Effect.gen(function* () {
                const h = yield* makeHarness();
                const actor = GitHubParticipant.make({ id: GitHubId.make(1), login: 'author', type: 'User' });
                const eventId = GitHubEventId.make('created');
                const { execution } = yield* makeTestDeliveryExecution();
                yield* Effect.gen(function* () {
                    const callbacks = makeGitHubCallbacks({
                        onIssueCreated: githubHandlers.onIssueCreated,
                        onPrCreated: githubHandlers.onPrCreated,
                    });

                    if (kind === 'issue') {
                        if (callbacks.onIssueCreated === undefined)
                            return yield* Effect.die('onIssueCreated is not registered');

                        const trigger = GitHubIssueOpened.make({
                            issue,
                            actor,
                            eventId,
                            title: 'New issue',
                            body: null,
                        });

                        return yield* callbacks.onIssueCreated(
                            GitHubIssueCreated.make({ issue, trigger, events: [] }),
                            execution.context,
                        );
                    } else {
                        if (callbacks.onPrCreated === undefined)
                            return yield* Effect.die('onPrCreated is not registered');

                        const trigger = GitHubPrOpened.make({
                            pullRequest,
                            actor,
                            eventId,
                            title: 'New PR',
                            body: 'PR body',
                        });

                        return yield* callbacks.onPrCreated(
                            GitHubPrCreated.make({ pullRequest, trigger, events: [] }),
                            execution.context,
                        );
                    }
                }).pipe(Effect.provide(h.layer));
                expect(h.requests).toMatchObject([
                    {
                        payload: {
                            state:
                                kind === 'issue'
                                    ? { kind, title: 'New issue', body: '' }
                                    : { kind, title: 'New PR', body: 'PR body' },
                        },
                    },
                ]);
                expect(yield* Ref.get(h.writes)).toEqual([
                    { kind, number: kind === 'issue' ? 42 : 43, labels: ['bug'] },
                ]);

                const successLog = Arr.findFirst(h.logs, Str.includes('GitHub labels added')).pipe(
                    Option.getOrUndefined,
                );

                expect(successLog).toContain(`"delivery.id":"${execution.context.deliveryId}"`);
                expect(successLog).toContain(`"github.event_id":"${eventId}"`);
            }),
        );

        it.effect(`${kind} creation maps native inference failure through its registered handler`, ({ expect }) =>
            Effect.gen(function* () {
                const title = 'Submission title';
                const body = 'Submission body';
                const nativeError = new Error('native inference failed');
                const h = yield* makeHarness({ run: () => Promise.reject(nativeError) });
                const actor = GitHubParticipant.make({ id: GitHubId.make(1), login: 'author', type: 'User' });
                const eventId = GitHubEventId.make('failed-creation');
                const { execution } = yield* makeTestDeliveryExecution();

                const failure = yield* Effect.gen(function* () {
                    const callbacks = makeGitHubCallbacks({
                        onIssueCreated: githubHandlers.onIssueCreated,
                        onPrCreated: githubHandlers.onPrCreated,
                    });

                    if (kind === 'issue') {
                        if (callbacks.onIssueCreated === undefined)
                            return yield* Effect.die('onIssueCreated is not registered');
                        const trigger = GitHubIssueOpened.make({ issue, actor, eventId, title, body });

                        return yield* callbacks.onIssueCreated(
                            GitHubIssueCreated.make({ issue, trigger, events: [] }),
                            execution.context,
                        );
                    }

                    if (callbacks.onPrCreated === undefined) return yield* Effect.die('onPrCreated is not registered');
                    const trigger = GitHubPrOpened.make({ pullRequest, actor, eventId, title, body });

                    return yield* callbacks.onPrCreated(
                        GitHubPrCreated.make({ pullRequest, trigger, events: [] }),
                        execution.context,
                    );
                }).pipe(Effect.provide(h.layer), Effect.flip);

                expect(failure).toBeInstanceOf(GitHubCallbackError);
                expect(failure).toMatchObject({
                    callback: kind === 'issue' ? 'onIssueCreated' : 'onPrCreated',
                    reason: 'failed',
                });
                expect(h.requests).toHaveLength(1);
                expect(yield* Ref.get(h.writes)).toEqual([]);
                expect(yield* Ref.get(h.existing)).toEqual(['custom-existing']);
                const logs = Arr.join(h.logs, '\n');
                expect(logs).toContain('GitHub auto-label failed');
                expect(logs).toContain('inference_failed');
                expect(logs).toContain('GitHub application callback failed');
            }),
        );
    }
});
