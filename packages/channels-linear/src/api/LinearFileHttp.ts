import { Effect } from 'effect';
import type { HttpClientResponse } from 'effect/http/HttpClientResponse';

import type { LinearApiOperation } from '../LinearApiContract';
import {
    LinearAuthenticationError,
    LinearFileTransferRejectedError,
    LinearForbiddenError,
    LinearRateLimitedError,
    LinearResourceNotFoundError,
    LinearUnavailableError,
    linearProviderErrorDetails,
} from './LinearApiErrors';

const parseRetryAfterMs = (value: string | undefined) => {
    if (value === undefined || !/^\d+$/.test(value)) return null;
    const milliseconds = Number(value) * 1_000;

    return Number.isSafeInteger(milliseconds) ? milliseconds : null;
};

/**
 * Classifies a non-redirect file transfer response. Authentication and access statuses are only credential failures
 * when the request carried the workspace credential; for signed or unauthenticated targets they are rejections.
 */
export const inspectLinearFileResponse = (
    operation: LinearApiOperation,
    response: HttpClientResponse,
    credentialed: boolean,
) => {
    const status = response.status;

    if (status >= 200 && status < 300) return Effect.succeed(response);

    if (credentialed && status === 401)
        return Effect.fail(LinearAuthenticationError.make(linearProviderErrorDetails(operation, { status })));

    if (credentialed && status === 403)
        return Effect.fail(LinearForbiddenError.make(linearProviderErrorDetails(operation, { status })));

    if (status === 404)
        return Effect.fail(LinearResourceNotFoundError.make(linearProviderErrorDetails(operation, { status })));

    if (status === 429)
        return Effect.fail(
            LinearRateLimitedError.make(
                linearProviderErrorDetails(operation, {
                    status,
                    retryable: true,
                    retryAfterMs: parseRetryAfterMs(response.headers['retry-after']),
                }),
            ),
        );

    if (status >= 500)
        return Effect.fail(
            LinearUnavailableError.make(linearProviderErrorDetails(operation, { status, retryable: true })),
        );

    return Effect.fail(LinearFileTransferRejectedError.make(linearProviderErrorDetails(operation, { status })));
};
