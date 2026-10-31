/**
 * This file defines the ergonomic tool constructor for the public API: `defineTool` describes a tool's
 * name, description, schemas, and handler in one place (the review's `Tool.inline` shape). The result is
 * a plain descriptor - no Toolkit, handler layer, or Toolset plumbing appears in caller code; the Session
 * composition root lowers a list of these descriptors into the installed Toolset.
 *
 * Every configured tool has ONE shape: a name plus an `init` Effect the composition root runs exactly
 * once per distinct value per session, yielding the tool's session contribution (realized definition,
 * handler, optional leading-prompt block). For ordinary tools `defineTool` lowers to a constant init;
 * system tools whose surface is configuration-derived - the skill tool bakes a session-start roster
 * scan into its description and contributes the skills prompt block - do real work in theirs. Sharing
 * the same value across several agents' `tools` arrays shares one init (one scan, one snapshot).
 */
import { Context, Effect, Schema, type Scope } from 'effect';
import { Tool } from 'effect/ai';

import type { AgentEvents } from '../AgentEvents/AgentEventsService';
import type { EventLog } from '../EventLog/EventLogService';
import type { Ids } from '../Ids';
import type { ModelRequestSettings } from '../Model/ModelRequestSettings';
import type { Profiles } from '../Session/Profiles';
import type { SessionControls } from '../Session/SessionControls';
import type { SkillSourceService } from '../Skills/SkillSource';
import type { SessionAgents } from '../Subagents/SessionAgents';
import type { SubagentToolCapabilities } from '../Subagents/SubagentTool';
import type { SystemPrompt } from '../SystemPrompt/SystemPromptService';
import {
    CurrentAgent,
    CurrentToolCall,
    InterruptNote,
    StopController,
    ToolEvents,
    type ToolEventSink,
} from '../ToolRuntime/ToolContextServices';
import { ToolState } from '../ToolRuntime/ToolStateService';
import type { AnyTool, ToolCallServices } from '../ToolRuntime/ToolsetService';

/**
 * Ambient services every tool handler may use: durable per-call `ToolState` (through declared
 * `defineToolState` namespaces), ephemeral `ToolEvents` progress, the cooperative `StopController`,
 * the executing call's identity (`CurrentAgent`/`CurrentToolCall` - D12), and the `InterruptNote`
 * enriching this call's synthetic result if it is interrupted. The runtime provides all of them around
 * each call. Every handler also runs inside the session's own services - its event log, ids, controls,
 * profiles, and what building an agent takes - which is what lets a delegation tool's handler call
 * `dispatchSubagent`, `forkSubagent`, and `resumeSubagent`. Handlers needing none of these simply have a
 * smaller `R`. Anything else a handler needs (a filesystem, an HTTP client, a host
 * service) becomes part of the tool's own type, {@link FoldTool}, and the host provides it at the top.
 */
export type ToolHandlerServices =
    | ToolState
    | ToolEvents
    | StopController
    | CurrentAgent
    | CurrentToolCall
    | InterruptNote
    | EventLog
    | Ids
    | AgentEvents
    | ToolEventSink
    | SystemPrompt
    | ModelRequestSettings
    | SessionControls
    | Profiles
    | SessionAgents;

type ToolDependency =
    | typeof ToolState
    | typeof ToolEvents
    | typeof StopController
    | typeof CurrentAgent
    | typeof CurrentToolCall
    | typeof InterruptNote;

/** The session's own services in {@link ToolHandlerServices}: the toolkit's build context supplies them. */
export type SessionToolServices = Exclude<ToolHandlerServices, ToolCallServices>;

type ToolOptionsBuilder<Params extends Schema.Top, Success extends Schema.Top, Failure extends Schema.Top> = {
    description: string;
    parameters?: Params;
    success: Success | typeof Schema.Undefined;
    failure?: Failure;
    failureMode: 'return';
    dependencies: Array<ToolDependency>;
};

/**
 * Handler stored on a tool descriptor, erased to the runtime dispatch shape: it takes the params Effect AI hands
 * any erased tool, checks them itself, and already holds the session's and the host's services, taken when its
 * tool's init ran. Its `R` is the per-call services the runtime provides around each call.
 */
export type ErasedToolHandler = (params: Tool.Parameters<AnyTool>) => Effect.Effect<unknown, unknown, ToolCallServices>;

/**
 * What one tool contributes to a session once its `init` has run: the realized tool definition (final
 * description baked), its handler, and an optional block appended to the leading system prompt of
 * every agent listing the value.
 */
export type SessionToolContribution = {
    readonly tool: AnyTool;
    readonly handler: ErasedToolHandler;
    /** Appended to the leading prompt blocks of each agent whose `tools` carry this value. */
    readonly promptBlock: string | null;
    /**
     * The resolved skill source, when this contribution is a skill tool's - the seam the subagent
     * operations preload dispatch-time skills through (the dispatcher picks from skills *it* can see).
     */
    readonly skillSource?: SkillSourceService;
};

/**
 * One tool as configured on an agent, ready for the composition root to initialize. Built with
 * {@link defineTool} or a system-tool factory (`skillTool`, `subagentTool`); consumed by `Session.open`
 * and by subagent definitions. `R` is every service the tool needs from the host - its handler's and its
 * init's - so an agent's type, and `Session.open`'s, carry what the host must provide.
 */
export type FoldTool<R = never> = {
    readonly name: string;
    /**
     * Run ONCE per distinct value per session by the composition root, inside the session's own services;
     * contributions are reused. Resources it acquires live for the session's scope. Its handler runs with the
     * same session and host services.
     */
    readonly init: Effect.Effect<SessionToolContribution, never, R | Scope.Scope | SessionToolServices>;
    /** The subagent roster, on delegation tools built by `subagentTool` or `withSubagentCapabilities`. */
    readonly subagents?: SubagentToolCapabilities<R>;
};

/** The host services a tool, or a union of tools, needs (the session always supplies `Scope` and its own). */
export type FoldToolServices<T> = T extends { readonly init: Effect.Effect<infer _A, infer _E, infer R> }
    ? Exclude<R, Scope.Scope | SessionToolServices>
    : never;

/**
 * A list of tools, each also checked as a tool needing the union of their services. TypeScript infers a
 * mixed array's element type as a union of tools, but cannot infer one service union across the elements,
 * so the public constructors infer the tools' own type `T` and check each element against the union here.
 */
export type ToolsNeedingAll<T> = ReadonlyArray<T & FoldTool<FoldToolServices<T>>>;

/** One realized tool ready to install into a Toolset: the composition-internal, post-init stage. */
export type RealizedFoldTool = {
    readonly name: string;
    readonly tool: AnyTool;
    readonly handler: ErasedToolHandler;
};

/**
 * A handler's Effect, also checked at the call site as one needing the ambient {@link ToolHandlerServices} plus
 * the rest of `Services`. TypeScript cannot split a generic `Services` that way, so `defineTool` infers
 * `Services` from the first member and relies on the second.
 */
type ToolHandlerEffect<A, E, Services> = Effect.Effect<A, E, Services> &
    Effect.Effect<A, E, ToolHandlerServices | Exclude<Services, ToolHandlerServices>>;

/** Options for {@link defineTool}. Schemas default to no parameters, void success, and no failure. */
export type DefineToolOptions<
    Params extends Schema.Codec<unknown, unknown>,
    Success extends Schema.Codec<unknown, unknown>,
    Failure extends Schema.Codec<unknown, unknown>,
    Services = never,
> = {
    readonly name: string;
    readonly description: string;
    /** Parameter schema advertised to the model. Defaults to an empty struct (no parameters). */
    readonly parameters?: Params;
    /** Success schema for the handler result. Defaults to void. */
    readonly success?: Success;
    /** Failure schema for expected, model-visible failures. Defaults to never (handler cannot fail). */
    readonly failure?: Failure;
    /**
     * The handler may use the per-call {@link ToolHandlerServices} plus any host service; the host ones
     * become the tool's `R` and the host provides them where it starts the session.
     */
    readonly handler: (params: Params['Type']) => ToolHandlerEffect<Success['Type'], Failure['Type'], Services>;
};

/**
 * Define one tool inline: name, description, schemas, and handler in a single object.
 *
 * Expected failures follow the D12 convention (`failureMode: "return"`): a typed failure from the
 * handler is schema-encoded into the tool result with `isFailure: true`, so the model sees it and can
 * self-correct; defects stay defects and are captured at the tool-settlement seam.
 *
 * When `success` is omitted the handler is typed as returning void, but the lowered tool uses
 * `Schema.Undefined` (with results normalized to undefined) rather than Effect AI's default
 * `Schema.Void`: results encode through `Union([success, failure, AiError])`, and Void greedily
 * encodes any value - including a returned failure - to undefined, which would erase the failure
 * payload the model needs to self-correct.
 */
export const defineTool = <
    Params extends Schema.Codec<unknown, unknown> = Tool.EmptyParams,
    Success extends Schema.Codec<unknown, unknown> = typeof Schema.Void,
    Failure extends Schema.Codec<unknown, unknown> = typeof Schema.Never,
    Services = never,
>(
    options: DefineToolOptions<Params, Success, Failure, Services>,
): FoldTool<Exclude<Services, ToolHandlerServices>> => {
    const toolOptions: ToolOptionsBuilder<Params, Success, Failure> = {
        description: options.description,
        success: options.success ?? Schema.Undefined,
        failureMode: 'return',
        // Every tool may use the ambient per-call services; declaring them here keeps handler `R`
        // honest while the runtime provides all of them around each execution.
        dependencies: [ToolState, ToolEvents, StopController, CurrentAgent, CurrentToolCall, InterruptNote],
    };

    if (options.parameters !== undefined) {
        toolOptions.parameters = options.parameters;
    }

    if (options.failure !== undefined) {
        toolOptions.failure = options.failure;
    }

    const typedTool = Tool.make(options.name, toolOptions).annotate(Tool.Strict, false);
    const tool: AnyTool = typedTool;
    // Effect AI decodes model-supplied params before calling the handler; checking the decoded value again here
    // is what lets one dispatch table hold every tool's handler.
    const decodeParams = Schema.decodeUnknownEffect(Schema.toType(typedTool.parametersSchema));

    // asVoid yields the undefined value at runtime, which is exactly what Schema.Undefined encodes.
    const handler =
        options.success === undefined
            ? // oxlint-disable-next-line automation/no-effect-asvoid -- the handler's value must be dropped so Schema.Undefined encodes the result
              (params: Params['Type']) => options.handler(params).pipe(Effect.asVoid)
            : options.handler;

    return {
        name: options.name,
        init: Effect.gen(function* () {
            // The session's own services and the host services this tool needs, taken where the session runs its
            // init. A call's services take precedence over the session's, as Effect AI's toolkit context does. The
            // host's take precedence over the call's: a host whose request handling carries its own FileSystem
            // (Alchemy's Worker runtime provides Node's) would otherwise shadow the session's.
            const sessionServices = yield* Effect.context<SessionToolServices>();
            const hostServices = yield* Effect.context<Exclude<Services, ToolHandlerServices>>();

            const contribution: SessionToolContribution = {
                tool,
                handler: (params) =>
                    decodeParams(params).pipe(
                        Effect.orDie,
                        Effect.flatMap(handler),
                        Effect.updateContext((context: Context.Context<ToolCallServices>) =>
                            Context.merge(Context.merge(sessionServices, context), hostServices),
                        ),
                    ),
                promptBlock: null,
            };

            return contribution;
        }),
    };
};
