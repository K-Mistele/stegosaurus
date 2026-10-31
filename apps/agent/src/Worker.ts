import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import { DeliveryMailboxes } from '@stegosaurus/channels-alchemy-cloudflare';
import { GitHubApiLive } from '@stegosaurus/channels-github';
import { Photon } from '@stegosaurus/fold-agent/tools/files';
import * as Cloudflare from '@alchemy.run/cloudflare';
import * as Alchemy from 'alchemy';
import { Duration, Effect, Layer } from 'effect';
import { FetchHttpClient, HttpRouter } from 'effect/http';

import { AgentSessionDOLive, AgentSessions } from './AgentSessionDO';
import { AutoLabel } from './AutoLabel';
import { DELIVERY_API_BINDING, DeliveryApi } from './DeliveryApi';
import { DeliveryMailbox, DeliveryMailboxDOLive } from './DeliveryMailboxDO';
import { bot } from './GithubBot';
import { ingressName, PROD_DOMAIN } from './Names';

/** Give Channels access to this application's Durable Object mailbox namespace. */
const ChannelsDeliveryMailboxesLive = Layer.effect(DeliveryMailboxes, DeliveryMailbox);

const { mailboxDelivery, deliveryControl } = bot.layers.worker;

/** Provider webhooks and the delivery API, with their Cloudflare adapters. */
const RoutesLive = Layer.merge(bot.routes, bot.deliveryApi).pipe(
    Layer.provide(Layer.merge(mailboxDelivery, deliveryControl)),
);

/** The platform clients and settings every layer above them uses. */
const PlatformLive = Layer.mergeAll(
    FetchHttpClient.layer,
    NodeCrypto.layer,
    Cloudflare.Workers.AIBinding,
    Photon.layer,
    Layer.succeed(HttpRouter.RouterConfig, bot.routerConfig),
);

/** GitHub, labelling, and the delivery API client the agent's sessions report through. */
const ServicesLive = Layer.mergeAll(
    GitHubApiLive,
    AutoLabel.layer({ model: '@cf/cloudflare/clef', threshold: 0.7, timeout: Duration.seconds(60) }),
    DeliveryApi.layerSelfBinding,
).pipe(Layer.provideMerge(PlatformLive));

/** The AgentSession Durable Objects, and the namespace the mailboxes hand deliveries to. */
const AgentSessionsLive = AgentSessions.layer.pipe(
    Layer.provideMerge(AgentSessionDOLive.pipe(Layer.provideMerge(ServicesLive))),
);

/** Everything the Worker and its Durable Objects need: Channels' mailboxes over the agent's sessions. */
const WorkerLive = ChannelsDeliveryMailboxesLive.pipe(
    Layer.provideMerge(DeliveryMailboxDOLive.pipe(Layer.provideMerge(AgentSessionsLive))),
);

/** The Ingress Worker's Cloudflare settings in `stage`: the custom domain in prod, workers.dev elsewhere. */
const ingressProps = (stage: string) => {
    const props = {
        main: import.meta.url,
        compatibility: { date: '2026-10-01' },
        name: ingressName(stage),
        /** AgentSession reaches this Worker's delivery API through this binding. */
        env: { [DELIVERY_API_BINDING]: Cloudflare.Workers.Self },
    };

    return stage === 'prod' ? { ...props, domain: PROD_DOMAIN, workersDev: false } : props;
};

/**
 * The Worker and the Durable Objects it hosts run at one pinned compatibility date, so an Alchemy
 * upgrade cannot change their behavior. 2026-10-01 turns on `durable_object_io_tasks_prevent_eviction`:
 * pending I/O, such as an RPC to another Durable Object or a timer, keeps an object alive for up to 15
 * minutes. Listing that flag as well is an error, because the date already includes it.
 *
 * In prod it serves `agent.stegosaurus.tech`, where the Stegosaurus.tech GitHub App sends its webhooks
 * (`/integrations/github/webhook`). Other stages are on workers.dev.
 */
export default class IngressWorker extends Cloudflare.Worker<IngressWorker>()(
    'IngressWorker',
    Effect.map(Alchemy.Stage, ingressProps),
    Effect.gen(function* () {
        const services = yield* Layer.build(WorkerLive);
        const fetch = yield* HttpRouter.toHttpEffect(RoutesLive).pipe(Effect.provideContext(services));

        return { fetch };
    }),
) {}
