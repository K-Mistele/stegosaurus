import { assert, it } from '@effect/vitest';
import { Predicate, Redacted } from 'effect';

import { openaiModel, OpenAiReasoningWithEffort } from '../../src/index';

it('keeps custom OpenAI authentication and reasoning summary settings in the model descriptor', () => {
    const model = openaiModel({
        model: 'openai.gpt-5.6-sol',
        apiKey: 'bedrock-secret',
        apiKeyHeader: 'api-key',
        baseUrl: 'https://example.test/openai/v1',
        reasoning: 'medium',
        reasoningSummary: 'auto',
    });

    if (model.activeModel.providerKind !== 'openai-compatible') assert.fail('expected an OpenAI-compatible model');
    assert.deepStrictEqual(
        model.activeModel.reasoning,
        OpenAiReasoningWithEffort.make({
            effort: 'medium',
        }),
    );
    assert.strictEqual(model.activeModel.reasoningSummary, 'auto');
    assert.isTrue(Predicate.isTagged(model.provider, 'openai-compatible'));

    if (!Predicate.isTagged(model.provider, 'openai-compatible')) return;
    assert.strictEqual(Redacted.value(model.provider.apiKey), 'bedrock-secret');
    assert.strictEqual(model.provider.apiKeyHeader, 'api-key');
    assert.strictEqual(model.provider.baseUrl, 'https://example.test/openai/v1');
});

it('omits the summary and uses bearer authentication defaults when they are not configured', () => {
    const model = openaiModel({
        model: 'openai.gpt-5.6-sol',
        apiKey: 'bedrock-secret',
        reasoning: 'medium',
    });

    if (model.activeModel.providerKind !== 'openai-compatible') assert.fail('expected an OpenAI-compatible model');
    assert.deepStrictEqual(model.activeModel.reasoning, OpenAiReasoningWithEffort.make({ effort: 'medium' }));
    assert.isUndefined(model.activeModel.reasoningSummary);
    assert.isTrue(Predicate.isTagged(model.provider, 'openai-compatible'));

    if (!Predicate.isTagged(model.provider, 'openai-compatible')) return;
    assert.isNull(model.provider.apiKeyHeader);
});
