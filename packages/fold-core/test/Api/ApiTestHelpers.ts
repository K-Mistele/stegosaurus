/**
 * Shared fixtures for the public-facade tests: scripted models exposed as facade descriptors, and
 * inline tool factories with call recorders. Facade tests use only descriptors in their setup -
 * exactly what SDK callers write - with the scripted LanguageModel swapped in at the provider seam.
 */
import { Context, Effect, Layer, Ref, Schema } from 'effect';
import { LanguageModel } from 'effect/ai';

import {
    AnthropicThinkingSetting,
    customModel,
    defineTool,
    OpenAiReasoningDisabled,
    type ActiveModel,
    type AnthropicActiveModel,
    type OpenAiCompatibleActiveModel,
    type FoldModel,
    type FoldTool,
} from '../../src/index';
import {
    // oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- test helper wiring a scripted fake model
    makeScriptedLanguageModel,
    type ScriptedLanguageModel,
    type ScriptedTurn,
} from '../TestLayers/ScriptedLanguageModel';

/** An openai-compatible scripted model snapshot; spread and override for level/model-id variants. */
export const gptActiveModel: OpenAiCompatibleActiveModel = {
    providerId: 'scripted-openai',
    providerKind: 'openai-compatible',
    modelId: 'gpt-scripted',
    role: null,
    requestedReasoningLevel: 'off',
    reasoning: OpenAiReasoningDisabled.make({}),
};

/** An anthropic scripted model snapshot; spread and override for level/model-id variants. */
export const claudeActiveModel: AnthropicActiveModel = {
    providerId: 'scripted-anthropic',
    providerKind: 'anthropic',
    modelId: 'claude-scripted',
    role: null,
    requestedReasoningLevel: 'off',
    thinking: AnthropicThinkingSetting.members[0].make({}),
};

/** A scripted model exposed as a facade descriptor plus its recorded requests. */
export const scriptedModel = (
    activeModel: ActiveModel,
    turns: ReadonlyArray<ScriptedTurn>,
): Effect.Effect<{ readonly model: FoldModel; readonly scripted: ScriptedLanguageModel }> =>
    Effect.gen(function* () {
        const scripted = yield* makeScriptedLanguageModel(turns);

        const make = Layer.build(scripted.layer).pipe(
            Effect.map((context) => Context.get(context, LanguageModel.LanguageModel)),
        );

        return { model: customModel({ activeModel, make }), scripted };
    });

/** A minimal inline echo tool with no recorder, for tests that only need a tool installed. */
export const echoTool: FoldTool = defineTool({
    name: 'echo',
    description: 'Echoes text back to the model.',
    parameters: Schema.Struct({ text: Schema.String }),
    success: Schema.Struct({ echoed: Schema.String }),
    handler: ({ text }) => Effect.succeed({ echoed: text }),
});

/** An inline tool that records every invocation, for asserting whether and how handlers ran. */
export const makeRecordedTool = (
    name: string,
): Effect.Effect<{ readonly tool: FoldTool; readonly calls: Effect.Effect<ReadonlyArray<string>> }> =>
    Effect.gen(function* () {
        const calls = yield* Ref.make<ReadonlyArray<string>>([]);

        const tool = defineTool({
            name,
            description: `Test tool ${name}: echoes text and records the call.`,
            parameters: Schema.Struct({ text: Schema.String }),
            success: Schema.Struct({ echoed: Schema.String }),
            handler: ({ text }) =>
                Ref.update(calls, (recorded) => [...recorded, text]).pipe(Effect.as({ echoed: text })),
        });

        return { tool, calls: Ref.get(calls) };
    });
