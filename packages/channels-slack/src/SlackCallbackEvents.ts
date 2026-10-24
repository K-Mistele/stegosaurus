import { Schema } from 'effect';

import { SlackMessage } from './SlackMessage';
import { SlackMessageRef, SlackParticipant, SlackReaction } from './SlackModels';
import { SlackThread } from './SlackThread';

export const SlackEventId = Schema.NonEmptyString.pipe(Schema.brand('SlackEventId'));

export type SlackEventId = typeof SlackEventId.Type;

export class SlackMessageReceived extends Schema.TaggedClass<SlackMessageReceived, { readonly brand: unique symbol }>()(
    'SlackMessageReceived',
    {
        eventId: SlackEventId,
        message: SlackMessage,
    },
) {}

export class SlackMessageUpdated extends Schema.TaggedClass<SlackMessageUpdated, { readonly brand: unique symbol }>()(
    'SlackMessageUpdated',
    {
        eventId: SlackEventId,
        message: SlackMessage,
        previousMessage: Schema.optionalKey(SlackMessage),
    },
) {}

export class SlackMessageDeleted extends Schema.TaggedClass<SlackMessageDeleted, { readonly brand: unique symbol }>()(
    'SlackMessageDeleted',
    {
        eventId: SlackEventId,
        messageRef: SlackMessageRef,
        previousMessage: Schema.optionalKey(SlackMessage),
        actor: Schema.optionalKey(SlackParticipant),
    },
) {}

export class SlackReactionAdded extends Schema.TaggedClass<SlackReactionAdded, { readonly brand: unique symbol }>()(
    'SlackReactionAdded',
    {
        eventId: SlackEventId,
        message: SlackMessage,
        actor: SlackParticipant,
        reaction: SlackReaction,
    },
) {}

export class SlackReactionRemoved extends Schema.TaggedClass<SlackReactionRemoved, { readonly brand: unique symbol }>()(
    'SlackReactionRemoved',
    {
        eventId: SlackEventId,
        message: SlackMessage,
        actor: SlackParticipant,
        reaction: SlackReaction,
    },
) {}

export class SlackConversationStopped extends Schema.TaggedClass<
    SlackConversationStopped,
    { readonly brand: unique symbol }
>()('SlackConversationStopped', {
    eventId: SlackEventId,
    actor: SlackParticipant,
    streamingMessages: Schema.Array(SlackMessageRef),
}) {}

export const SlackThreadEvent = Schema.Union([
    SlackMessageReceived,
    SlackMessageUpdated,
    SlackMessageDeleted,
    SlackReactionAdded,
    SlackReactionRemoved,
    SlackConversationStopped,
]);

export type SlackThreadEvent = typeof SlackThreadEvent.Type;

export const SlackThreadEvents = Schema.Array(SlackThreadEvent);

export type SlackThreadEvents = typeof SlackThreadEvents.Type;

export const SlackNonEmptyThreadEvents = Schema.NonEmptyArray(SlackThreadEvent);

export type SlackNonEmptyThreadEvents = typeof SlackNonEmptyThreadEvents.Type;

export class SlackNewMention extends Schema.TaggedClass<SlackNewMention, { readonly brand: unique symbol }>()(
    'SlackNewMention',
    {
        thread: SlackThread,
        trigger: SlackMessage,
        events: SlackThreadEvents,
    },
) {}

export class SlackSubscribedThreadEvents extends Schema.TaggedClass<
    SlackSubscribedThreadEvents,
    { readonly brand: unique symbol }
>()('SlackSubscribedThreadEvents', {
    thread: SlackThread,
    events: SlackNonEmptyThreadEvents,
}) {}
