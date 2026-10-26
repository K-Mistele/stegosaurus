import { describe, it } from '@effect/vitest';
import { DeliveryPlan } from '@stegosaurus/channels-delivery/DeliveryPlan';
import { Effect, Schema } from 'effect';
import { toCodecOpenAI } from 'effect/ai/OpenAiStructuredOutput';

import { NoParameters } from '../src/ToolParameters';

describe('tool parameters', () => {
    it.effect('gives OpenAI an object with no fields for a tool that takes none', ({ expect }) =>
        Effect.gen(function* () {
            expect(toCodecOpenAI(NoParameters).jsonSchema).toEqual({
                type: 'object',
                properties: {},
                additionalProperties: false,
            });
            expect(yield* Schema.decodeEffect(NoParameters)({})).toEqual({});
        }),
    );

    it('gives OpenAI an object for the plan', ({ expect }) => {
        expect(toCodecOpenAI(DeliveryPlan).jsonSchema).toMatchObject({ type: 'object' });
    });
});
