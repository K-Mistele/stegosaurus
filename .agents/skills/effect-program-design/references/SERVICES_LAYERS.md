# Services and Layers

Services declare capabilities; layers construct implementations. The environment is the dependency graph.

## Service shape

- Make operations domain-shaped and Effect-returning.
- Keep success, typed error, and requirements visible in each operation type.
- Use named input objects and narrow per-operation errors.
- Yield dependencies from the environment rather than accepting service instances as parameters.
- Load configuration with `Config` in the implementing layer. Keep secrets `Redacted` until the adapter edge.

Small modules may collocate tag, shape, errors, and live layer. Larger services and external adapters should split the
public tag, live wiring, errors, schemas, persistence, and transport concerns. Collocation is a complexity decision,
not permission to tangle public contracts with implementation details.

## Live implementation: `make` and `static layer`

Give each service its constructor as a `make` effect on the class, and build its layer from that `make` as
`static readonly layer`. `make` yields every dependency from the environment. No function takes a service instance as
a parameter, and there are no separate `WidgetServiceLive` constants or `makeWidgetServiceWith(provider)` variants.

```ts
export class WidgetService extends Context.Service<
  WidgetService,
  {
    readonly list: (input: ListWidgetsInput) => Effect.Effect<ReadonlyArray<Widget>, WidgetError>;
  }
>()("@app/widgets/WidgetService", {
  make: Effect.gen(function* () {
    const provider = yield* WidgetProvider; // dependencies come from yield*, never from parameters
    return {
      list: (input) => listWidgets(input).pipe(Effect.provideService(WidgetProvider, provider)),
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

// Runtime composition provides it once:
const AppLive = WidgetService.layer.pipe(Layer.provide(WidgetProviderLive));
```

- `WidgetService.make` is the constructor. Hosts that build the service themselves `yield*` it. An example is a
  Durable Object that constructs per-instance services. Tests can do the same, providing the dependencies.
- `WidgetService.layer` is what runtime composition provides. Use `Layer.scoped` instead of `Layer.effect` when `make`
  acquires resources.
- A variant layer is derived from `layer`, not from a second constructor. For example,
  `static readonly layerSelfBinding = WidgetService.layer.pipe(Layer.provide(selfBindingHttpClient))`.

When construction needs plain configuration, such as options, handler functions or processors, make both static
functions of that configuration. Their arguments are only plain values, never services, layers or contexts:

```ts
export class MailboxProcessing extends Context.Service<MailboxProcessing, MailboxProcessingOperations>()(
  "@app/delivery/MailboxProcessing",
) {
  static readonly make = <R>(options: MailboxProcessingOptions, processors: MailboxProcessors<R>) =>
    Effect.gen(function* () {
      const services = yield* Effect.context<MailboxProcessingBackend | Crypto.Crypto>();
      return { processReady: processReady(options, processors).pipe(Effect.provide(services)) };
    });

  static readonly layer = <R>(options: MailboxProcessingOptions, processors: MailboxProcessors<R>) =>
    Layer.effect(
      MailboxProcessing,
      Effect.gen(function* () {
        const operations = yield* MailboxProcessing.make(options, processors);
        const context = yield* Effect.context<R>();
        return MailboxProcessing.of({ processReady: operations.processReady.pipe(Effect.provide(context)) });
      }),
    );
}
```

Here `make` leaves the processors' requirements `R` open, for hosts that supply them per call, such as a Durable Object
alarm. `layer` takes them once, when the layer is built.

The channels packages follow this pattern throughout. Examples are `GitHubGitCredentials`, `GitHubApiClient`,
`GitHubAppCredentials`, `DeliveryControl` and `MailboxProcessing` (humanlayer/channels `aa71e53`, "build services with
make and layer, and never pass a service as an argument").

Prefer leaving dependencies in a substantial operation's `R` channel and satisfying them at runtime composition.
Capturing a yielded dependency is reasonable when an acquired resource or configured client is genuinely layer-local
(e.g. an effect needs a runtime-constructed httpClient with credentials provided for a given organization that were looked up at runtime).
Do not manufacture production `Base` layers solely to make testing possible; keep the real dependency seam visible.

Layers that depend on other services should yield those services. Business services should not construct dependency
layers. Runtime composition owns assembly. A justified exception is a dynamically credentialed client whose lifetime
or configuration can only be known during an operation; isolate that adapter behavior and keep it typed.

## Independently testable operation effects

Substantial effects remain first-class even when a service is small. Define them outside a large layer constructor so
their `Effect<A, E, R>` type documents requirements and tests can provide only the needed layers. They may remain in
the same file or be extracted by concern. Do not extract trivial wrappers merely to satisfy a file convention.

Both forms below are valid stable operation boundaries:

```ts
const getStatus = Effect.fn("widget.get_status")(function* (input: GetStatusInput) {
  // ...
});

// PREFERRED
const getStatusAlternative = (input: GetStatusInput) =>
  Effect.gen(function* () {
    // ...
  }).pipe(
    Effect.withSpan("widget.get_status", { attributes: { organization_id: input.organizationId } }),
  );
```

Use safe span attributes. Never annotate credentials, tokens, request bodies containing secrets, or unrestricted raw
provider responses.

## Test-only implementations

Handwritten test services, recording fakes, `Layer.succeed`, and `Layer.mock` are allowed **only in test code** (test
files and dedicated test utilities). Never place a mock service, fake implementation, or `Layer.mock` in production
modules. Keep them in the repository's designated test directories or test utilities.
Production source should expose the real tag and live adapter seams; tests own substitutions.

Do not use module mocks or method spies. If a dependency cannot be replaced by providing a layer, repair the module's
dependency boundary.

## Composition rules

- Assemble complete runtimes at application entry points.
- Provide each service's implementing Layer once when constructing the application's Effect runtime. The implemented
  service is then available through the Effect environment; do not re-provide its Layer inside operations, handlers,
  callbacks, or unrelated implementing Layers.
- Exception: provide an implementing Layer later only when it cannot be constructed during application runtime
  creation because required configuration or resources do not exist yet. Examples include credentials selected for
  the current tenant, request-derived client configuration, or a transport created for a new connection. Provide it
  at the narrowest scope that owns both the required values and its lifetime.
- Keep dependency wiring inside the module that owns it. Never require callers to pass `Context`, `Layer`,
  `ManagedRuntime`, or service instances as ordinary arguments.
- Use `Layer.provide`/`provideMerge` deliberately; avoid invisible global dependencies.
- Use `Layer.scoped` when construction acquires resources.
- Do not call `Effect.runPromise` inside services.
- Do not pass a `Layer` into an operation.
- Do not hide initialization failures with `orDie`; classify, capture, and expose or handle them intentionally.
- A shared `ManagedRuntime` memoizes layers by reference across runtime calls. When a reused layer captures per-request,
  per-session, per-task, or per-tenant configuration or mutable state, wrap the complete dynamic layer subtree in
  `Layer.fresh`.
- Do not freshen intentional application singletons such as database pools and generic HTTP clients. Freshness must
  match the service's intended lifetime.
