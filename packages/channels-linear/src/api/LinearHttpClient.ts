import { Context, Effect, Layer, Redacted } from 'effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpClient from 'effect/http/HttpClient';
import type { HttpClientRequest } from 'effect/http/HttpClientRequest';
import * as HttpClientRequestModule from 'effect/http/HttpClientRequest';
import type { HttpClientResponse } from 'effect/http/HttpClientResponse';

import type { LinearApiError, LinearApiOperation } from '../LinearApiContract';
import { LinearCredentialResolver } from '../LinearCredential';
import { isLinearFileOrigin } from '../LinearFileModels';
import type { LinearOrganizationId } from '../LinearIdentity';
import { LinearFileOriginRejectedError, LinearTransportError, linearProviderErrorDetails } from './LinearApiErrors';

export type LinearHttpRequest = {
    readonly operation: LinearApiOperation;
    readonly request: HttpClientRequest;
};

type LinearHttpClientOperations = {
    readonly organizationId: LinearOrganizationId;
    readonly canRefresh: boolean;
    readonly invalidateCredential: Effect.Effect<void>;
    readonly execute: (
        input: LinearHttpRequest,
    ) => Effect.Effect<HttpClientResponse, LinearTransportError | LinearApiError>;
    /**
     * Sends one absolute HTTPS file request without following redirects or recording its URL in client spans. The
     * bearer credential is attached only when the request targets the approved Linear upload origin.
     */
    readonly executeFile: (
        input: LinearHttpRequest,
    ) => Effect.Effect<HttpClientResponse, LinearTransportError | LinearFileOriginRejectedError | LinearApiError>;
};

export type LinearFixedCredentialOptions = {
    readonly organizationId: LinearOrganizationId;
    readonly accessToken: Redacted.Redacted;
};

const executeAuthenticated = (
    client: HttpClient.HttpClient,
    accessToken: Redacted.Redacted,
    input: LinearHttpRequest,
) =>
    client
        .pipe(
            HttpClient.mapRequest(HttpClientRequestModule.prependUrl('https://api.linear.app')),
            HttpClient.mapRequest(HttpClientRequestModule.bearerToken(accessToken)),
            HttpClient.mapRequest(HttpClientRequestModule.acceptJson),
        )
        .execute(input.request)
        .pipe(
            Effect.mapError(() =>
                LinearTransportError.make(linearProviderErrorDetails(input.operation, { retryable: true })),
            ),
            Effect.withSpan('linear.http_request', {
                attributes: { 'linear.operation': input.operation, method: input.request.method },
            }),
        );

const sendFileRequest = (client: HttpClient.HttpClient, input: LinearHttpRequest) =>
    client.execute(input.request).pipe(
        Effect.mapError(() =>
            LinearTransportError.make(linearProviderErrorDetails(input.operation, { retryable: true })),
        ),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: 'manual' }),
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        Effect.withSpan('linear.file_request', {
            attributes: { 'linear.operation': input.operation, method: input.request.method },
        }),
    );

const executeFileRequest = (
    client: HttpClient.HttpClient,
    accessToken: Effect.Effect<Redacted.Redacted, LinearApiError>,
    input: LinearHttpRequest,
): Effect.Effect<HttpClientResponse, LinearTransportError | LinearFileOriginRejectedError | LinearApiError> => {
    const url = input.request.url;

    if (!URL.canParse(url) || new URL(url).protocol !== 'https:')
        return Effect.fail(LinearFileOriginRejectedError.make(linearProviderErrorDetails(input.operation)));

    if (!isLinearFileOrigin(url)) return sendFileRequest(client, input);

    return accessToken.pipe(
        Effect.flatMap((token) =>
            sendFileRequest(client, {
                operation: input.operation,
                request: HttpClientRequestModule.bearerToken(input.request, token),
            }),
        ),
    );
};

/** Sends one Linear API request with whatever token `accessToken` yields. */
const executeApiRequest = (
    client: HttpClient.HttpClient,
    accessToken: Effect.Effect<Redacted.Redacted, LinearApiError>,
    input: LinearHttpRequest,
): Effect.Effect<HttpClientResponse, LinearTransportError | LinearApiError> =>
    accessToken.pipe(Effect.flatMap((token) => executeAuthenticated(client, token, input)));

/** A transport sending through `client` with whatever token `accessToken` yields. */
const transportOperations = (
    client: HttpClient.HttpClient,
    accessToken: Effect.Effect<Redacted.Redacted, LinearApiError>,
): Pick<LinearHttpClientOperations, 'execute' | 'executeFile'> => ({
    execute: (input) => executeApiRequest(client, accessToken, input),
    executeFile: (input) => executeFileRequest(client, accessToken, input),
});

/**
 * One organization-scoped, bearer-authenticated transport for Linear API operations, sending through
 * `HttpClient`. The layer takes its credentials from `LinearCredentialResolver`; `layerFixedCredential` always
 * sends one known token and cannot refresh.
 */
export class LinearHttpClient extends Context.Service<LinearHttpClient, LinearHttpClientOperations>()(
    '@stegosaurus/channels-linear/api/LinearHttpClient',
    {
        make: Effect.gen(function* () {
            const credentials = yield* LinearCredentialResolver;
            const client = yield* HttpClient.HttpClient;

            const accessToken = credentials.resolve.pipe(Effect.map((credential) => credential.accessToken));

            const operations: LinearHttpClientOperations = {
                organizationId: credentials.organizationId,
                canRefresh: credentials.canRefresh,
                invalidateCredential: credentials.invalidate,
                ...transportOperations(client, accessToken),
            };

            return operations;
        }),
    },
) {
    static readonly layer = Layer.effect(this, this.make);

    /** A transport that always sends one known token, through the `HttpClient` in context. It cannot refresh. */
    /** A transport that always sends one known token through `client`. It cannot refresh. */
    static readonly fixedCredential = (
        client: HttpClient.HttpClient,
        options: LinearFixedCredentialOptions,
    ): LinearHttpClientOperations => ({
        organizationId: options.organizationId,
        canRefresh: false,
        invalidateCredential: Effect.void,
        ...transportOperations(client, Effect.succeed(options.accessToken)),
    });

    static readonly makeFixedCredential = (options: LinearFixedCredentialOptions) =>
        Effect.map(HttpClient.HttpClient, (client) => LinearHttpClient.fixedCredential(client, options));

    static readonly layerFixedCredential = (options: LinearFixedCredentialOptions) =>
        Layer.effect(this, this.makeFixedCredential(options));
}
