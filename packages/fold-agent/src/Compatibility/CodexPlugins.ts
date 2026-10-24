import { Array as Arr, Crypto, Effect, FileSystem, Option, Path, Schema, String as Str } from 'effect';

export const CodexPluginDiagnostic = Schema.Struct({
    stage: Schema.Literals(['config', 'cache', 'manifest']),
    code: Schema.String,
    path: Schema.String,
});

export type CodexPluginDiagnostic = typeof CodexPluginDiagnostic.Type;

export type CodexPluginSkillRoot = {
    readonly name: string;
    readonly path: string;
    readonly identityToken: string;
    readonly versionToken: string;
};

export type CodexPluginOptions = {
    readonly codexHome: string;
};

type EnabledPlugin = { readonly name: string; readonly marketplace: string };

const token = (kind: string, value: string) =>
    Effect.gen(function* () {
        const crypto = yield* Crypto.Crypto;
        const digest = yield* crypto.digest('SHA-256', new TextEncoder().encode(value));

        const hex = Arr.join(
            Arr.map(Arr.fromIterable(digest), (byte) => Str.padStart(2, '0')(byte.toString(16))),
            '',
        );

        return `${kind}-${Str.slice(0, 16)(hex)}`;
    });

const parseEnabledPlugins = (contents: string): ReadonlyArray<EnabledPlugin> => {
    if (/^\s*plugins\s*=\s*false\s*$/m.test(contents)) return [];
    const plugins: Array<EnabledPlugin> = [];
    const lines = Str.split(contents, /\r?\n/);

    for (let index = 0; index < lines.length; index += 1) {
        const match = /^\s*\[plugins\."([^"\\/]+)@([^"\\/]+)"\]\s*$/.exec(lines[index] ?? '');

        if (match === null) continue;
        const body: Array<string> = [];

        for (let bodyIndex = index + 1; bodyIndex < lines.length; bodyIndex += 1) {
            const line = lines[bodyIndex] ?? '';

            if (/^\s*\[/.test(line)) break;
            body.push(line);
        }

        if (Arr.some(body, (line) => /^\s*enabled\s*=\s*false\s*$/.test(line))) continue;
        const name = match[1];
        const marketplace = match[2];

        if (name !== undefined && marketplace !== undefined) plugins.push({ name, marketplace });
    }

    return plugins;
};

type SemanticVersion = {
    readonly major: string;
    readonly minor: string;
    readonly patch: string;
    readonly prerelease: Array<string>;
};

const CodexPluginManifest = Schema.Struct({
    name: Schema.optional(Schema.String),
    skills: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
});

type CodexPluginManifest = typeof CodexPluginManifest.Type;

const decodeCodexPluginManifest = Schema.decodeOption(Schema.fromJsonString(CodexPluginManifest));

const parseSemanticVersion = (value: string): SemanticVersion | null => {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);

    if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined) return null;

    return {
        major: match[1],
        minor: match[2],
        patch: match[3],
        prerelease: match[4] === undefined ? [] : Str.split(match[4], '.'),
    };
};

const compareNumeric = (left: string, right: string): number =>
    left.length === right.length ? Str.localeCompare(right)(left) : left.length - right.length;

const compareVersions = (left: string, right: string): number => {
    const leftVersion = parseSemanticVersion(left);
    const rightVersion = parseSemanticVersion(right);

    if (leftVersion === null || rightVersion === null) return Str.localeCompare(right)(left);

    for (const field of ['major', 'minor', 'patch'] as const) {
        const compared = compareNumeric(leftVersion[field], rightVersion[field]);

        if (compared !== 0) return compared;
    }

    if (Arr.isArrayEmpty(leftVersion.prerelease) || Arr.isArrayEmpty(rightVersion.prerelease)) {
        return leftVersion.prerelease.length === rightVersion.prerelease.length
            ? 0
            : Arr.isArrayEmpty(leftVersion.prerelease)
              ? 1
              : -1;
    }

    return Str.localeCompare(Arr.join(rightVersion.prerelease, '.'))(Arr.join(leftVersion.prerelease, '.'));
};

const selectedVersion = (versions: ReadonlyArray<string>): string | null => {
    if (versions.includes('local')) return 'local';

    return Arr.reduce<string, string | null>(versions, null, (selected, version) =>
        selected === null || compareVersions(selected, version) < 0 ? version : selected,
    );
};

const safeRelativeSkillRoot = (value: string): string | null => {
    if (!Str.startsWith('./')(value) || value === './' || Str.includes('\\')(value) || Str.includes('\0')(value))
        return null;

    if (Str.split(value, '/').includes('..')) return null;

    return value;
};

export const discoverCodexPluginSkillRoots = (options: CodexPluginOptions) =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const diagnostics: Array<CodexPluginDiagnostic> = [];
        const configPath = path.join(options.codexHome, 'config.toml');
        const config = yield* fs.readFileString(configPath).pipe(Effect.orElseSucceed(() => ''));
        const roots: Array<CodexPluginSkillRoot> = [];

        for (const plugin of parseEnabledPlugins(config)) {
            const identity = `${plugin.name}@${plugin.marketplace}`;
            const cachePath = path.join(options.codexHome, 'plugins', 'cache', plugin.marketplace, plugin.name);
            const entries = yield* fs.readDirectory(cachePath).pipe(Effect.orElseSucceed(() => []));
            const directories: Array<string> = [];

            for (const entry of entries) {
                const info = yield* fs.stat(path.join(cachePath, entry)).pipe(Effect.orElseSucceed(() => null));

                if (info?.type === 'Directory') directories.push(entry);
            }

            const version = selectedVersion(directories);

            if (version === null) continue;
            const bundle = path.resolve(cachePath, version);
            let manifest: CodexPluginManifest | null = null;
            let manifestPath = '';

            for (const relativePath of ['plugin.json', '.codex-plugin/plugin.json', '.claude-plugin/plugin.json']) {
                const candidate = path.join(bundle, relativePath);
                const contents = yield* fs.readFileString(candidate).pipe(Effect.orElseSucceed(() => null));

                if (contents === null) continue;
                manifestPath = candidate;
                manifest = Option.getOrNull(decodeCodexPluginManifest(contents));

                if (manifest === null)
                    diagnostics.push({ stage: 'manifest', code: 'manifest_parse_failed', path: candidate });
                break;
            }

            if (manifest === null) continue;

            if (manifest.name !== plugin.name) {
                diagnostics.push({ stage: 'manifest', code: 'manifest_name_mismatch', path: manifestPath });
                continue;
            }

            const declared = Arr.ensure(manifest.skills ?? './skills');

            for (const value of declared) {
                const relativeRoot = safeRelativeSkillRoot(value);

                if (relativeRoot === null) {
                    diagnostics.push({ stage: 'manifest', code: 'invalid_skill_root', path: manifestPath });
                    continue;
                }

                roots.push({
                    name: plugin.name,
                    path: path.resolve(bundle, relativeRoot),
                    identityToken: yield* token('plugin', identity),
                    versionToken: yield* token('version', version),
                });
            }
        }

        return { roots, diagnostics };
    });
