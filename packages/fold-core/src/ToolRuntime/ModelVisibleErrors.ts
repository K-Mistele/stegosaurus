/**
 * This file owns the rendering of unexpected failures into short, model-visible text. Both tool
 * settlement (defect -> tool execution failure, D12/D16) and the Subagents seam (subagent defect ->
 * result with an error message, D21) narrow raw Causes through these helpers, so the model always sees
 * the same escaped, truncated, single-line description regardless of which boundary caught the defect.
 */
import { Cause, pipe, String as Str } from 'effect';

const maxModelVisibleErrorMessageLength = 300;

/** Wrap model-facing runtime commentary in the system-information envelope. */
export const systemInformation = (message: string): string => `<system-information>${message}</system-information>`;

/** Escape text embedded inside a system-information block. */
export const escapeSystemInformationContent = (message: string): string =>
    pipe(message, Str.replace(/&/g, '&amp;'), Str.replace(/</g, '&lt;'), Str.replace(/>/g, '&gt;'));

/** Collapse whitespace and cap the length of a model-visible error message. */
export const truncateModelVisibleErrorMessage = (message: string): string => {
    const singleLine = Str.trim(Str.replace(/\s+/g, ' ')(message));

    if (singleLine.length <= maxModelVisibleErrorMessageLength) return singleLine;

    return `${Str.slice(0, maxModelVisibleErrorMessageLength - 3)(singleLine)}...`;
};

/**
 * Render the first failure or defect of a Cause as safe model-visible text. Effect's own
 * `Cause.prettyErrors` turns each failure/defect into an Error (message kept, strings used as-is,
 * other values JSON-rendered), so no raw thrown value is inspected here. Interrupt-only and empty
 * causes carry no failure to show.
 */
export const modelVisibleErrorDetailsFromCause = <E>(cause: Cause.Cause<E>): string => {
    const first = Cause.hasInterruptsOnly(cause) ? undefined : Cause.prettyErrors(cause)[0];
    const message = first === undefined || first.message === '' ? 'unknown error' : first.message;

    return escapeSystemInformationContent(truncateModelVisibleErrorMessage(message));
};
