import { Effect, Ref, Schema } from 'effect';
import { Tool, Toolkit } from 'effect/ai';

import { type AnyTool, defineToolState, StopController, ToolEvents, ToolState } from '../../src/index';

export const EchoState = defineToolState({
    namespace: 'echo',
    keys: {
        last: Schema.String,
    },
});

export const EchoTool = Tool.make('echo', {
    description: 'Echoes text back to the model.',
    parameters: Schema.Struct({ text: Schema.String }),
    success: Schema.Struct({ echoed: Schema.String }),
    failure: Schema.Struct({ message: Schema.String }),
    failureMode: 'return',
    dependencies: [ToolState, ToolEvents, StopController],
});

/** A toolkit over erased tools, as the session installs them, so the Toolset can dispatch any name. */
export const erasedToolkit = (...tools: ReadonlyArray<AnyTool>) => Toolkit.make(...tools);

/** Erase a typed handler for an {@link erasedToolkit} the way `defineTool` does: it checks its own params. */
export const erasedHandler =
    <P extends Schema.Top, A, E, R>(parameters: P, handler: (params: P['Type']) => Effect.Effect<A, E, R>) =>
    (params: Tool.Parameters<AnyTool>) =>
        Schema.decodeUnknownEffect(Schema.toType(parameters))(params).pipe(Effect.orDie, Effect.flatMap(handler));

export const TestToolkit = erasedToolkit(EchoTool);

export type EchoRecorder = {
    readonly calls: Ref.Ref<ReadonlyArray<string>>;
};

export const makeEchoRecorder: Effect.Effect<EchoRecorder> = Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);

    return { calls };
});

export const layerEchoTool = (recorder: EchoRecorder) =>
    TestToolkit.toLayer(
        TestToolkit.of({
            echo: erasedHandler(EchoTool.parametersSchema, ({ text }) =>
                Effect.gen(function* () {
                    yield* Ref.update(recorder.calls, (calls) => [...calls, text]);

                    return { echoed: text };
                }),
            ),
        }),
    );

export const layerStatefulEchoTool = (recorder: EchoRecorder) =>
    TestToolkit.toLayer(
        TestToolkit.of({
            echo: erasedHandler(EchoTool.parametersSchema, ({ text }) =>
                Effect.gen(function* () {
                    yield* EchoState.set('last', text);
                    yield* Ref.update(recorder.calls, (calls) => [...calls, text]);

                    return { echoed: text };
                }),
            ),
        }),
    );

export const layerEventfulEchoTool = (recorder: EchoRecorder) =>
    TestToolkit.toLayer(
        TestToolkit.of({
            echo: erasedHandler(EchoTool.parametersSchema, ({ text }) =>
                Effect.gen(function* () {
                    const events = yield* ToolEvents;
                    yield* events.emit({ progress: `working:${text}` });
                    yield* Ref.update(recorder.calls, (calls) => [...calls, text]);

                    return { echoed: text };
                }),
            ),
        }),
    );

/** Echo variant that requests a cooperative stop mid-handler and still returns a normal result. */
export const layerStoppingEchoTool = (recorder: EchoRecorder) =>
    TestToolkit.toLayer(
        TestToolkit.of({
            echo: erasedHandler(EchoTool.parametersSchema, ({ text }) =>
                Effect.gen(function* () {
                    const stop = yield* StopController;
                    yield* stop.requestStop(`echo requested stop: ${text}`);
                    yield* Ref.update(recorder.calls, (calls) => [...calls, text]);

                    return { echoed: text };
                }),
            ),
        }),
    );
