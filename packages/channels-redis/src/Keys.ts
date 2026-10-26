import { Option, String as Str } from 'effect';

const root = 'delivery:next:{mailboxes}';

/** Each UTF-16 code unit as four hex digits. */
const encode = (value: string) => {
    let encoded = '';

    for (let offset = 0; offset < value.length; offset++) {
        encoded += Option.match(Str.charCodeAt(value, offset), {
            onNone: () => '',
            onSome: (code) => Str.padStart(4, '0')(code.toString(16)),
        });
    }

    return encoded;
};

export const readyMailboxesKey = `${root}:ready`;

export const mailboxStateKey = (mailboxKey: string) => `${root}:state:${encode(mailboxKey)}`;

export const mailboxPendingKey = (mailboxKey: string) => `${root}:pending:${encode(mailboxKey)}`;

export const mailboxEventsKey = (mailboxKey: string) => `${root}:events:${encode(mailboxKey)}`;

/** A mailbox's finished deliveries, kept for status reads and repeated requests until the last one's retention ends. */
export const mailboxRetainedKey = (mailboxKey: string) => `${root}:retained:${encode(mailboxKey)}`;

export const mailboxSubscriptionsKey = `${root}:subscriptions`;
