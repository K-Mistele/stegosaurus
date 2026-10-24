/**
 * This file defines `SlackBot.make`: the Slack provider as `Channels.make` takes it.
 */
import { type RawWebhookInput } from '@stegosaurus/channels-delivery/ProviderWebhooks';
import { type DeliveryMode } from '@stegosaurus/channels-delivery/MailboxPolicy';
import { type ChannelsProvider } from '@stegosaurus/channels-delivery/ChannelsProvider';
import { Effect } from 'effect';
import type { Config, Redacted } from 'effect';

import type { SlackApi } from './SlackApi';
import { type SlackCallbackHandlers } from './SlackCallbacks';
import { slackOutputProcessor } from './SlackDeliveryOutput';
import { slackEventProcessor } from './SlackEventProcessor';
import { slackWebhookProvider } from './SlackWebhookProvider';

/**
 * @property signingSecret - read when the bot is built, so the bot itself can be declared at the top of a module
 * @property deliveryMode - when a thread's mailbox runs and what each batch holds
 * @property handlers - the callbacks; the application provides `SlackApi` (usually `SlackApiLive`) and
 * anything else they need, and the storage supplies `MailboxSubscriptions`
 */
export type MakeOptions<E, R> = {
    readonly signingSecret: Config.Config<Redacted.Redacted>;
    readonly deliveryMode: DeliveryMode;
    readonly handlers: SlackCallbackHandlers<E, R>;
};

export const make = <E, R>(
    options: MakeOptions<E, R>,
): ChannelsProvider<{
    readonly build: SlackApi;
    readonly process: R | SlackApi;
    readonly error: Config.ConfigError;
}> => ({
    providerName: 'slack',
    deliveryMode: options.deliveryMode,
    /** The webhook half calls Slack while it checks a webhook, so it keeps the `SlackApi` it was built with. */
    webhookProvider: Effect.fn('slack.bot.build_webhook_provider')(function* ({ namespace }) {
        const signingSecret = yield* options.signingSecret;
        const buildServices = yield* Effect.context<SlackApi>();
        const webhookProvider = slackWebhookProvider({ namespace, signingSecret });

        return {
            providerName: webhookProvider.providerName,
            handle: (input: RawWebhookInput) =>
                webhookProvider.handle(input).pipe(Effect.provideContext(buildServices)),
        };
    }),
    eventProcessor: ({ namespace }) => Effect.succeed(slackEventProcessor({ namespace, handlers: options.handlers })),
    /** Sends a handed-off delivery's output: posts, edits, reactions, and the thread's status line. */
    outputProcessor: ({ namespace }) => slackOutputProcessor({ namespace }),
});
