import type { AssistantMessageLogEntry, LogEntry, FoldModel, UserMessageLogEntry } from '@stegosaurus/fold-core';
import { encodedContentText, languageModelLayerFor } from '@stegosaurus/fold-core';
import { Array as Arr, Predicate, Effect, Option, Schema, String as Str, pipe, type Scope } from 'effect';
import { LanguageModel } from 'effect/ai';

const TitleResult = Schema.Struct({ title: Schema.String });

const MAX_TRANSCRIPT_CHARS = 12_000;

type MessageEntry = UserMessageLogEntry | AssistantMessageLogEntry;

const isMessageEntry = (entry: LogEntry): entry is MessageEntry =>
    Predicate.isTagged(entry, 'user-message') || Predicate.isTagged(entry, 'assistant-message');

const messageText = (entry: LogEntry): string =>
    isMessageEntry(entry) ? encodedContentText(entry.message.content) : '';

/** Normalize model output to a single, safe title of at most six words. */
export const normalizeSessionTitle = (title: string): string =>
    pipe(
        title,
        Str.replace(/[\r\n]+/g, ' '),
        Str.replace(/^[\s"'`]+|[\s"'`]+$/g, ''),
        Str.replace(/\s+/g, ' '),
        Str.split(' '),
        Arr.filter(Str.isNonEmpty),
        Arr.take(6),
        Arr.join(' '),
    );

export const fallbackSessionTitle = (entries: ReadonlyArray<LogEntry>, rootAgentId: string): string => {
    const first = Arr.findFirst(
        entries,
        (entry) => Predicate.isTagged(entry, 'user-message') && entry.agentId === rootAgentId,
    );

    return normalizeSessionTitle(Option.match(first, { onNone: () => '', onSome: messageText })) || 'Untitled session';
};

/** Root user/assistant text only, bounded from the oldest root turn forward. */
export const titleTranscript = (entries: ReadonlyArray<LogEntry>, rootAgentId: string): string =>
    pipe(
        entries,
        Arr.flatMap((entry) =>
            entry.agentId === rootAgentId &&
            (Predicate.isTagged(entry, 'user-message') || Predicate.isTagged(entry, 'assistant-message'))
                ? [`${Predicate.isTagged(entry, 'user-message') ? 'User' : 'Assistant'}: ${messageText(entry)}`]
                : [],
        ),
        Arr.join('\n'),
        Str.slice(0, MAX_TRANSCRIPT_CHARS),
    );

/** One unlogged structured generation call. Callers persist only the resulting session_title event. */
export const generateSessionTitle = <R>(
    entries: ReadonlyArray<LogEntry>,
    rootAgentId: string,
    model: FoldModel<R>,
): Effect.Effect<string, never, Exclude<R, Scope.Scope>> => {
    const fallback = fallbackSessionTitle(entries, rootAgentId);
    const transcript = titleTranscript(entries, rootAgentId);

    if (transcript.length === 0) return Effect.succeed(fallback);

    return LanguageModel.generateObject({
        schema: TitleResult,
        prompt:
            'Create a concise title of at most six words for this coding session. Return only the structured title.\n\n' +
            transcript,
    }).pipe(
        Effect.provide(languageModelLayerFor(model)),
        Effect.map((response) => normalizeSessionTitle(response.value.title) || fallback),
        Effect.catchCause(() => Effect.succeed(fallback)),
    );
};
