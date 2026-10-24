import { NodeCrypto } from '@effect/platform-node';
import { describe, it } from '@effect/vitest';
import { webhookRoutes } from '@stegosaurus/channels-delivery/ProviderWebhooks';
import { DeliveryReceipt, MailboxDelivery } from '@stegosaurus/channels-delivery/MailboxDelivery';
import { Clock, Context, Effect, Redacted, String as Str } from 'effect';
import { HttpRouter } from 'effect/http';

import { makeLinearWebhookProvider } from '../src/LinearWebhookProvider';
import {
    issueCreatePayload,
    linearAppUserId,
    linearOauthClientId,
    linearOrganizationId,
    linearWebhookSecret,
    signedLinearInput,
} from './fixtures';

const makeApp = Effect.gen(function* () {
    const provider = makeLinearWebhookProvider({
        namespace: 'linear-routing-test',
        webhookSecret: Redacted.make(linearWebhookSecret),
        organizationId: linearOrganizationId,
        appUserId: linearAppUserId,
        oauthClientId: linearOauthClientId,
        maxBodyBytes: 4096,
    });

    const web = HttpRouter.toWebHandler(
        webhookRoutes([provider], {}).pipe(HttpRouter.provideRequest(NodeCrypto.layer)),
        {
            disableLogger: true,
        },
    );

    yield* Effect.addFinalizer(() => Effect.promise(web.dispose));

    const context = Context.make(
        MailboxDelivery,
        MailboxDelivery.of({
            deliver: (admission) =>
                Effect.succeed(DeliveryReceipt.make({ mailboxKey: admission.resourceId, accepted: true })),
        }),
    );

    return (input: ReturnType<typeof signedLinearInput>) =>
        Effect.promise(() =>
            web.handler(
                new Request('http://localhost/integrations/linear/webhook', {
                    method: 'POST',
                    headers: input.headers,
                    body: new TextDecoder().decode(input.body),
                }),
                context,
            ),
        );
});

describe('Linear webhook routing', () => {
    it.live('maps accepted, unauthenticated, mismatched, and oversized requests', ({ expect }) =>
        Effect.gen(function* () {
            const request = yield* makeApp;
            const now = yield* Clock.currentTimeMillis;
            expect((yield* request(signedLinearInput(issueCreatePayload, 'Issue', undefined, now))).status).toBe(200);

            const signed = signedLinearInput(issueCreatePayload, 'Issue', undefined, now);

            const invalid = {
                ...signed,
                headers: { ...signed.headers, 'linear-signature': Str.repeat(64)('0') },
            };

            expect((yield* request(invalid)).status).toBe(401);

            const mismatch = { ...issueCreatePayload, organizationId: 'another-workspace' };
            expect((yield* request(signedLinearInput(mismatch, 'Issue', undefined, now))).status).toBe(403);

            const oversized = { ...issueCreatePayload, padding: Str.repeat(8192)('x') };
            expect((yield* request(signedLinearInput(oversized, 'Issue', undefined, now))).status).toBe(413);
        }),
    );
});
