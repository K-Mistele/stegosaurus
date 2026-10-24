import { describe, it } from '@effect/vitest';
import { Effect } from 'effect';

import {
    LinearIssueLabelsChanged,
    LinearIssueStatusChange,
    LinearIssueTitleChanged,
} from '../src/LinearCallbackEvents';
import { normalizeLinearIssueChanges } from '../src/LinearIssueChanges';

describe('Linear issue changes', () => {
    it.effect('emits one typed change per changed field group with its previous values', ({ expect }) =>
        Effect.sync(() => {
            expect(
                normalizeLinearIssueChanges({
                    title: 'Old title',
                    stateId: 'old-state',
                    startedAt: null,
                    labelIds: ['old-label'],
                }),
            ).toEqual([
                LinearIssueTitleChanged.make({ previous: { title: 'Old title' } }),
                LinearIssueStatusChange.make({ previous: { stateId: 'old-state', startedAt: null } }),
                LinearIssueLabelsChanged.make({ previous: { labelIds: ['old-label'] } }),
            ]);
        }),
    );

    it.effect('emits no change when no modeled field changed', ({ expect }) =>
        Effect.sync(() => {
            expect(normalizeLinearIssueChanges({})).toEqual([]);
        }),
    );
});
