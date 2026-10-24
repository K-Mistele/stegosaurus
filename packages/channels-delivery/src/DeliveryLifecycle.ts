/**
 * This file defines the life of one delivery as pure transitions over a mailbox's delivery slot.
 *
 * Every store runs these inside its own atomic update: memory and the Durable Object over a mailbox
 * kept as one value, Postgres over the rows it locked in one transaction, and Redis over one read of
 * the mailbox, written only if nothing changed it since. Keeping them here means the stores cannot
 * drift apart.
 *
 * A transition that can be refused is an Effect that fails with the refusal, such as `ClaimNotOwned`
 * or `DeliveryClosed`. It needs no services and does no I/O, so a store can run it inside its atomic
 * section; a refused change writes nothing.
 *
 * ```text
 * Local ──handoff──▶ ExternalCleaning ──callback returns──▶ ExternalWaiting ──result──▶ Finishing ──output settled──▶ Retired
 *   │                     │ result: finish once the callback returns                          ▲
 *   │ retryable failure   └───────────────────────────────────────────────────────────────────┘
 *   ▼
 * Retry ──due──▶ Local (new claim, same batch)
 * ```
 *
 * Output runs only while no callback code does: in `ExternalWaiting` and `Finishing`. Operations run
 * one at a time, in the order they were saved. A delivery retires once its callback has returned and
 * every operation is delivered or has failed.
 */
import { Array as Arr, Data, Effect, Match, Option, Predicate, Schema, Struct } from 'effect';

import { DeliveryActivity, SetActivity, sameDeliveryActivity } from './DeliveryActivity';
import { DeliveryOperationKind, PreparedDeliveryInvocation, type DeliveryStage } from './DeliveryContext';
import {
    DeliveryClosed,
    DeliveryMessageConflict,
    DeliveryMessageDeleted,
    DeliveryMessageNotFound,
    DeliveryMutationReceipt,
    DeliveryNotFound,
    DeliveryOperationUnsupported,
    DeliveryReactionTargetUnavailable,
    DeliveryStatus,
    DeliveryTerminalConflict,
    sameDeliveryTerminal,
    terminalFromMutation,
    type AddDeliveryLink,
    type CompleteDelivery,
    type CreateDeliveryMessage,
    type DeleteDeliveryMessage,
    type DeliveryMessageMutation,
    type DeliveryMutation,
    type FailDelivery,
    type PutDeliveryPlan,
    type SetDeliveryActivity,
    type SetDeliveryReaction,
    type UpdateDeliveryMessage,
} from './DeliveryControl';
import { AddExternalLink, ExternalLink } from './DeliveryLink';
import {
    CreateMessage,
    DeleteMessage,
    UpdateMessage,
    type MessageId,
    type ProviderMessageReference,
} from './DeliveryMessage';
import {
    DeliveryOperation,
    DeliveryOperationId,
    DeliveryOperationState,
    DeliveryOutputStatus,
    deliveryOutputStatus,
    isUnsettledOperation,
    operationMessageId,
    type DeliveryOutputOperation,
    type DeliveryOutputSettlement,
} from './DeliveryOperation';
import { DeliveryOutcome, DeliveryTerminal, PresentOutcome } from './DeliveryOutcome';
import {
    DeliveryPlanRevision,
    DeliveryPlanState,
    DeliveryPlanStatus,
    RenderPlan,
    RenderedDeliveryPlan,
    deliveryPlanStatus,
    sameDeliveryPlan,
} from './DeliveryPlan';
import {
    DeliveryReactionTarget,
    SetMessageReaction,
    deliveryReactionTargetKind,
    sameDeliveryReactionTarget,
    type PortableReaction,
} from './DeliveryReaction';
import { BatchId, DeliveryAccessToken, deliveryAccessTokenMatches, type DeliveryReference } from './DeliveryReference';
import { Timestamp } from './MailboxPolicy';
import { DeliveryAdmissionBatch } from './ProviderEventProcessing';

/** How long a finished delivery stays readable, so a remote worker can retry its last request. */
export const DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

/** The most finished deliveries one mailbox keeps. The oldest go first. */
export const MAX_RETAINED_DELIVERIES = 20;

/** The final message of a delivery whose remote worker sent nothing before its handoff's time limit. */
export const DELIVERY_TIMED_OUT_MARKDOWN = 'The remote worker stopped responding, so this was ended.';

/** The default wait before a retryable failure runs again. */
export const DEFAULT_RETRY_AFTER_MS = 1_000;

/**
 * Where the active delivery is. `Finishing` means its callback has returned and it is sending the
 * output it still owes before it retires.
 */
export const ActiveDeliveryStage = Schema.Literals([
    'Local',
    'Retry',
    'ExternalCleaning',
    'ExternalWaiting',
    'Finishing',
]);

export type ActiveDeliveryStage = typeof ActiveDeliveryStage.Type;

/**
 * The batch a mailbox is working on.
 *
 * @property claimId - the attempt that owns the batch; kept through `ExternalCleaning` as ownership of callback cleanup
 * @property terminal - the remote worker's result, when it has sent one
 * @property plan - the plan the remote worker last sent, and the plan a provider last showed
 * @property operations - provider output the delivery owes or has sent, in the order it was saved
 */
export const ActiveDelivery = Schema.Struct({
    batchId: BatchId,
    accessToken: DeliveryAccessToken,
    callbackIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    callbackAccessTokens: Schema.optionalKey(Schema.NonEmptyArray(DeliveryAccessToken)),
    continuationAllowed: Schema.optionalKey(Schema.Boolean),
    admissions: DeliveryAdmissionBatch,
    attempt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    claimId: Schema.NullOr(Schema.NonEmptyString),
    stage: ActiveDeliveryStage,
    prepared: Schema.optionalKey(PreparedDeliveryInvocation),
    terminal: Schema.optionalKey(DeliveryTerminal),
    interruptRequestedAt: Schema.optionalKey(Timestamp),
    handedOffAt: Schema.optionalKey(Timestamp),
    /** How long the remote worker may go without a request before the delivery fails on its own. Absent means no limit. */
    failAfterMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
    /** When the delivery fails on its own, unless the remote worker sends a request first. */
    failAt: Schema.optionalKey(Timestamp),
    links: Schema.Array(ExternalLink),
    plan: Schema.optionalKey(DeliveryPlanState),
    /** Stores written before output existed read it as empty. */
    operations: Schema.Array(DeliveryOperation).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
});

export type ActiveDelivery = typeof ActiveDelivery.Type;

/** A finished delivery, kept for status reads and repeated requests. */
export const RetainedDelivery = Schema.Struct({
    batchId: BatchId,
    callbackIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    accessToken: DeliveryAccessToken,
    supportedOperations: Schema.Array(DeliveryOperationKind),
    terminal: Schema.optionalKey(DeliveryTerminal),
    interruptRequested: Schema.Boolean,
    retainUntil: Timestamp,
    /** Stores written before output existed read these as empty. */
    links: Schema.Array(ExternalLink).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
    output: Schema.Array(DeliveryOutputStatus).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
    plan: Schema.optionalKey(DeliveryPlanStatus),
});

export type RetainedDelivery = typeof RetainedDelivery.Type;

/**
 * One mailbox's deliveries.
 *
 * @property readyAt - when the mailbox next needs processing: a lease deadline, a retry, due output, or waiting events
 */
export const DeliverySlot = Schema.Struct({
    active: Schema.NullOr(ActiveDelivery),
    readyAt: Schema.NullOr(Timestamp),
    retained: Schema.Array(RetainedDelivery),
});

export type DeliverySlot = typeof DeliverySlot.Type;

export const emptyDeliverySlot = DeliverySlot.make({ active: null, readyAt: null, retained: [] });

/**
 * The part of an `ActiveDelivery` that Postgres and Redis keep as one JSON value. They keep the batch
 * ID, token, admissions, callback choice, and stage in columns or fields of their own.
 */
export const StoredActiveDelivery = ActiveDelivery.mapFields(
    Struct.omit(['batchId', 'accessToken', 'admissions', 'prepared', 'stage']),
);

export interface StoredActiveDelivery extends Schema.Schema.Type<typeof StoredActiveDelivery> {}

/**
 * How a polling store's scheduler sees a mailbox: no active delivery, one waiting to retry, or one in
 * any other stage. Postgres and Redis keep it beside the slot.
 */
export const MailboxSchedulerStatus = Schema.Literals(['idle', 'active', 'retry']);

export type MailboxSchedulerStatus = typeof MailboxSchedulerStatus.Type;

export const mailboxSchedulerStatus = (slot: DeliverySlot): MailboxSchedulerStatus => {
    if (Predicate.isNull(slot.active)) return 'idle';

    return slot.active.stage === 'Retry' ? 'retry' : 'active';
};

/** What a transition needs to know about the rest of the mailbox. */
export type MailboxFacts = {
    readonly now: number;
    readonly hasWaiting: boolean;
};

/** A slot after a claim, and the delivery the claim now owns, if any. */
export type DeliverySlotClaim = {
    readonly slot: DeliverySlot;
    readonly claimed: ActiveDelivery | null;
};

/** The claim does not own the batch, or the batch is not in a stage the operation allows. */
export class ClaimNotOwned extends Schema.TaggedError<ClaimNotOwned, { readonly brand: unique symbol }>()(
    'ClaimNotOwned',
    {},
) {}

/** A different preparation is already saved. */
export class PreparationMismatch extends Schema.TaggedError<PreparationMismatch, { readonly brand: unique symbol }>()(
    'PreparationMismatch',
    { batchId: BatchId },
) {}

/**
 * What due work the active delivery has: its callback to run, or output to send. Takes only the
 * stage, so a store that keeps the stage in its own column can ask without loading the delivery.
 */
export const activeDeliveryWork = (active: { readonly stage: ActiveDeliveryStage }): 'Callback' | 'Output' =>
    active.stage === 'ExternalWaiting' || active.stage === 'Finishing' ? 'Output' : 'Callback';

/** The operation that runs next. Operations run in order, so a later one waits for this one to settle. */
const nextOperation = (active: ActiveDelivery) =>
    Option.getOrUndefined(Arr.findFirst(active.operations, isUnsettledOperation));

/** When the next operation is due: when it is ready, or when its attempt's lease runs out. */
const nextOutputAt = (active: ActiveDelivery): number | null => {
    const next = nextOperation(active);

    if (next === undefined) return null;

    return DeliveryOperationState.match(next.state, {
        Pending: ({ readyAt }) => readyAt,
        Delivering: ({ leaseUntil }) => leaseUntil,
        Delivered: () => null,
        Failed: () => null,
    });
};

/**
 * When a handed-off delivery fails on its own: its time limit, while it waits for its remote worker with
 * no result. None otherwise.
 */
const deadline = (active: ActiveDelivery): number | null =>
    active.stage === 'ExternalWaiting' && active.terminal === undefined ? (active.failAt ?? null) : null;

/** When the delivery next needs processing: its next output, or its time limit, whichever is first. */
const nextDueAt = (active: ActiveDelivery): number | null =>
    Arr.match(Arr.filter([nextOutputAt(active), deadline(active)], Predicate.isNotNull), {
        onEmpty: () => null,
        onNonEmpty: (times) => Math.min(...times),
    });

/** Start a handed-off delivery's time limit again from `now`, after a request from its remote worker. */
const withDeadlineFrom = (active: ActiveDelivery, now: number): ActiveDelivery =>
    active.failAfterMs === undefined || active.handedOffAt === undefined || active.terminal !== undefined
        ? active
        : ActiveDelivery.make({ ...active, failAt: Timestamp.make(now + active.failAfterMs) });

/** Only the current step may control provider output or remote mutations. */
export const currentPreparedCallback = (active: ActiveDelivery) => active.prepared?.callbacks[active.callbackIndex];

/** Retain the completed step and rotate its identity before making the next step claimable. */
const finishStep = (slot: DeliverySlot, active: ActiveDelivery, facts: MailboxFacts): DeliverySlot => {
    const entry = {
        batchId: active.batchId,
        callbackIndex: active.callbackIndex,
        accessToken: active.accessToken,
        supportedOperations: currentPreparedCallback(active)?.supportedOperations ?? [],
        interruptRequested: active.interruptRequestedAt !== undefined,
        retainUntil: Timestamp.make(facts.now + DELIVERY_RETENTION_MS),
        links: active.links,
        output: Arr.map(active.operations, deliveryOutputStatus),
    };

    const withTerminal = Predicate.isUndefined(active.terminal) ? entry : { ...entry, terminal: active.terminal };

    const retiredEntry = RetainedDelivery.make(
        Predicate.isUndefined(active.plan) ? withTerminal : { ...withTerminal, plan: deliveryPlanStatus(active.plan) },
    );

    const retained = Arr.takeRight(
        [...Arr.filter(slot.retained, ({ retainUntil }) => retainUntil > facts.now), retiredEntry],
        MAX_RETAINED_DELIVERIES,
    );

    /** The step retired, waking the events waiting behind it. */
    const retired = DeliverySlot.make({
        active: null,
        readyAt: facts.hasWaiting ? Timestamp.make(facts.now) : null,
        retained,
    });

    const callbackIndex = active.callbackIndex + 1;
    const accessToken = active.callbackAccessTokens?.[callbackIndex];

    const remoteSucceeded =
        active.terminal === undefined
            ? active.handedOffAt === undefined
            : Predicate.isTagged(active.terminal.outcome, 'Completed');

    if (
        active.continuationAllowed !== true ||
        !remoteSucceeded ||
        Arr.some(active.operations, ({ state }) => Predicate.isTagged(state, 'Failed')) ||
        active.prepared?.callbacks[callbackIndex] === undefined ||
        accessToken === undefined
    )
        return retired;

    const next = ActiveDelivery.make({
        batchId: active.batchId,
        admissions: active.admissions,
        prepared: active.prepared,
        callbackAccessTokens: active.callbackAccessTokens,
        callbackIndex,
        accessToken,
        attempt: 0,
        claimId: null,
        stage: 'Retry',
        links: [],
        operations: [],
    });

    return withActive(retired, next, facts.now);
};

const withActive = (slot: DeliverySlot, active: ActiveDelivery, readyAt: number | null): DeliverySlot =>
    DeliverySlot.make({
        ...slot,
        active,
        readyAt: readyAt === null ? null : Timestamp.make(readyAt),
    });

/**
 * Settle a delivery whose callback code has stopped. A handed-off delivery without a result waits for
 * its remote worker. Any other sends the output it still owes, then retires.
 */
const afterCallback = (slot: DeliverySlot, active: ActiveDelivery, facts: MailboxFacts): DeliverySlot => {
    if (active.handedOffAt !== undefined && active.terminal === undefined) {
        const waiting = ActiveDelivery.make({ ...active, stage: 'ExternalWaiting', claimId: null });

        return withActive(slot, waiting, nextDueAt(waiting));
    }

    if (nextOperation(active) === undefined) return finishStep(slot, active, facts);
    const finishing = ActiveDelivery.make({ ...active, stage: 'Finishing', claimId: null });

    return withActive(slot, finishing, nextDueAt(finishing));
};

/** Add operations, each with the next free ID of its kind. Output is due at `now`. */
const withOperations = (
    active: ActiveDelivery,
    operations: ReadonlyArray<DeliveryOutputOperation>,
    now: number,
): ActiveDelivery => {
    const added = Arr.reduce(operations, active.operations, (saved, operation) => {
        const links = () =>
            Arr.filter(saved, ({ operation }) => Predicate.isTagged(operation, 'AddExternalLink')).length;

        const messages = () =>
            Arr.filter(
                saved,
                ({ operation }) =>
                    Predicate.isTagged(operation, 'CreateMessage') ||
                    Predicate.isTagged(operation, 'UpdateMessage') ||
                    Predicate.isTagged(operation, 'DeleteMessage'),
            ).length;

        const activities = () =>
            Arr.filter(saved, ({ operation }) => Predicate.isTagged(operation, 'SetActivity')).length;

        const reactions = () =>
            Arr.filter(saved, ({ operation }) => Predicate.isTagged(operation, 'SetMessageReaction')).length;

        const plans = () => Arr.filter(saved, ({ operation }) => Predicate.isTagged(operation, 'RenderPlan')).length;

        const operationId = Match.value(operation).pipe(
            Match.tagsExhaustive({
                PresentOutcome: () => 'outcome',
                AddExternalLink: () => `link-${links() + 1}`,
                CreateMessage: () => `message-${messages() + 1}`,
                UpdateMessage: () => `message-${messages() + 1}`,
                DeleteMessage: () => `message-${messages() + 1}`,
                SetActivity: () => `activity-${activities() + 1}`,
                SetMessageReaction: () => `reaction-${reactions() + 1}`,
                RenderPlan: () => `plan-${plans() + 1}`,
            }),
        );

        return [
            ...saved,
            DeliveryOperation.make({
                operationId: DeliveryOperationId.make(operationId),
                operation,
                state: DeliveryOperationState.cases.Pending.make({ readyAt: Timestamp.make(now) }),
                attempt: 0,
                hadAmbiguousAttempt: false,
            }),
        ];
    });

    return ActiveDelivery.make({ ...active, operations: added });
};

/** The saved `CreateMessage` of a message, if the delivery has created it. */
const messageCreation = (active: ActiveDelivery, messageId: MessageId) =>
    Option.getOrUndefined(
        Arr.findFirst(
            active.operations,
            ({ operation }) => Predicate.isTagged(operation, 'CreateMessage') && operation.messageId === messageId,
        ),
    );

/**
 * The provider's reference to a message the delivery posted: the receipt of its `CreateMessage`.
 * None while the create has not been applied, or when it failed.
 */
export const sentMessageReference = (
    active: ActiveDelivery,
    messageId: MessageId,
): ProviderMessageReference | undefined => {
    const state = messageCreation(active, messageId)?.state;

    return state !== undefined && Predicate.isTagged(state, 'Delivered') ? state.receipt : undefined;
};

/** The last saved `SetActivity`, which holds the activity the remote worker last asked for. */
const lastActivityOperation = (active: ActiveDelivery) =>
    Option.getOrUndefined(
        Arr.findLast(active.operations, ({ operation }) => Predicate.isTagged(operation, 'SetActivity')),
    );

/** The activity the remote worker last asked for. `Idle` when it never asked. */
const desiredActivity = (active: ActiveDelivery): DeliveryActivity => {
    const last = lastActivityOperation(active)?.operation;

    return last !== undefined && Predicate.isTagged(last, 'SetActivity')
        ? last.activity
        : DeliveryActivity.cases.Idle.make({});
};

/** Whether the delivery's last activity request was `Working`, so ending it must clear the provider's activity. */
export const activityToClear = (active: ActiveDelivery) => Predicate.isTagged(desiredActivity(active), 'Working');

/** The plan the provider last showed, with its presentation. None until a `RenderPlan` has been applied. */
export const renderedDeliveryPlan = (active: ActiveDelivery): RenderedDeliveryPlan | undefined => active.plan?.rendered;

/** The saved `SetMessageReaction` operations for one reaction on one target, oldest first. */
const reactionsOn = (
    operations: ReadonlyArray<DeliveryOperation>,
    key: { readonly target: DeliveryReactionTarget; readonly reaction: PortableReaction },
) =>
    Arr.flatMap(operations, (saved) => {
        const { operation } = saved;

        return Predicate.isTagged(operation, 'SetMessageReaction') &&
            operation.reaction === key.reaction &&
            sameDeliveryReactionTarget(operation.target, key.target)
            ? [{ saved, request: operation }]
            : [];
    });

/**
 * For a removal, the provider's receipt for the add it undoes: the last add of the same reaction on the
 * same target that the provider applied before this operation, unless an applied removal came after it.
 */
export const reactionAddedReference = (
    active: ActiveDelivery,
    operation: DeliveryOperation,
): ProviderMessageReference | undefined => {
    const request = operation.operation;

    if (!Predicate.isTagged(request, 'SetMessageReaction') || request.active) return undefined;

    const earlier = Arr.takeWhile(active.operations, ({ operationId }) => operationId !== operation.operationId);

    /** The last change the provider applied decides: an add leaves its receipt, a removal leaves none. */
    const lastApplied = Arr.findLast(reactionsOn(earlier, request), ({ saved }) =>
        Predicate.isTagged(saved.state, 'Delivered'),
    );

    return Option.getOrUndefined(
        Option.flatMap(lastApplied, ({ saved, request: change }) =>
            change.active && Predicate.isTagged(saved.state, 'Delivered')
                ? Option.fromNullishOr(saved.state.receipt)
                : Option.none(),
        ),
    );
};

/** Save links and an `AddExternalLink` operation for each. */
const withLinks = (active: ActiveDelivery, links: ReadonlyArray<ExternalLink>, now: number) =>
    withOperations(
        ActiveDelivery.make({ ...active, links: [...active.links, ...links] }),
        Arr.map(links, (link) => AddExternalLink.make({ link })),
        now,
    );

/** The owned active delivery, when `claimId` owns it in a stage where callback code may be running. */
const owned = (slot: DeliverySlot, claimId: string) =>
    slot.active !== null &&
    slot.active.claimId === claimId &&
    (slot.active.stage === 'Local' || slot.active.stage === 'ExternalCleaning')
        ? slot.active
        : null;

/**
 * Start a new batch in an idle slot. The store has already chosen its admissions.
 * Returns null when the slot already has an active delivery.
 */
export const startDeliveryBatch = (
    slot: DeliverySlot,
    input: {
        readonly batchId: BatchId;
        readonly accessToken: DeliveryAccessToken;
        readonly admissions: DeliveryAdmissionBatch;
        readonly claimId: string;
        readonly leaseMs: number;
        readonly now: number;
    },
): { readonly slot: DeliverySlot; readonly claimed: ActiveDelivery } | null => {
    if (slot.active !== null) return null;

    const claimed = ActiveDelivery.make({
        batchId: input.batchId,
        callbackIndex: 0,
        accessToken: input.accessToken,
        admissions: input.admissions,
        attempt: 1,
        claimId: input.claimId,
        stage: 'Local',
        links: [],
        operations: [],
    });

    return { slot: withActive(slot, claimed, input.now + input.leaseMs), claimed };
};

/**
 * Take the frozen batch again after a retry comes due or a lease runs out.
 *
 * A lease that ran out after a handoff does not run the callback again: the handoff stands, so the
 * delivery waits for its remote worker, or finishes if the remote worker already sent a result.
 */
export const claimFrozenBatch = (
    slot: DeliverySlot,
    input: { readonly claimId: string; readonly leaseMs: number } & MailboxFacts,
): DeliverySlotClaim => {
    const active = slot.active;

    if (active === null || slot.readyAt === null || slot.readyAt > input.now) return { slot, claimed: null };

    if (activeDeliveryWork(active) === 'Output') return { slot, claimed: null };

    if (active.terminal !== undefined || active.stage === 'ExternalCleaning') {
        return { slot: afterCallback(slot, active, input), claimed: null };
    }

    const claimed = ActiveDelivery.make({
        ...active,
        stage: 'Local',
        claimId: input.claimId,
        attempt: active.attempt + 1,
    });

    return { slot: withActive(slot, claimed, input.now + input.leaseMs), claimed };
};

/** Move a live claim's lease forward. */
export const renewDeliveryClaim = Effect.fn('delivery.lifecycle.renew_claim')(function* (
    slot: DeliverySlot,
    input: { readonly claimId: string; readonly leaseMs: number; readonly now: number },
) {
    const active = owned(slot, input.claimId);

    if (active === null) return yield* ClaimNotOwned.make();

    return withActive(slot, active, input.now + input.leaseMs);
});

/** Save the callback choice and destination, once per batch. */
export const prepareDeliverySlot = Effect.fn('delivery.lifecycle.prepare')(function* (
    slot: DeliverySlot,
    input: {
        readonly claimId: string;
        readonly prepared: PreparedDeliveryInvocation;
        readonly callbackAccessTokens: readonly [DeliveryAccessToken, ...DeliveryAccessToken[]];
    },
): Effect.fn.Return<
    { readonly slot: DeliverySlot; readonly prepared: PreparedDeliveryInvocation },
    ClaimNotOwned | PreparationMismatch
> {
    const active = owned(slot, input.claimId);

    if (active === null) return yield* ClaimNotOwned.make();

    if (active.prepared !== undefined) {
        if (!Schema.toEquivalence(PreparedDeliveryInvocation)(active.prepared, input.prepared)) {
            return yield* PreparationMismatch.make({ batchId: active.batchId });
        }

        return { slot, prepared: active.prepared };
    }

    if (
        input.callbackAccessTokens.length !== input.prepared.callbacks.length ||
        input.callbackAccessTokens[0] !== active.accessToken ||
        new Set(input.callbackAccessTokens).size !== input.callbackAccessTokens.length
    ) {
        return yield* PreparationMismatch.make({ batchId: active.batchId });
    }

    const next = ActiveDelivery.make({
        ...active,
        prepared: input.prepared,
        callbackAccessTokens: input.callbackAccessTokens,
    });

    return { slot: withActive(slot, next, slot.readyAt), prepared: input.prepared };
});

/**
 * Hand the batch off, saving any new links with an `AddExternalLink` each, and its time limit, when it
 * has one. Repeating it is harmless. The claim stays as ownership of callback cleanup; the links are
 * sent once the callback returns.
 */
export const handOffDeliverySlot = Effect.fn('delivery.lifecycle.hand_off')(function* (
    slot: DeliverySlot,
    input: {
        readonly claimId: string;
        readonly handedOffAt: number;
        readonly links: ReadonlyArray<ExternalLink>;
        readonly failAfterMs?: number;
    },
) {
    const active = owned(slot, input.claimId);

    if (active === null) return yield* ClaimNotOwned.make();

    if (active.stage === 'ExternalCleaning') return slot;

    const handedOff = ActiveDelivery.make({
        ...active,
        stage: 'ExternalCleaning',
        handedOffAt: Timestamp.make(input.handedOffAt),
    });

    const limited = Predicate.isUndefined(input.failAfterMs)
        ? handedOff
        : withDeadlineFrom(ActiveDelivery.make({ ...handedOff, failAfterMs: input.failAfterMs }), input.handedOffAt);

    /** Links not already saved, each once. A repeat of a saved URL is a replay. */
    const newLinks = Arr.reduce(input.links, Arr.empty<ExternalLink>(), (fresh, link) =>
        Arr.some([...active.links, ...fresh], ({ url }) => url === link.url) ? fresh : [...fresh, link],
    );

    const next = withLinks(limited, newLinks, input.handedOffAt);

    return withActive(slot, next, slot.readyAt);
});

/**
 * Record how an attempt ended. The stage decides, not only the result: a handed-off delivery waits
 * for its remote worker whatever the callback returned, and one with a remote result finishes.
 */
export const recordDeliveryAttempt = Effect.fn('delivery.lifecycle.record_attempt')(function* (
    slot: DeliverySlot,
    input: {
        readonly claimId: string;
        readonly retryAfterMs: number | null;
        readonly succeeded: boolean;
    } & MailboxFacts,
) {
    const active = owned(slot, input.claimId);

    if (active === null) return yield* ClaimNotOwned.make();

    if (active.terminal === undefined && active.stage === 'Local' && input.retryAfterMs !== null) {
        const next = ActiveDelivery.make({ ...active, stage: 'Retry', claimId: null });

        return withActive(slot, next, input.now + input.retryAfterMs);
    }

    return afterCallback(slot, ActiveDelivery.make({ ...active, continuationAllowed: input.succeeded }), input);
});

/** An event asked the current delivery to stop. Marks it once; the event itself still waits its turn. */
export const requestDeliveryInterrupt = (slot: DeliverySlot, now: number): DeliverySlot =>
    slot.active === null || slot.active.interruptRequestedAt !== undefined
        ? slot
        : DeliverySlot.make({
              ...slot,
              active: ActiveDelivery.make({ ...slot.active, interruptRequestedAt: Timestamp.make(now) }),
          });

/**
 * An output operation claimed by one attempt, with the delivery it belongs to.
 *
 * @property idempotencyKey - the operation's key, the same on every attempt at it
 */
export type DeliveryOutputClaim = {
    readonly slot: DeliverySlot;
    readonly claimed: {
        readonly active: ActiveDelivery;
        readonly operation: DeliveryOperation;
        readonly idempotencyKey: string;
    } | null;
};

/**
 * Claim the next operation when it is due. An operation whose earlier attempt's lease ran out is
 * claimed again and marked ambiguous: the provider may already have applied it. A handed-off delivery
 * past its time limit first fails on its own, and its `PresentOutcome` is claimed.
 *
 * The first claim gives the operation `idempotencyKey`, a random UUID the caller made; later claims
 * keep the one it has, so every attempt sends the same key.
 */
export const claimDeliveryOutput = (
    slot: DeliverySlot,
    input: {
        readonly claimId: string;
        readonly leaseMs: number;
        readonly now: number;
        readonly idempotencyKey: string;
    },
): DeliveryOutputClaim => {
    const active = slot.active;

    if (active === null || activeDeliveryWork(active) !== 'Output') return { slot, claimed: null };
    /**
     * Fail a handed-off delivery whose remote worker sent nothing before its time limit: save the `Failed`
     * result, with reason `TimedOut`, and the `PresentOutcome` that shows it. Any other delivery is unchanged.
     */
    const due = deadline(active);

    const timedOut = DeliveryTerminal.make({
        outcome: DeliveryOutcome.cases.Failed.make({ reason: 'TimedOut' }),
        markdown: DELIVERY_TIMED_OUT_MARKDOWN,
    });

    const current =
        due === null || due > input.now
            ? active
            : ActiveDelivery.make({
                  ...withOperations(
                      ActiveDelivery.make({ ...active, terminal: timedOut }),
                      [
                          PresentOutcome.make({
                              outcome: timedOut.outcome,
                              markdown: DELIVERY_TIMED_OUT_MARKDOWN,
                          }),
                      ],
                      input.now,
                  ),
                  stage: 'Finishing',
              });

    const next = nextOperation(current);
    const dueAt = nextOutputAt(current);

    if (next === undefined || dueAt === null || dueAt > input.now) return { slot, claimed: null };
    const idempotencyKey = next.idempotencyKey ?? input.idempotencyKey;

    const operation = DeliveryOperation.make({
        ...next,
        state: DeliveryOperationState.cases.Delivering.make({
            claimId: input.claimId,
            leaseUntil: Timestamp.make(input.now + input.leaseMs),
        }),
        attempt: next.attempt + 1,
        hadAmbiguousAttempt: next.hadAmbiguousAttempt || Predicate.isTagged(next.state, 'Delivering'),
        idempotencyKey,
    });

    const claimed = replaceOperation(current, operation);

    return {
        slot: withActive(slot, claimed, nextDueAt(claimed)),
        claimed: { active: claimed, operation, idempotencyKey },
    };
};

/** The operation `claimId` is delivering, if it still is. */
const ownedOperation = (slot: DeliverySlot, input: { readonly operationId: string; readonly claimId: string }) => {
    const active = slot.active;

    if (active === null) return null;

    const found = Arr.findFirst(active.operations, ({ operationId }) => operationId === input.operationId);

    if (Option.isNone(found)) return null;
    const operation = found.value;
    const { state } = operation;

    return Predicate.isTagged(state, 'Delivering') && state.claimId === input.claimId ? { active, operation } : null;
};

const replaceOperation = (active: ActiveDelivery, operation: DeliveryOperation) =>
    ActiveDelivery.make({
        ...active,
        operations: Arr.map(active.operations, (saved) =>
            saved.operationId === operation.operationId ? operation : saved,
        ),
    });

/** Move a live output attempt's lease forward. */
export const renewDeliveryOutput = Effect.fn('delivery.lifecycle.renew_output')(function* (
    slot: DeliverySlot,
    input: {
        readonly operationId: string;
        readonly claimId: string;
        readonly leaseMs: number;
        readonly now: number;
    },
) {
    const owner = ownedOperation(slot, input);

    if (owner === null) return yield* ClaimNotOwned.make();

    const active = replaceOperation(
        owner.active,
        DeliveryOperation.make({
            ...owner.operation,
            state: DeliveryOperationState.cases.Delivering.make({
                claimId: input.claimId,
                leaseUntil: Timestamp.make(input.now + input.leaseMs),
            }),
        }),
    );

    return withActive(slot, active, nextDueAt(active));
});

/**
 * Record how an output attempt ended. A finishing delivery whose output is all settled retires and
 * wakes the events waiting behind it.
 */
export const settleDeliveryOutput = Effect.fn('delivery.lifecycle.settle_output')(function* (
    slot: DeliverySlot,
    input: {
        readonly operationId: string;
        readonly claimId: string;
        readonly settlement: DeliveryOutputSettlement;
    } & MailboxFacts,
) {
    const owner = ownedOperation(slot, input);

    if (owner === null) return yield* ClaimNotOwned.make();

    const state = Match.value(input.settlement).pipe(
        Match.tagsExhaustive({
            Applied: ({ receipt }) =>
                DeliveryOperationState.cases.Delivered.make(Predicate.isUndefined(receipt) ? {} : { receipt }),
            Retry: ({ readyAt }) => DeliveryOperationState.cases.Pending.make({ readyAt }),
            Failed: ({ safeCode }) => DeliveryOperationState.cases.Failed.make({ safeCode }),
        }),
    );

    const settled = replaceOperation(owner.active, DeliveryOperation.make({ ...owner.operation, state }));

    const request = owner.operation.operation;

    /**
     * Record what an applied `RenderPlan` showed: exactly the plan it sent, never a newer desired plan that
     * arrived while it ran, and the provider's presentation from its receipt.
     */
    const shownPlan = settled.plan;

    const active =
        Predicate.isTagged(request, 'RenderPlan') &&
        Predicate.isTagged(state, 'Delivered') &&
        shownPlan !== undefined &&
        (shownPlan.rendered === undefined || shownPlan.rendered.revision < request.revision)
            ? ActiveDelivery.make({
                  ...settled,
                  plan: DeliveryPlanState.make({
                      ...shownPlan,
                      rendered: RenderedDeliveryPlan.make(
                          Predicate.isUndefined(state.receipt)
                              ? { revision: request.revision, plan: request.plan }
                              : { revision: request.revision, plan: request.plan, presentation: state.receipt },
                      ),
                  }),
              })
            : settled;

    if (active.stage === 'Finishing' && nextOperation(active) === undefined) return finishStep(slot, active, input);

    return withActive(slot, active, nextDueAt(active));
});

type Located = Data.TaggedEnum<{
    Active: { readonly active: ActiveDelivery };
    Retained: { readonly retained: RetainedDelivery };
}>;

const Located = Data.taggedEnum<Located>();

/** Find the delivery and check the token. A missing delivery and a wrong token look the same. */
const locate = (
    slot: DeliverySlot,
    input: {
        readonly reference: DeliveryReference;
        readonly accessToken: string;
        readonly now: number;
    },
): Located | null => {
    const matches = (saved: string) => deliveryAccessTokenMatches({ saved, presented: input.accessToken });

    if (
        slot.active !== null &&
        slot.active.batchId === input.reference.batchId &&
        slot.active.callbackIndex === input.reference.callbackIndex
    ) {
        return matches(slot.active.accessToken) ? Located.Active({ active: slot.active }) : null;
    }

    const retained = Arr.findFirst(
        slot.retained,
        ({ batchId, callbackIndex, retainUntil }) =>
            batchId === input.reference.batchId &&
            callbackIndex === input.reference.callbackIndex &&
            retainUntil > input.now,
    );

    return Option.isSome(retained) && matches(retained.value.accessToken)
        ? Located.Retained({ retained: retained.value })
        : null;
};

/** A status with the outcome and plan the delivery has, when it has them. */
const statusWith = (
    status: Omit<DeliveryStatus, '_tag' | 'outcome' | 'plan'>,
    terminal: DeliveryTerminal | undefined,
    plan: DeliveryPlanStatus | undefined,
) => {
    const withOutcome = Predicate.isUndefined(terminal) ? status : { ...status, outcome: terminal.outcome };

    return DeliveryStatus.make(Predicate.isUndefined(plan) ? withOutcome : { ...withOutcome, plan });
};

/** What a remote worker may read about its delivery. */
export const readDeliverySlotStatus = Effect.fn('delivery.lifecycle.read_status')(function* (
    slot: DeliverySlot,
    input: {
        readonly reference: DeliveryReference;
        readonly accessToken: string;
        readonly now: number;
    },
): Effect.fn.Return<DeliveryStatus, DeliveryNotFound> {
    const located = locate(slot, input);

    if (located === null) return yield* DeliveryNotFound.make();

    return Located.$match(located, {
        Active: ({ active }) => {
            const stage: DeliveryStage =
                /** A delivery with a result whose callback is still returning is finishing. */
                active.terminal === undefined ? active.stage : 'Finishing';

            const status = {
                deliveryId: input.reference.deliveryId,
                stage,
                /** A result clears the activity, so a finishing delivery shows `Idle`. */
                activity:
                    active.terminal === undefined ? desiredActivity(active) : DeliveryActivity.cases.Idle.make({}),
                interruptRequested: active.interruptRequestedAt !== undefined,
                supportedOperations: currentPreparedCallback(active)?.supportedOperations ?? [],
                reactionTargets: currentPreparedCallback(active)?.reactionTargets ?? [],
                output: Arr.map(active.operations, deliveryOutputStatus),
            };

            /** Only a delivery still waiting for its result has a time limit. */
            const failAt = active.terminal === undefined ? active.failAt : undefined;

            return statusWith(
                Predicate.isUndefined(failAt) ? status : { ...status, failAt },
                active.terminal,
                Predicate.isUndefined(active.plan) ? undefined : deliveryPlanStatus(active.plan),
            );
        },
        Retained: ({ retained }) =>
            statusWith(
                {
                    deliveryId: input.reference.deliveryId,
                    stage: 'Retired',
                    interruptRequested: retained.interruptRequested,
                    supportedOperations: retained.supportedOperations,
                    reactionTargets: [],
                    output: retained.output,
                },
                retained.terminal,
                retained.plan,
            ),
    });
});

type MutationChange = Effect.Effect<
    { readonly slot: DeliverySlot; readonly receipt: DeliveryMutationReceipt },
    | DeliveryNotFound
    | DeliveryTerminalConflict
    | DeliveryClosed
    | DeliveryOperationUnsupported
    | DeliveryMessageNotFound
    | DeliveryMessageDeleted
    | DeliveryMessageConflict
    | DeliveryReactionTargetUnavailable
>;

/** What every change needs: the slot, the delivery it names, and how to answer. */
type MutationContext = {
    readonly slot: DeliverySlot;
    readonly located: Located;
    readonly receipt: (status: DeliveryMutationReceipt['status']) => DeliveryMutationReceipt;
} & MailboxFacts;

/**
 * Record a remote worker's final result, and the `PresentOutcome` that shows it, in one change.
 *
 * - The same result again is `already_recorded`; a different one is a conflict.
 * - A delivery with no callback running starts finishing at once.
 * - A delivery whose callback is still running keeps the result and finishes when the callback returns.
 * - A delivery that ended without a remote result is closed.
 */
const recordTerminal = (context: MutationContext, terminal: DeliveryTerminal): MutationChange => {
    const { slot } = context;

    const replay = (saved: DeliveryTerminal | undefined) => {
        if (saved === undefined) return Effect.fail(DeliveryClosed.make());

        return sameDeliveryTerminal(saved, terminal)
            ? Effect.succeed({ slot, receipt: context.receipt('already_recorded') })
            : Effect.fail(DeliveryTerminalConflict.make());
    };

    return Located.$match(context.located, {
        Retained: ({ retained }) => replay(retained.terminal),
        Active: ({ active }) => {
            if (active.terminal !== undefined || active.stage === 'Finishing') return replay(active.terminal);

            const present = PresentOutcome.make(
                Predicate.isUndefined(terminal.markdown)
                    ? { outcome: terminal.outcome }
                    : { outcome: terminal.outcome, markdown: terminal.markdown },
            );

            const next = withOperations(ActiveDelivery.make({ ...active, terminal }), [present], context.now);

            /** No callback code is running in these stages, so the output can start now. */
            const nextSlot =
                active.stage === 'ExternalWaiting' || active.stage === 'Retry'
                    ? afterCallback(slot, next, context)
                    : withActive(slot, next, slot.readyAt);

            return Effect.succeed({ slot: nextSlot, receipt: context.receipt('accepted') });
        },
    });
};

/** What a message change asks of the delivery: nothing new, or one more operation. */
type MessageDecision = Effect.Effect<
    'Replay' | DeliveryOutputOperation,
    DeliveryClosed | DeliveryMessageNotFound | DeliveryMessageDeleted | DeliveryMessageConflict
>;

/**
 * Save a message change and the operation that shows it, in one change. A retired delivery takes none.
 *
 * - A repeat of a change already saved is a replay, even after the delivery ended.
 * - Any other change after the delivery ended is refused.
 * - A change to a message never created, or whose create failed, names no message.
 * - An update or deletion of a message whose create has not run yet is saved behind it.
 */
const changeMessage = (context: MutationContext, mutation: DeliveryMessageMutation): MutationChange =>
    Located.$match(context.located, {
        Retained: () => Effect.fail(DeliveryClosed.make()),
        Active: ({ active }) => {
            const closed = active.terminal !== undefined || active.stage === 'Finishing';
            const { messageId } = mutation;

            const operations = Arr.filter(
                Arr.map(active.operations, ({ operation }) => operation),
                (operation) => operationMessageId(operation) === messageId,
            );

            const creation = messageCreation(active, messageId);

            const deleted = Arr.some(operations, (operation) => Predicate.isTagged(operation, 'DeleteMessage'));

            const refuse = <E>(error: E) => Effect.fail(closed ? DeliveryClosed.make() : error);

            const accept = (operation: DeliveryOutputOperation): MessageDecision =>
                closed ? Effect.fail(DeliveryClosed.make()) : Effect.succeed(operation);

            const replay: MessageDecision = Effect.succeed('Replay');

            const decision = Match.value(mutation).pipe(
                Match.tagsExhaustive({
                    CreateDeliveryMessage: ({ markdown }): MessageDecision => {
                        if (creation === undefined) return accept(CreateMessage.make({ messageId, markdown }));

                        return Predicate.isTagged(creation.operation, 'CreateMessage') &&
                            creation.operation.markdown === markdown
                            ? replay
                            : Effect.fail(DeliveryMessageConflict.make({ messageId }));
                    },
                    UpdateDeliveryMessage: ({ markdown }): MessageDecision => {
                        if (creation === undefined || Predicate.isTagged(creation.state, 'Failed')) {
                            return refuse(DeliveryMessageNotFound.make({ messageId }));
                        }

                        if (deleted) return refuse(DeliveryMessageDeleted.make({ messageId }));

                        const latestMarkdown = Arr.reduce(operations, Option.none<string>(), (text, operation) =>
                            Match.value(operation).pipe(
                                Match.tag('CreateMessage', 'UpdateMessage', (change) => Option.some(change.markdown)),
                                Match.orElse(() => text),
                            ),
                        );

                        if (Option.contains(latestMarkdown, markdown)) return replay;

                        return accept(UpdateMessage.make({ messageId, markdown }));
                    },
                    DeleteDeliveryMessage: (): MessageDecision => {
                        if (creation === undefined || Predicate.isTagged(creation.state, 'Failed')) {
                            return refuse(DeliveryMessageNotFound.make({ messageId }));
                        }

                        return deleted ? replay : accept(DeleteMessage.make({ messageId }));
                    },
                }),
            );

            return Effect.map(decision, (decided) => {
                if (decided === 'Replay') return { slot: context.slot, receipt: context.receipt('already_recorded') };
                const next = withOperations(active, [decided], context.now);
                /** A delivery waiting for its remote worker has no callback running, so the output can start now. */
                const readyAt = active.stage === 'ExternalWaiting' ? nextDueAt(next) : context.slot.readyAt;

                return {
                    slot: withActive(context.slot, next, readyAt),
                    receipt: context.receipt('accepted'),
                };
            });
        },
    });

/**
 * A waiting desired-state operation, such as `SetActivity`, given a new request. It drops its
 * idempotency key: an earlier attempt may have applied the old request under that key, so the new one
 * needs its own.
 */
const replacedRequest = (saved: DeliveryOperation, operation: DeliveryOutputOperation) =>
    DeliveryOperation.make({
        operationId: saved.operationId,
        operation,
        state: saved.state,
        attempt: saved.attempt,
        hadAmbiguousAttempt: saved.hadAmbiguousAttempt,
    });

type ReactionTargetCheck = Effect.Effect<
    void,
    DeliveryReactionTargetUnavailable | DeliveryMessageNotFound | DeliveryMessageDeleted
>;

/**
 * How each change applies to the delivery it names, by the change's tag. Each entry takes the change,
 * then the context it runs in, so `Match.tagsExhaustive` over a mutation picks the entry for it.
 */
const mutationChanges = {
    CompleteDelivery: (mutation: CompleteDelivery) => (context: MutationContext) =>
        recordTerminal(context, terminalFromMutation(mutation)),
    FailDelivery: (mutation: FailDelivery) => (context: MutationContext) =>
        recordTerminal(context, terminalFromMutation(mutation)),
    /**
     * Add a link, and the `AddExternalLink` that shows it, in one change. A URL already added is a replay,
     * even after the delivery ended. A new link after the delivery ended is refused.
     */
    AddDeliveryLink:
        ({ link }: AddDeliveryLink) =>
        (context: MutationContext): MutationChange => {
            const { slot } = context;

            const saved = Located.$match(context.located, {
                Active: ({ active }) => active.links,
                Retained: ({ retained }) => retained.links,
            });

            if (Arr.some(saved, ({ url }) => url === link.url)) {
                return Effect.succeed({ slot, receipt: context.receipt('already_recorded') });
            }

            return Located.$match(context.located, {
                Retained: () => Effect.fail(DeliveryClosed.make()),
                Active: ({ active }) => {
                    if (active.terminal !== undefined || active.stage === 'Finishing')
                        return Effect.fail(DeliveryClosed.make());
                    const next = withLinks(active, [link], context.now);
                    /** A delivery waiting for its remote worker has no callback running, so the output can start now. */
                    const readyAt = active.stage === 'ExternalWaiting' ? nextDueAt(next) : slot.readyAt;

                    return Effect.succeed({
                        slot: withActive(slot, next, readyAt),
                        receipt: context.receipt('accepted'),
                    });
                },
            });
        },
    CreateDeliveryMessage: (mutation: CreateDeliveryMessage) => (context: MutationContext) =>
        changeMessage(context, mutation),
    UpdateDeliveryMessage: (mutation: UpdateDeliveryMessage) => (context: MutationContext) =>
        changeMessage(context, mutation),
    DeleteDeliveryMessage: (mutation: DeleteDeliveryMessage) => (context: MutationContext) =>
        changeMessage(context, mutation),
    /**
     * Save the activity the remote worker wants shown. The activity already desired is a replay. A new
     * one replaces a `SetActivity` still waiting to be sent, so only the latest is sent; one already being
     * sent is followed by a new operation. A delivery with a result takes no new activity.
     */
    SetDeliveryActivity:
        ({ activity }: SetDeliveryActivity) =>
        (context: MutationContext): MutationChange =>
            Located.$match(context.located, {
                Retained: () => Effect.fail(DeliveryClosed.make()),
                Active: ({ active }) => {
                    const { slot } = context;

                    if (sameDeliveryActivity(desiredActivity(active), activity)) {
                        return Effect.succeed({ slot, receipt: context.receipt('already_recorded') });
                    }

                    if (active.terminal !== undefined || active.stage === 'Finishing')
                        return Effect.fail(DeliveryClosed.make());
                    const last = lastActivityOperation(active);

                    const next =
                        last !== undefined && Predicate.isTagged(last.state, 'Pending')
                            ? replaceOperation(active, replacedRequest(last, SetActivity.make({ activity })))
                            : withOperations(active, [SetActivity.make({ activity })], context.now);

                    /** A delivery waiting for its remote worker has no callback running, so the output can start now. */
                    const readyAt = active.stage === 'ExternalWaiting' ? nextDueAt(next) : slot.readyAt;

                    return Effect.succeed({
                        slot: withActive(slot, next, readyAt),
                        receipt: context.receipt('accepted'),
                    });
                },
            }),
    /**
     * Save whether the bot's reaction should be on a target. The state already asked for is a replay, even
     * after a result. A change replaces a `SetMessageReaction` for the same reaction and target still
     * waiting to be sent; one already being sent is followed by a new operation. A delivery with a result
     * takes no new change.
     */
    SetDeliveryReaction:
        (mutation: SetDeliveryReaction) =>
        (context: MutationContext): MutationChange =>
            Located.$match(context.located, {
                Retained: () => Effect.fail(DeliveryClosed.make()),
                Active: ({ active }) =>
                    Effect.gen(function* () {
                        const { slot } = context;
                        const { target, reaction } = mutation;
                        const last = Option.getOrUndefined(Arr.last(reactionsOn(active.operations, mutation)));

                        if (last !== undefined && last.request.active === mutation.active) {
                            return { slot, receipt: context.receipt('already_recorded') };
                        }

                        if (active.terminal !== undefined || active.stage === 'Finishing')
                            return yield* DeliveryClosed.make();

                        /**
                         * Check that the target is one the destination can react on, and that it exists: the delivery
                         * has an activation target, or the message was created and not removed. A message whose create
                         * has not run yet is fine; the reaction runs after it. No provider reacts on its plan yet.
                         */
                        const kind = deliveryReactionTargetKind(target);

                        const unavailable: ReactionTargetCheck = Effect.fail(
                            DeliveryReactionTargetUnavailable.make({ target: kind }),
                        );

                        if (!Arr.contains(currentPreparedCallback(active)?.reactionTargets ?? [], kind))
                            return yield* DeliveryReactionTargetUnavailable.make({ target: kind });

                        yield* DeliveryReactionTarget.match(target, {
                            ActivationTarget: (): ReactionTargetCheck =>
                                currentPreparedCallback(active)?.activationTarget === undefined
                                    ? unavailable
                                    : Effect.void,
                            PlanTarget: (): ReactionTargetCheck => unavailable,
                            MessageTarget: ({ messageId }): ReactionTargetCheck => {
                                const creation = messageCreation(active, messageId);

                                if (creation === undefined || Predicate.isTagged(creation.state, 'Failed')) {
                                    return Effect.fail(DeliveryMessageNotFound.make({ messageId }));
                                }

                                const deleted = Arr.some(
                                    active.operations,
                                    ({ operation }) =>
                                        Predicate.isTagged(operation, 'DeleteMessage') &&
                                        operation.messageId === messageId,
                                );

                                return deleted ? Effect.fail(DeliveryMessageDeleted.make({ messageId })) : Effect.void;
                            },
                        });

                        const request = SetMessageReaction.make({ target, reaction, active: mutation.active });

                        const next =
                            last !== undefined && Predicate.isTagged(last.saved.state, 'Pending')
                                ? replaceOperation(active, replacedRequest(last.saved, request))
                                : withOperations(active, [request], context.now);

                        /** A delivery waiting for its remote worker has no callback running, so the output can start now. */
                        const readyAt = active.stage === 'ExternalWaiting' ? nextDueAt(next) : slot.readyAt;

                        return { slot: withActive(slot, next, readyAt), receipt: context.receipt('accepted') };
                    }),
            }),
    /**
     * Save the remote worker's whole plan as the desired plan, advancing its revision. The plan already
     * desired is a replay, even after the delivery ended. A new plan replaces a `RenderPlan` still waiting
     * to be sent, so only the latest is sent; one already being sent is followed by a new operation. A
     * destination that cannot show plans keeps the plan with no operation. A delivery with a result takes no
     * new plan.
     */
    PutDeliveryPlan:
        ({ plan }: PutDeliveryPlan) =>
        (context: MutationContext): MutationChange => {
            const { slot } = context;
            const replay = Effect.succeed({ slot, receipt: context.receipt('already_recorded') });

            return Located.$match(context.located, {
                Retained: ({ retained }) =>
                    retained.plan !== undefined && sameDeliveryPlan(retained.plan.plan, plan)
                        ? replay
                        : Effect.fail(DeliveryClosed.make()),
                Active: ({ active }) => {
                    if (active.plan !== undefined && sameDeliveryPlan(active.plan.desired.plan, plan)) return replay;

                    if (active.terminal !== undefined || active.stage === 'Finishing')
                        return Effect.fail(DeliveryClosed.make());
                    const revision = DeliveryPlanRevision.make((active.plan?.desired.revision ?? 0) + 1);
                    const desired = { revision, plan };

                    const planned = ActiveDelivery.make({
                        ...active,
                        plan: DeliveryPlanState.make(
                            active.plan?.rendered === undefined
                                ? { desired }
                                : { desired, rendered: active.plan.rendered },
                        ),
                    });

                    const accepted = (next: ActiveDelivery, readyAt: number | null) =>
                        Effect.succeed({
                            slot: withActive(slot, next, readyAt),
                            receipt: context.receipt('accepted'),
                        });

                    if (!Arr.contains(currentPreparedCallback(active)?.supportedOperations ?? [], 'RenderPlan'))
                        return accepted(planned, slot.readyAt);
                    const request = RenderPlan.make({ revision, plan });

                    /** The last saved `RenderPlan`, which holds the latest plan sent to the provider or waiting to be. */
                    const last = Option.getOrUndefined(
                        Arr.findLast(active.operations, ({ operation }) => Predicate.isTagged(operation, 'RenderPlan')),
                    );

                    const next =
                        last !== undefined && Predicate.isTagged(last.state, 'Pending')
                            ? replaceOperation(planned, replacedRequest(last, request))
                            : withOperations(planned, [request], context.now);

                    /** A delivery waiting for its remote worker has no callback running, so the output can start now. */
                    return accepted(next, active.stage === 'ExternalWaiting' ? nextDueAt(next) : slot.readyAt);
                },
            });
        },
};

/** Apply a remote worker's change: check its token, then change the delivery and save the output it needs. */
export const applyDeliverySlotMutation = Effect.fn('delivery.lifecycle.apply_mutation')(function* (
    slot: DeliverySlot,
    input: {
        readonly reference: DeliveryReference;
        readonly accessToken: string;
        readonly mutation: DeliveryMutation;
    } & MailboxFacts,
) {
    const located = locate(slot, input);

    if (located === null) return yield* DeliveryNotFound.make();

    /**
     * A destination that cannot show the change refuses it before anything is saved. A plan needs no
     * operation: a destination that cannot show it still keeps it.
     */
    const operation: DeliveryOperationKind | undefined = Match.value(input.mutation).pipe(
        Match.tagsExhaustive({
            CompleteDelivery: () => 'PresentOutcome' as const,
            FailDelivery: () => 'PresentOutcome' as const,
            AddDeliveryLink: () => 'AddExternalLink' as const,
            CreateDeliveryMessage: () => 'CreateMessage' as const,
            UpdateDeliveryMessage: () => 'UpdateMessage' as const,
            DeleteDeliveryMessage: () => 'DeleteMessage' as const,
            SetDeliveryActivity: () => 'SetActivity' as const,
            SetDeliveryReaction: () => 'SetMessageReaction' as const,
            PutDeliveryPlan: () => undefined,
        }),
    );

    const supported = Located.$match(located, {
        Active: ({ active }) => currentPreparedCallback(active)?.supportedOperations ?? [],
        Retained: ({ retained }) => retained.supportedOperations,
    });

    if (operation !== undefined && !Arr.contains(supported, operation)) {
        return yield* DeliveryOperationUnsupported.make({ operation });
    }

    const receipt = (status: DeliveryMutationReceipt['status']) =>
        DeliveryMutationReceipt.make({ deliveryId: input.reference.deliveryId, status });

    const changed = yield* Match.value(input.mutation).pipe(Match.tagsExhaustive(mutationChanges))({
        slot,
        located,
        now: input.now,
        hasWaiting: input.hasWaiting,
        receipt,
    });

    /**
     * Any request the store took from a remote worker, a repeat included, shows it is still working, so the
     * time limit of its delivery starts again. A delivery with a result has no time limit left to restart.
     */
    const active = changed.slot.active;

    if (
        active === null ||
        active.batchId !== input.reference.batchId ||
        active.callbackIndex !== input.reference.callbackIndex
    )
        return changed;
    const restarted = withDeadlineFrom(active, input.now);

    if (restarted === active) return changed;

    return {
        ...changed,
        slot: withActive(
            changed.slot,
            restarted,
            restarted.stage === 'ExternalWaiting' ? nextDueAt(restarted) : changed.slot.readyAt,
        ),
    };
});
