import {
    OnCompleteHookDecision,
    PostToolUseHookDecision,
    PreRequestHookDecision,
    PreToolUseHookDecision,
} from '../../src/HookRunner/Schema';

/** Case constructors for each hook decision union, in schema member order. */
export const [UnchangedDecision, ChangedDecision] = PreRequestHookDecision.members;

export const [ContinueDecision, ReplaceResultDecision] = PreToolUseHookDecision.members;

export const [KeepDecision, ReplaceDecision] = PostToolUseHookDecision.members;

export const [CompleteDecision, ContinueWithDecision] = OnCompleteHookDecision.members;
