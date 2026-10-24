import { Schema } from 'effect';

/** EventLog operation names used in typed error payloads. */
export const EventLogOperation = Schema.Literals(['append', 'entries', 'subscribe']).annotate({
    identifier: 'EventLogOperation',
});

export type EventLogOperation = typeof EventLogOperation.Type;

/** Append input failed schema validation or violated a log invariant. */
export class EventLogInvalidEntryError extends Schema.TaggedError<
    EventLogInvalidEntryError,
    { readonly brand: unique symbol }
>()('EventLogInvalidEntryError', {
    operation: EventLogOperation,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
}) {}

/** The backing log store could not be read, written, or subscribed to. */
export class EventLogUnavailableError extends Schema.TaggedError<
    EventLogUnavailableError,
    { readonly brand: unique symbol }
>()('EventLogUnavailableError', {
    operation: EventLogOperation,
    message: Schema.String,
    retryable: Schema.Boolean,
    cause: Schema.optional(Schema.Defect()),
}) {}

/** Persisted log data could not be decoded or is internally inconsistent. */
export class EventLogCorruptEntryError extends Schema.TaggedError<
    EventLogCorruptEntryError,
    { readonly brand: unique symbol }
>()('EventLogCorruptEntryError', {
    operation: EventLogOperation,
    message: Schema.String,
    seq: Schema.optional(Schema.Finite),
    line: Schema.optional(Schema.Finite),
    cause: Schema.optional(Schema.Defect()),
}) {}

/** The persisted entry uses a format newer than this Fold runtime can safely interpret. */
export class EventLogUnsupportedVersionError extends Schema.TaggedError<
    EventLogUnsupportedVersionError,
    { readonly brand: unique symbol }
>()('EventLogUnsupportedVersionError', {
    operation: EventLogOperation,
    message: Schema.String,
    version: Schema.Int,
    seq: Schema.optional(Schema.Int),
    supportedVersions: Schema.Array(Schema.Int),
}) {}

/** Public EventLog error union. */
export type EventLogError =
    | EventLogInvalidEntryError
    | EventLogUnavailableError
    | EventLogCorruptEntryError
    | EventLogUnsupportedVersionError;
