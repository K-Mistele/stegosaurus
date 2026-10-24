/**
 * This file classifies an ActiveModel into a model family - the coarse grouping that drives per-family
 * system prompt selection (D17), toolset selection (write/edit vs apply_patch, D17/D18), and reasoning
 * parameter mapping (D23). Classification is pure data inspection: provider kind decides first, then
 * model id patterns for openai-compatible endpoints that serve many vendors (openrouter-style ids like
 * "anthropic/claude-...").
 */
import { Match, String as Str } from 'effect';

import type { ActiveModel } from '../EventLog/Schemas';

/** Coarse model grouping driving per-family prompt, toolset, and reasoning decisions. */
export type ModelFamily = 'claude' | 'codex' | 'gpt' | 'unknown';

/** Classify one resolved model snapshot into its family. */
export const modelFamilyFor = (model: ActiveModel): ModelFamily =>
    Match.value(model.providerKind).pipe(
        Match.when('anthropic', (): ModelFamily => 'claude'),
        Match.when('codex', (): ModelFamily => 'codex'),
        Match.when('openai-compatible', (): ModelFamily => {
            const modelId = Str.toLowerCase(model.modelId);

            if (Str.includes('claude')(modelId)) return 'claude';

            if (Str.includes('codex')(modelId)) return 'codex';

            if (Str.startsWith('gpt')(modelId) || /^o\d/.test(modelId)) return 'gpt';

            return 'unknown';
        }),
        Match.exhaustive,
    );
