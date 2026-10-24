import { Effect, Layer } from 'effect';

import { HookRunner, type HookRunnerService } from '../../src/HookRunner/HookRunnerService';
import type {
    OnCompleteHookInput,
    PostToolUseHookInput,
    PreRequestHookInput,
    PreToolUseHookInput,
} from '../../src/HookRunner/Schema';
import { CompleteDecision, ContinueDecision, KeepDecision, UnchangedDecision } from './HookDecisions';

/**
 * Hook Runner test layer that no-ops for each - i.e. no change.
 * Safe for runtime if no hooks are provided
 */
const noopHooks: HookRunnerService = {
    preRequest: Effect.fn('fold.hook_runner.pre_request.noop')((_input: PreRequestHookInput) =>
        Effect.succeed(UnchangedDecision.make({})),
    ),

    preToolUse: Effect.fn('fold.hook_runner.pre_tool_use.noop')((input: PreToolUseHookInput) =>
        Effect.succeed(
            ContinueDecision.make({
                params: input.params,
            }),
        ),
    ),

    postToolUse: Effect.fn('fold.hook_runner.post_tool_use.noop')((_input: PostToolUseHookInput) =>
        Effect.succeed(KeepDecision.make({})),
    ),

    onComplete: Effect.fn('fold.hook_runner.on_complete.noop')((_input: OnCompleteHookInput) =>
        Effect.succeed(CompleteDecision.make({})),
    ),
};

export const hookRunnerNoop = Layer.succeed(HookRunner, noopHooks);
