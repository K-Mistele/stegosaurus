/**
 * Cloudflare names for the agent's two Workers in each stage. Prod uses the `stegosaurus-` names and the
 * custom domain; every other stage puts its name in the Worker name, because workers.dev allows only one
 * label before the account subdomain.
 */

import { pipe, String as Str } from 'effect';

/** A stage as a DNS label: lowercased, with `_` replaced by `-`. */
const slug = (stage: string) => pipe(stage, Str.toLowerCase, Str.replaceAll('_', '-'));

/** The Ingress Worker, which takes GitHub's webhooks and hosts the delivery and session Durable Objects. */
export const ingressName = (stage: string) => (stage === 'prod' ? 'stegosaurus-agent' : `agent-${slug(stage)}`);

/** The Computer Worker, which hosts each session's workspace and container. Both Workers use this name. */
export const computerName = (stage: string) =>
    stage === 'prod' ? 'stegosaurus-agent-computer' : `agent-computer-${slug(stage)}`;

/** The Ingress Worker's custom domain in prod. */
export const PROD_DOMAIN = { name: 'agent.stegosaurus.tech', zoneName: 'stegosaurus.tech' } as const;
