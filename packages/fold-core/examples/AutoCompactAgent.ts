/**
 * Auto-compaction example against a real OpenAI-compatible API (D11): the agent runs with
 * `autoCompact` enabled and a deliberately tiny `contextWindow` override, so the first exchange's
 * reported usage crosses the threshold and the second send opens by compacting - the old history is
 * summarized with pi's checkpoint template (on this same model), a durable `compaction` entry lands
 * in the log, and the session keeps running against the summary plus the kept tail.
 *
 * In production you would omit `contextWindow` (limits come from the built-in per-model table) and
 * compaction would fire near the model's real limit instead.
 *
 * Run: OPENAI_API_KEY=... bun packages/fold-core/examples/AutoCompactAgent.ts
 */
import { Array as Arr, Cause, Config, Predicate, Console, Effect, String as Str } from 'effect';
import { FetchHttpClient } from 'effect/http';

import { defineAgent, openaiModel, Session, type CompactionLogEntry } from '../src/index';

/** A long-ish briefing so the first exchange alone exceeds the tiny demo window. */
const briefing = Str.repeat(3)(
    Arr.join(
        [
            'Project briefing for the demo, please read carefully.',
            'The release codename is TANGERINE-42 and the ship date is the third Thursday of next month.',
            'Architecture notes: the ingest service consumes from the `events.raw` topic, normalizes payloads',
            'through the schema registry, and writes to the `events.clean` table partitioned by day.',
            'Open issues: the dedupe window is too small (30s, should be 5m), retries are unbounded on the',
            'DLQ consumer, and the nightly backfill overlaps the compaction job on the warehouse.',
            'Decisions so far: we keep Kafka (rejected NATS for ecosystem reasons), we standardize on',
            'protobuf for the wire format, and we will NOT migrate the legacy `events_v1` table this quarter.',
            'Reminder: the on-call handbook lives at docs/oncall.md and the escalation contact is the',
            'platform channel. Historical context: v1 shipped two years ago, v2 was abandoned mid-flight.',
        ],
        ' ',
    ),
);

const makeProgram = (modelId: string, key: string) =>
    Effect.gen(function* () {
        const session = yield* Session.open({
            agent: defineAgent({
                name: 'auto-compact-demo',
                model: openaiModel({ model: modelId, apiKey: key }),
                systemPrompt: 'You are a concise assistant. Answer in at most two sentences.',
                autoCompact: {
                    enabled: true,
                    // Tiny window so the demo compacts on the second send; real agents omit this.
                    contextWindow: 1_200,
                },
            }),
        });

        yield* Console.log('send 1: the briefing (its reported usage will exceed the demo window)...');
        const first = yield* session.send(`${briefing}\n\nAcknowledge the briefing in one sentence.`);
        yield* Console.log(`  -> ${first.resultText ?? '(no text)'}`);

        yield* Console.log('send 2: compaction runs before this request, then the model answers...');
        const second = yield* session.send('What is the release codename? Answer from what you know.');
        yield* Console.log(`  -> ${second.resultText ?? '(no text)'}`);

        const entries = yield* session.entries;

        const compactions = Arr.filter(entries, (entry): entry is CompactionLogEntry =>
            Predicate.isTagged(entry, 'compaction'),
        );

        yield* Console.log(
            `\nlog: ${Arr.join(
                Arr.map(entries, (entry) => entry._tag),
                ' -> ',
            )}`,
        );

        const compaction = compactions[0];

        if (compaction === undefined) {
            yield* Console.log('no compaction happened - the model reported less usage than the demo window');

            return;
        }

        yield* Console.log(
            `\ncompaction entry: tokensBefore=${compaction.tokensBefore}, replacesThroughSeq=${compaction.replacesThroughSeq}`,
        );
        yield* Console.log(`summary (first 400 chars):\n${Str.slice(0, 400)(compaction.summary)}`);

        yield* Console.log('\nsend 3: the session keeps running on the compacted context...');
        const third = yield* session.send('And what were we told about the dedupe window?');
        yield* Console.log(`  -> ${third.resultText ?? '(no text)'}`);
    }).pipe(
        Effect.scoped,
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- entry point
        Effect.provide(FetchHttpClient.layer),
    );

const main = Effect.gen(function* () {
    const modelId = yield* Config.String('OPENAI_MODEL').pipe(Config.withDefault('gpt-5.5'));
    const apiKey = yield* Config.String('OPENAI_API_KEY').pipe(Config.withDefault(''));

    if (apiKey === '') {
        yield* Console.error('Set OPENAI_API_KEY to run this example.');
        process.exitCode = 1;

        return;
    }

    yield* makeProgram(modelId, apiKey);
}).pipe(
    Effect.catchCause((cause) =>
        Console.error(Cause.squash(cause)).pipe(
            Effect.andThen(
                Effect.sync(() => {
                    process.exitCode = 1;
                }),
            ),
        ),
    ),
);

Effect.runFork(main);
