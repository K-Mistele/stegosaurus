import { Context, Effect, Layer, pipe, Redacted, Result, Schema, String as Str } from 'effect';
import { Base64, Base64Url } from 'effect/encoding';

export class GitHubSigningError extends Schema.TaggedError<GitHubSigningError, { readonly brand: unique symbol }>()(
    'GitHubSigningError',
    {},
) {}

/** Package-private signing seam. `layer` signs with Web Crypto; tests replace it with their own Layer. */
export class GitHubAppSigner extends Context.Service<
    GitHubAppSigner,
    {
        readonly sign: (input: {
            readonly privateKey: Redacted.Redacted;
            readonly data: string;
        }) => Effect.Effect<string, GitHubSigningError>;
    }
>()('@stegosaurus/channels-github/api/GitHubAppSigner', {
    make: Effect.sync(() => {
        const encoder = new TextEncoder();

        return {
            sign: Effect.fn('github.app_signer.sign')(function* ({ privateKey, data }) {
                const bytes = yield* privateKeyBytes(Redacted.value(privateKey));

                const key = yield* Effect.tryPromise({
                    try: () =>
                        globalThis.crypto.subtle.importKey(
                            'pkcs8',
                            bytes,
                            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
                            false,
                            ['sign'],
                        ),
                    catch: () => GitHubSigningError.make({}),
                });

                const signature = yield* Effect.tryPromise({
                    try: () => globalThis.crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(data)),
                    catch: () => GitHubSigningError.make({}),
                });

                return Base64Url.encode(new Uint8Array(signature));
            }),
        };
    }),
}) {
    static readonly layer = Layer.effect(this, this.make);
}

const pemWhitespace = /\s/g;

const der = (tag: number, bytes: Uint8Array): Uint8Array<ArrayBuffer> => {
    let length: ReadonlyArray<number>;

    if (bytes.length < 128) length = [bytes.length];
    else if (bytes.length < 256) length = [0x81, bytes.length];
    else length = [0x82, bytes.length >> 8, bytes.length & 255];

    return new Uint8Array([tag, ...length, ...bytes]);
};

const privateKeyBytes = (pem: string): Effect.Effect<Uint8Array<ArrayBuffer>, GitHubSigningError> => {
    const pkcs1 = Str.startsWith('-----BEGIN RSA PRIVATE KEY-----')(pem);
    let label = 'PRIVATE KEY';

    if (pkcs1) label = 'RSA PRIVATE KEY';

    if (!Str.startsWith(`-----BEGIN ${label}-----`)(pem) || !Str.endsWith(`-----END ${label}-----`)(Str.trimEnd(pem))) {
        return Effect.fail(GitHubSigningError.make({}));
    }

    return Base64.decode(
        pipe(
            pem,
            Str.replace(`-----BEGIN ${label}-----`, ''),
            Str.replace(`-----END ${label}-----`, ''),
            Str.replace(pemWhitespace, ''),
        ),
    ).pipe(
        Result.map((bytes) => (pkcs1 ? pkcs1ToPkcs8(bytes) : new Uint8Array(bytes))),
        Result.mapError(() => GitHubSigningError.make({})),
        Effect.fromResult,
    );
};

const pkcs1ToPkcs8 = (bytes: Uint8Array) =>
    der(
        0x30,
        new Uint8Array([
            0x02,
            0x01,
            0x00,
            0x30,
            0x0d,
            0x06,
            0x09,
            0x2a,
            0x86,
            0x48,
            0x86,
            0xf7,
            0x0d,
            0x01,
            0x01,
            0x01,
            0x05,
            0x00,
            ...der(0x04, bytes),
        ]),
    );
