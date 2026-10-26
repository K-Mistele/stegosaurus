/**
 * This file defines `ChannelsCloudflare.make`: one bot split across a Worker and a Durable Object.
 *
 * Cloudflare differs from the other storage packages because the application declares both classes
 * and the two halves run in different places. The Worker takes webhooks and hands each event to the
 * mailbox's Durable Object. The Durable Object stores the mailbox and runs the callbacks when its
 * alarm fires. Both halves are built from the same options, so they cannot drift apart.
 */
import { MailboxSubscriptions } from '@stegosaurus/channels-delivery/MailboxSubscriptions';
import { MailboxProcessing } from '@stegosaurus/channels-delivery/MailboxProcessing';
import { deliveryApiRoutes } from '@stegosaurus/channels-delivery/DeliveryHttpServer';
import { DeliveryControl } from '@stegosaurus/channels-delivery/DeliveryControl';
import { type ChannelsProviderRequirements } from '@stegosaurus/channels-delivery/ChannelsProvider';
import * as Channels from '@stegosaurus/channels-delivery/Channels';
import { Effect } from 'effect';

import { DeliveryControlAlchemyCloudflare, deliveryRequestHandler } from './DeliveryControl';
import { DeliveryControlBackendFromDurableObjectStorage } from './DeliveryControlBackend';
import { mailboxAlarmHandler, type MailboxAlarmHandlerOptions } from './MailboxAlarm';
import { MailboxDeliveryAlchemyCloudflare, deliverFromDurableObjectStorage } from './MailboxDelivery';
import { MailboxProcessingBackendFromDurableObjectStorage } from './MailboxProcessingBackend';
import { MailboxStorage } from './MailboxStorage';
import { MailboxSubscriptionsFromDurableObjectStorage } from './MailboxSubscriptions';

/** Build a mailbox's RPC and alarm handlers from the services supplied by its program entrypoint. */
export const makeMailbox = (alarmOptions: MailboxAlarmHandlerOptions) =>
    Effect.gen(function* () {
        const deliver = yield* deliverFromDurableObjectStorage;
        const deliveryRequest = yield* deliveryRequestHandler;
        /** The alarm runs with only the Worker's services, so it keeps the entrypoint's `MailboxProcessing`. */
        const processing = yield* Effect.context<MailboxProcessing>();
        const runMailboxAlarm = yield* mailboxAlarmHandler(alarmOptions);

        return {
            deliver,
            deliveryRequest,
            alarm: () => runMailboxAlarm().pipe(Effect.provide(processing)),
        };
    });

export const make = <const Requirements extends ReadonlyArray<ChannelsProviderRequirements>>(
    options: Channels.Options<Requirements>,
) => {
    /**
     * Build the Durable Object handlers from services supplied by the Durable Object entrypoint. When the
     * alarm runs, Alchemy supplies only the Worker's services, so the alarm's processing takes what the
     * providers need from the alarm's own call, and this mailbox's own subscriptions, which exist only here.
     */
    const mailbox = (alarmOptions: MailboxAlarmHandlerOptions) =>
        Effect.gen(function* () {
            const processing = yield* Channels.makeProcessing(options);
            const deliver = yield* deliverFromDurableObjectStorage;
            const deliveryRequest = yield* deliveryRequestHandler;
            const subscriptions = yield* Effect.context<MailboxSubscriptions>();
            const runAlarm = yield* mailboxAlarmHandler(alarmOptions);

            const processingForThisCall = Effect.map(
                Effect.context<Requirements[number]['process'] | MailboxSubscriptions>(),
                (context) =>
                    MailboxProcessing.of({
                        processReady: processing.processReady.pipe(Effect.provide(context)),
                    }),
            );

            const alarm = () =>
                runAlarm().pipe(
                    Effect.provideServiceEffect(MailboxProcessing, processingForThisCall),
                    Effect.provide(subscriptions),
                );

            return { deliver, deliveryRequest, alarm };
        });

    /** Provider webhook routes. The Worker entrypoint supplies `MailboxDelivery`. */
    const routes = Channels.routesLayer(options);

    /** Remote delivery routes. The Worker entrypoint supplies `DeliveryControl`. */
    const deliveryApi = deliveryApiRoutes(options);

    return {
        mailbox,
        routes,
        deliveryApi,
        routerConfig: Channels.routerConfig,
        layers: {
            worker: {
                mailboxDelivery: MailboxDeliveryAlchemyCloudflare,
                deliveryControl: DeliveryControlAlchemyCloudflare,
            },
            mailbox: {
                /** Compatibility layer for single-runtime hosts; split Durable Objects use `mailbox()` directly. */
                processing: Channels.processingLayer(options, 'disabled'),
                deliveryControl: DeliveryControl.layer,
                processingBackend: MailboxProcessingBackendFromDurableObjectStorage,
                subscriptions: MailboxSubscriptionsFromDurableObjectStorage,
                deliveryControlBackend: DeliveryControlBackendFromDurableObjectStorage,
                storage: MailboxStorage.layer,
            },
        },
    };
};
