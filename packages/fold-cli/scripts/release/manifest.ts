import { join } from 'node:path';

import { Schema } from 'effect';

export const root = join(import.meta.dirname, '../../../..');
export const stage = join(root, '.release');
export const libraries = [
    'effect-branded-id',
    'effect-ai-openai',
    'effect-ai-anthropic',
    'effect-ai-openai-compat',
    'fold-core',
    'fold-codex',
    'fold-opencode',
    'fold-xai',
    'fold-agent',
    'fold-tui-theme',
    'fold-cli',
] as const;

export const targets = [
    ['linux', 'arm64', ''],
    ['linux', 'x64', ''],
    ['linux', 'x64', 'baseline'],
    ['linux', 'arm64', 'musl'],
    ['linux', 'x64', 'musl'],
    ['linux', 'x64', 'baseline-musl'],
    ['darwin', 'arm64', ''],
    ['darwin', 'x64', ''],
    ['darwin', 'x64', 'baseline'],
    ['windows', 'arm64', ''],
    ['windows', 'x64', ''],
    ['windows', 'x64', 'baseline'],
] as const;

export const targetName = ([os, cpu, variant]: (typeof targets)[number]) =>
    `@stegosaurus/fold-${os}-${cpu}${variant ? `-${variant}` : ''}`;

export const StringRecord = Schema.Record(Schema.String, Schema.String);

const WorkspaceConfig = Schema.Struct({ catalog: StringRecord });

/** The pnpm version catalog from `pnpm-workspace.yaml`. */
export const readCatalog = async (): Promise<Record<string, string>> =>
    Schema.decodeUnknownSync(WorkspaceConfig)(Bun.YAML.parse(await Bun.file(join(root, 'pnpm-workspace.yaml')).text()))
        .catalog;

/** Read a JSON file and decode it with `schema`. */
export const readJson = async <T, E>(path: string, schema: Schema.Codec<T, E>): Promise<T> =>
    Schema.decodeSync(Schema.fromJsonString(schema))(await Bun.file(path).text());

/** Encode `value` with `schema` as JSON text. */
export const encodeJson = <T, E>(schema: Schema.Codec<T, E>, value: T, space?: number): string =>
    Schema.encodeSync(Schema.fromJsonString(schema, { space }))(value);

/** Encode `value` with `schema` as a pretty-printed JSON document with a trailing newline. */
export const jsonDocument = <T, E>(schema: Schema.Codec<T, E>, value: T): string => `${encodeJson(schema, value, 2)}\n`;
