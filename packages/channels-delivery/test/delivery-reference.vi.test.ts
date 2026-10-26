import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import { describe, it, layer } from '@effect/vitest';
import { Effect, Option, String as Str } from 'effect';

import { deliveryMailboxKey } from '../src/MailboxDelivery';
import {
    BatchId,
    ENCODED_MAILBOX_KEY_MAX_LENGTH,
    deliveryAccessTokenMatches,
    isRoutableMailboxKey,
    randomBatchId,
    mailboxConversationId,
    randomDeliveryAccessToken,
    formatDeliveryId,
    parseDeliveryId,
} from '../src/DeliveryReference';

const mailboxKey = deliveryMailboxKey({
    namespace: 'app',
    provider: 'linear',
    installationId: 'org-1',
    resourceId: 'linear:v1:agent-session:6f7c|x',
});

const batchId = BatchId.make('batch_1-a');

describe('delivery reference', () => {
    it('round-trips a delivery ID to its mailbox key and batch ID', ({ expect }) => {
        const deliveryId = formatDeliveryId({ mailboxKey, batchId });
        expect(Str.startsWith('delivery:v2:')(deliveryId)).toBe(true);
        expect(parseDeliveryId(deliveryId)).toEqual(Option.some({ deliveryId, mailboxKey, batchId, callbackIndex: 0 }));
    });

    it('refuses anything that is not a canonical v2 delivery ID', ({ expect }) => {
        const deliveryId = formatDeliveryId({ mailboxKey, batchId });

        for (const candidate of [
            '',
            'delivery:v2:abc',
            'delivery:v1::batch',
            `${deliveryId}:extra`,
            Str.replace('delivery:v2:', 'delivery:v2:%%')(deliveryId),
            `delivery:v1:${Str.repeat(2_100)('A')}:batch`,
            /** Base64url with padding bits set decodes, but does not re-encode to the same text. */
            'delivery:v1:YR:batch',
            'delivery:v2:YR:batch:0',
            Str.replace(/:0$/, ':01')(deliveryId),
            Str.replace(/:0$/, ':-1')(deliveryId),
            Str.replace(/:0$/, ':1.5')(deliveryId),
            Str.replace(/:0$/, ':9007199254740992')(deliveryId),
            Str.replace(/:0$/, '')(Str.replace('delivery:v2:', 'delivery:v1:')(deliveryId)),
        ]) {
            expect(parseDeliveryId(candidate)).toEqual(Option.none());
        }
    });

    it('distinguishes callback steps within one batch', ({ expect }) => {
        const deliveryId = formatDeliveryId({ mailboxKey, batchId, callbackIndex: 2 });
        expect(parseDeliveryId(deliveryId)).toEqual(Option.some({ deliveryId, mailboxKey, batchId, callbackIndex: 2 }));
        expect(deliveryId).not.toBe(formatDeliveryId({ mailboxKey, batchId }));
    });

    it('gives every delivery in a mailbox the same conversation ID', ({ expect }) => {
        expect(mailboxConversationId(mailboxKey)).toBe(mailboxConversationId(mailboxKey));
        expect(mailboxConversationId(mailboxKey) === mailboxConversationId(`${mailboxKey}-other`)).toBe(false);
    });

    it('only routes mailbox keys whose delivery IDs fit in a request path', ({ expect }) => {
        expect(isRoutableMailboxKey(mailboxKey)).toBe(true);
        expect(isRoutableMailboxKey(Str.repeat(ENCODED_MAILBOX_KEY_MAX_LENGTH)('k'))).toBe(false);
    });

    it('compares tokens exactly', ({ expect }) => {
        expect(deliveryAccessTokenMatches({ saved: 'abc', presented: 'abc' })).toBe(true);
        expect(deliveryAccessTokenMatches({ saved: 'abc', presented: 'abd' })).toBe(false);
        expect(deliveryAccessTokenMatches({ saved: 'abc', presented: 'ab' })).toBe(false);
    });

    layer(NodeCrypto.layer)((it) => {
        it.effect('makes url-safe batch IDs and tokens that differ every time', ({ expect }) =>
            Effect.gen(function* () {
                const [firstBatch, secondBatch] = [yield* randomBatchId, yield* randomBatchId];

                const [firstToken, secondToken] = [yield* randomDeliveryAccessToken, yield* randomDeliveryAccessToken];

                expect(firstBatch === secondBatch).toBe(false);
                expect(firstToken === secondToken).toBe(false);
                expect(firstToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
            }),
        );
    });
});
