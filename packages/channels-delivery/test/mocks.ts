import { Context, Effect } from 'effect';
import { HttpRouter } from 'effect/http';

import { webhookRoutes, type WebhookProvider } from '../src/ProviderWebhooks';
import { DeliveryReceipt, MailboxDelivery } from '../src/MailboxDelivery';

/**
 * Test MailboxDelivery that accepts every admission without storing it.
 */
export const noopMailboxDelivery: typeof MailboxDelivery.Service = {
    deliver: () =>
        Effect.succeed(
            DeliveryReceipt.make({
                mailboxKey: 'test-mailbox',
                accepted: true,
            }),
        ),
};

export const makeWebhookTestApp = (
    handle: WebhookProvider['handle'],
    options: {
        readonly mailboxDelivery?: typeof MailboxDelivery.Service;
        readonly maxBodyBytes?: number;
    } = {},
) =>
    Effect.gen(function* () {
        const { mailboxDelivery = noopMailboxDelivery, maxBodyBytes } = options;

        const provider: WebhookProvider = {
            providerName: 'example',
            maxBodyBytes,
            handle,
        };

        const web = HttpRouter.toWebHandler(webhookRoutes([provider], {}), { disableLogger: true });
        yield* Effect.addFinalizer(() => Effect.promise(web.dispose));
        const context = Context.make(MailboxDelivery, mailboxDelivery);

        return {
            post: (integration = provider.providerName, body: string | null = null) =>
                Effect.promise(() =>
                    web.handler(
                        new Request(`http://localhost/integrations/${integration}/webhook`, {
                            method: 'POST',
                            body,
                        }),
                        context,
                    ),
                ),
        };
    });
