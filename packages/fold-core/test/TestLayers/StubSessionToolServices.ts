import { Context, identity, Layer } from 'effect';

import {
    AgentEvents,
    agentRegistryFromDefinitions,
    EventLog,
    Ids,
    ModelRequestSettings,
    Profiles,
    SessionAgents,
    SessionControls,
    SystemPrompt,
    ToolEventSink,
} from '../../src/index';

/**
 * The session's own services a tool init runs inside, for tests that run one outside a session. Every method
 * dies when called, so a tool that uses one fails loudly.
 */
export const layerStubSessionToolServices = Layer.mergeAll(
    Layer.mock(EventLog, {}),
    Layer.mock(Ids, {}),
    Layer.mock(AgentEvents, {}),
    Layer.mock(ToolEventSink, {}),
    Layer.mock(SystemPrompt, {}),
    Layer.mock(ModelRequestSettings, { wrap: () => identity }),
    Layer.mock(SessionControls, {}),
    Layer.mock(Profiles, {}),
    Layer.mock(SessionAgents, {
        registry: agentRegistryFromDefinitions({ subagents: [], forkAgents: [] }, Context.empty()),
        realizeTools: () => ({ tools: [], promptBlocks: [], skillSource: null }),
        autoCompact: undefined,
    }),
);
