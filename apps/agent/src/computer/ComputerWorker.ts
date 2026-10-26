/**
 * The Worker hosting the Computer Durable Object. An async Worker: an Effect Worker's bundle drops every
 * export but its own, and `@cloudflare/computer` needs its classes exported from the Worker module.
 */
import * as Cloudflare from '@alchemy.run/cloudflare';
import * as Alchemy from 'alchemy';
import { Effect } from 'effect';

import { computerName } from '../Names';
import { COMPUTER_CONTAINER_IMAGE } from './Contract';

/**
 * The Computer's Linux container image (see `container/Dockerfile`). The Computer schedules it itself and
 * picks it from `ctx.container.images` by this id.
 */
export const ComputerContainer = Cloudflare.Container(COMPUTER_CONTAINER_IMAGE, {
    schedulingPolicy: 'durable_object',
    context: `${import.meta.dirname}/container`,
});

export const ComputerWorker = Cloudflare.Worker(
    'ComputerWorker',
    Effect.map(Alchemy.Stage, (stage) => ({
        name: computerName(stage),
        main: `${import.meta.dirname}/Computer.ts`,
        /**
         * 2026-10-01: pending calls to other Durable Objects, containers and timers keep a Durable Object in
         * memory with no client connected, so a command whose caller has gone runs on. It also keeps a thrown
         * error's `code` across Workers RPC, which the agent's Workspace reads.
         */
        compatibility: { flags: ['nodejs_compat'], date: '2026-10-01' },
        /** Only the agent's Ingress Worker reaches it, by Durable Object binding. */
        workersDev: false,
        env: {
            /**
             * The Computer Durable Object and its container. Named COMPUTER_BINDING: the shell and the container
             * call back into the Computer through this binding.
             */
            Computer: Cloudflare.DurableObject('Computer', { containers: [ComputerContainer] }),
            LOADER: Cloudflare.WorkerLoader(),
        },
    })),
);
