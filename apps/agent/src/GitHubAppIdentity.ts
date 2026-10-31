import { GitHubId } from '@stegosaurus/channels-github';

/**
 * The Stegosaurus.tech GitHub App's bot (App ID 5447932). Not secret, and the same in every stage, so it
 * lives here rather than in Infisical. People mention the bot as `@stegosaurus-tech`; its user is
 * `stegosaurus-tech[bot]`.
 */
export const GitHubAppIdentity = {
    mentionName: 'stegosaurus-tech',
    botUserId: GitHubId.make(347123140),
} as const;
