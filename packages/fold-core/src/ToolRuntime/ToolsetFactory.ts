/**
 * This file builds a Toolset layer from an Effect AI Toolkit and its handler layer. Application setup code
 * consumes this adapter to install concrete tools, and ToolRuntime consumes the resulting Toolset service
 * without needing to know the toolkit's specific TypeScript shape.
 */
import { Effect, Layer, Record as Rec, Stream } from 'effect';
import type { Tool, Toolkit } from 'effect/ai';

import { type AnyTool, Toolset, type ToolHandlerOutput } from './ToolsetService';

/** Build a final failure output for a model-requested tool name that is not in the active Toolset. */
const unavailableToolFailureOutput = (name: string, names: ReadonlyArray<string>): ToolHandlerOutput => ({
    result: { message: `Tool "${name}" is not available.`, availableTools: names },
    encodedResult: { message: `Tool "${name}" is not available.`, availableTools: names },
    isFailure: true,
    preliminary: false,
});

/** Build a final failure output when handler lookup or stream creation fails before execution starts. */
const toolStartupFailureOutput = (name: string, reason: string): ToolHandlerOutput => ({
    result: { message: `Tool "${name}" failed before execution.`, cause: reason },
    encodedResult: { message: `Tool "${name}" failed before execution.`, cause: reason },
    isFailure: true,
    preliminary: false,
});

/**
 * Build the Toolset layer that exposes one Effect AI Toolkit to ToolRuntime. The toolkit is over erased
 * {@link AnyTool}s, so it can dispatch the model-supplied tool names it gets at runtime.
 */
export const toolsetLayerFromToolkit = (
    toolkit: Toolkit.Toolkit<Record<string, AnyTool>>,
): Layer.Layer<Toolset, never, Tool.HandlersFor<Record<string, AnyTool>>> =>
    Layer.effect(
        Toolset,
        Effect.gen(function* () {
            const withHandlers = yield* toolkit;
            const names: ReadonlyArray<string> = Rec.keys(toolkit.tools);

            return {
                names: Effect.succeed(names),
                toolkit: Effect.succeed(toolkit),
                withHandler: Effect.succeed(withHandlers),

                /** Run one named toolkit handler, mapping unavailable tools and startup failures to final outputs. */
                handle: (name, params) => {
                    if (!names.includes(name))
                        return Effect.succeed(Stream.succeed(unavailableToolFailureOutput(name, names)));

                    return withHandlers.handle(name, params).pipe(
                        Effect.map((stream) =>
                            stream.pipe(
                                Stream.map((output): ToolHandlerOutput => ({
                                    result: output.result,
                                    encodedResult: output.encodedResult,
                                    isFailure: output.isFailure,
                                    preliminary: output.preliminary,
                                })),
                            ),
                        ),
                        Effect.catchTag('AiError', (error) =>
                            Effect.succeed(Stream.succeed(toolStartupFailureOutput(name, error.message))),
                        ),
                    );
                },
            };
        }),
    );
