# @stegosaurus/durable-streams-cloudflare

A [Durable Streams](https://github.com/durable-streams/durable-streams) server on Cloudflare Workers, for alchemy v2 stacks. Each stream path gets its own Durable Object, `StreamObject`, which keeps that stream in its SQLite storage.

The package ships TypeScript source. Install it from the preview registry, along with `@stegosaurus/durable-streams-protocol` and `@stegosaurus/durable-streams-server`.

## Use the ready-made Worker

```ts
import * as Alchemy from 'alchemy';
import * as Cloudflare from '@alchemy.run/cloudflare';
import * as Effect from 'effect/Effect';
import DurableStreamsWorker from '@stegosaurus/durable-streams-cloudflare/worker';

export default Alchemy.Stack(
    'MyApp',
    { providers: Cloudflare.providers(), state: Cloudflare.state() },
    Effect.gen(function* () {
        const streams = yield* DurableStreamsWorker;

        return { streamsUrl: streams.url };
    }),
);
```

## Host it in your own Worker

`layerDurableObject` provides the `Streams` service and brings `StreamObject` with it: provide it to a Worker and alchemy binds the Durable Object and hosts it there. Put the HTTP API over it, as `src/worker.ts` does:

```ts
import * as Cloudflare from '@alchemy.run/cloudflare';
import * as Http from 'alchemy/Http';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as HttpRouter from 'effect/http/HttpRouter';
import { layerDurableStreamsHttpApi } from '@stegosaurus/durable-streams-server/http-api';
import { layerDurableObject } from '@stegosaurus/durable-streams-cloudflare/streams-durable-object';

const layerApp = layerDurableStreamsHttpApi.pipe(Layer.provide([layerDurableObject, Http.Platform]));

export default class MyWorker extends Cloudflare.Worker<MyWorker>()(
    'MyWorker',
    { main: import.meta.url },
    Effect.gen(function* () {
        return { fetch: yield* HttpRouter.toHttpEffect(layerApp) };
    }),
) {}
```

To call streams from your own code, without HTTP, use the `Streams` service from `@stegosaurus/durable-streams-server/streams`, provided by `layerDurableObject`.

## Settings

- `DURABLE_STREAMS_LONG_POLL_TIMEOUT` (for example `"2 seconds"`): how long a long-poll read waits for new data. Read when the stack deploys.

## Storage

`StreamObject` creates its tables on first use (`src/migrations.ts`) and records applied migrations in `effect_sql_migrations`.
