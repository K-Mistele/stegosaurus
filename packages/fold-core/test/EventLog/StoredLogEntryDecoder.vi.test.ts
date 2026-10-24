import { it, expect } from '@effect/vitest';
import { Effect, Predicate } from 'effect';

import {
    AgentId,
    CURRENT_LOG_ENTRY_VERSION,
    EventId,
    EventLogUnsupportedVersionError,
    OpenAiReasoningWithEffort,
    SessionId,
    SUPPORTED_LOG_ENTRY_VERSIONS,
    decodeStoredLogEntry,
} from '../../src/index';

type SessionStartedEntryBuilder = {
    // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-type -- raw on-disk JSON fixture; a constructor would build the decoded shape
    _tag: 'session_started';
    seq: number;
    eventId: ReturnType<typeof EventId.create>;
    ts: number;
    version?: number;
    agentId: null;
    parentAgentId: null;
    toolCallId: null;
    cwd: string;
    sessionId: ReturnType<typeof SessionId.create>;
    rootAgentId: ReturnType<typeof AgentId.create>;
    meta: Record<string, never>;
};

const sessionStartedEntry = (version: number | undefined) => {
    const entry: SessionStartedEntryBuilder = {
        // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- raw on-disk JSON fixture; a constructor would build the decoded shape
        _tag: 'session_started',
        seq: 0,
        eventId: EventId.create(),
        ts: 1,
        agentId: null,
        parentAgentId: null,
        toolCallId: null,
        cwd: '/tmp/fold',
        sessionId: SessionId.create(),
        rootAgentId: AgentId.create(),
        meta: {},
    };

    if (version !== undefined) {
        entry.version = version;
    }

    return entry;
};

const legacySessionTitleEntry = () => ({
    // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- raw on-disk JSON fixture; a constructor would build the decoded shape
    _tag: 'session_title',
    seq: 1,
    eventId: EventId.create(),
    ts: 2,
    agentId: null,
    parentAgentId: null,
    toolCallId: null,
    title: 'Legacy session',
});

it.effect('decodes the current persisted event format', () =>
    Effect.gen(function* () {
        const entry = yield* decodeStoredLogEntry(sessionStartedEntry(CURRENT_LOG_ENTRY_VERSION));

        expect(entry.version).toBe(CURRENT_LOG_ENTRY_VERSION);
        expect(SUPPORTED_LOG_ENTRY_VERSIONS).toEqual([CURRENT_LOG_ENTRY_VERSION]);
    }),
);

it.effect('upcasts entries written before per-entry versioning to v1', () =>
    Effect.gen(function* () {
        const entry = yield* decodeStoredLogEntry(legacySessionTitleEntry());

        expect(entry.version).toBe(1);
        expect(entry._tag).toBe('session_title');
    }),
);

it.effect('decodes existing OpenAI agent entries without reasoning summary configuration', () =>
    Effect.gen(function* () {
        const entry = yield* decodeStoredLogEntry({
            // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- raw on-disk JSON fixture; a constructor would build the decoded shape
            _tag: 'agent_started',
            version: CURRENT_LOG_ENTRY_VERSION,
            seq: 1,
            eventId: EventId.create(),
            ts: 2,
            agentId: AgentId.create(),
            parentAgentId: null,
            toolCallId: null,
            mode: 'fresh',
            model: {
                providerId: 'openai',
                providerKind: 'openai-compatible',
                modelId: 'gpt-5.5',
                role: null,
                requestedReasoningLevel: 'medium',
                reasoning: OpenAiReasoningWithEffort.make({ effort: 'medium' }),
            },
            tools: [],
            skill: null,
            fork: null,
            agentType: null,
        });

        expect(entry._tag).toBe('agent_started');

        if (!Predicate.isTagged(entry, 'agent_started')) return;
        expect(entry.model.providerKind).toBe('openai-compatible');

        if (entry.model.providerKind !== 'openai-compatible') return;
        expect(entry.model.reasoningSummary).toBeUndefined();
    }),
);

it.effect('rejects an unsupported event format without guessing its schema', () =>
    Effect.gen(function* () {
        const error = yield* decodeStoredLogEntry(sessionStartedEntry(2)).pipe(Effect.flip);

        expect(error).toBeInstanceOf(EventLogUnsupportedVersionError);

        if (Predicate.isTagged(error, 'EventLogUnsupportedVersionError')) {
            expect(error.version).toBe(2);
            expect(error.seq).toBe(0);
            expect(error.supportedVersions).toEqual([1]);
        }
    }),
);
