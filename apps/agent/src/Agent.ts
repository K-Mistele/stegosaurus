/**
 * The agent's Cloudflare resources, for the root stack to yield. The Computer Worker comes first: the
 * Ingress Worker's Durable Objects reach its Computer Durable Object by its Worker name.
 */
import { Effect } from 'effect';

import { ComputerWorker } from './computer/ComputerWorker';
import IngressWorker from './Worker';

export const Agent = Effect.gen(function* () {
    yield* ComputerWorker;
    const ingress = yield* IngressWorker;

    return { url: ingress.url };
});
