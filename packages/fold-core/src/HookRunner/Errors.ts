import { Schema } from 'effect';

const HookPhaseSchema = Schema.Literals(['preRequest', 'preToolUse', 'postToolUse', 'onComplete']);

export type HookPhase = typeof HookPhaseSchema.Type;

export class HookExecutionError extends Schema.TaggedError<HookExecutionError, { readonly brand: unique symbol }>()(
    'HookExecutionError',
    {
        phase: HookPhaseSchema,
        hookName: Schema.String,
        cause: Schema.Cause(Schema.Never, Schema.Defect()),
    },
) {
    override get message(): string {
        return `${this.phase} hook "${this.hookName}" failed`;
    }
}
