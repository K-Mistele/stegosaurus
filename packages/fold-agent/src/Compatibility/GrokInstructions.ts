import { homedir } from 'node:os';

import { Array as Arr, Effect, FileSystem, Option, Path, pipe, Schema, String as Str } from 'effect';

export const GrokInstructionSource = Schema.Struct({
    path: Schema.String,
    content: Schema.String,
    scope: Schema.Literals(['global', 'ancestor']),
});

export type GrokInstructionSource = typeof GrokInstructionSource.Type;

export type GrokInstructionOptions = {
    readonly cwd: string;
    readonly home?: string;
    readonly grokHome?: string;
    readonly projectRoot?: string;
};

const instructionNames = [
    'Agents.md',
    'Claude.md',
    'CLAUDE.md',
    'CLAUDE.local.md',
    'AGENT.md',
    'AGENTS.md',
    '.claude/CLAUDE.md',
    '.claude/CLAUDE.local.md',
] as const;

const projectRuleDirectories = ['.grok/rules', '.claude/rules', '.cursor/rules'] as const;

const isAncestor = (ancestor: string, candidate: string): Effect.Effect<boolean, never, Path.Path> =>
    Effect.gen(function* () {
        const path = yield* Path.Path;
        let current = candidate;

        while (true) {
            if (current === ancestor) return true;
            const parent = path.dirname(current);

            if (parent === current) return false;
            current = parent;
        }
    });

const directoriesToBoundary = (
    cwd: string,
    boundary: string | null,
): Effect.Effect<ReadonlyArray<string>, never, Path.Path> =>
    Effect.gen(function* () {
        const path = yield* Path.Path;
        const directories: Array<string> = [];
        let current = cwd;

        while (true) {
            directories.push(current);

            if (current === boundary) break;
            const parent = path.dirname(current);

            if (parent === current) break;
            current = parent;
        }

        return directories.reverse();
    });

const stripRuleFrontmatter = (content: string): string => {
    const normalized = pipe(content, Str.replace(/\r\n/g, '\n'), Str.replace(/\r/g, '\n'));

    if (!Str.startsWith('---\n')(normalized)) return normalized;

    return pipe(
        normalized,
        Str.slice(4),
        Str.indexOf('\n---'),
        Option.match({
            onNone: () => normalized,
            onSome: (end) => Str.trimStart(Str.slice(end + 8)(normalized)),
        }),
    );
};

const globPattern = (pattern: string): RegExp => {
    const escaped = Arr.join(
        Arr.map(Str.split(pattern, ''), (character) => {
            if (character === '*') return '.*';

            if (character === '?') return '.';

            return /[\\^$+.()|{}[\]]/.test(character) ? `\\${character}` : character;
        }),
        '',
    );

    return new RegExp(`(^|/)${escaped}${Str.endsWith('/')(pattern) ? '' : '($|/)'}`);
};

const makeGitIgnorePredicate = (contents: string): ((path: string) => boolean) => {
    const rules = pipe(
        Str.split(contents, /\r?\n/),
        Arr.map((line) => Str.trim(line)),
        Arr.filter((line) => line.length > 0 && !Str.startsWith('#')(line)),
        Arr.map((line) => ({
            negated: Str.startsWith('!')(line),
            pattern: globPattern(pipe(line, Str.replace(/^!\/?/, ''), Str.replace(/^\//, ''))),
        })),
    );

    return (path) => {
        let ignored = false;

        for (const rule of rules) if (rule.pattern.test(path)) ignored = !rule.negated;

        return ignored;
    };
};

const readNonEmpty = (
    path: string,
    scope: 'global' | 'ancestor',
    isRule: boolean,
): Effect.Effect<GrokInstructionSource | null, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;

        return yield* fs.readFileString(path).pipe(
            Effect.map((raw) => {
                const content = isRule ? stripRuleFrontmatter(raw) : raw;

                return Str.trim(content).length === 0 ? null : { path, content, scope };
            }),
            Effect.orElseSucceed(() => null),
        );
    });

const markdownRules = (
    directory: string,
): Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        return yield* fs.readDirectory(directory).pipe(
            Effect.map((entries) =>
                pipe(
                    entries,
                    Arr.filter((entry) => Str.endsWith('.md')(Str.toLowerCase(entry))),
                    Arr.sort(Str.Order),
                    Arr.map((entry) => path.join(directory, entry)),
                ),
            ),
            Effect.orElseSucceed(() => []),
        );
    });

const resolveInstructionRoots = (
    options: GrokInstructionOptions,
): Effect.Effect<
    {
        readonly home: string | null;
        readonly grokHome: string;
        readonly directories: ReadonlyArray<string>;
        readonly ignoreRoot: string | undefined;
    },
    never,
    Path.Path
> =>
    Effect.gen(function* () {
        const path = yield* Path.Path;
        const cwd = path.resolve(options.cwd);
        const homeValue = options.home === undefined ? homedir() : options.home;
        const home = homeValue.length === 0 ? null : path.resolve(homeValue);
        const grokHome = path.resolve(options.grokHome ?? path.join(home ?? homedir(), '.grok'));
        const explicitRoot = options.projectRoot === undefined ? null : path.resolve(options.projectRoot);
        const explicitRootIsAncestor = explicitRoot !== null && (yield* isAncestor(explicitRoot, cwd));
        const homeIsAncestor = home !== null && (yield* isAncestor(home, cwd));
        const boundary = explicitRootIsAncestor ? explicitRoot : homeIsAncestor ? home : null;
        const directories = yield* directoriesToBoundary(cwd, boundary);
        const ignoreRoot = explicitRootIsAncestor ? explicitRoot : directories[0];

        return { home, grokHome, directories, ignoreRoot };
    });

export const loadGrokInstructions = Effect.fn('fold.grok_compatibility.load_instructions')(function* (
    options: GrokInstructionOptions,
) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { home, grokHome, directories, ignoreRoot } = yield* resolveInstructionRoots(options);

    const gitignore =
        ignoreRoot === undefined
            ? ''
            : yield* fs.readFileString(path.join(ignoreRoot, '.gitignore')).pipe(Effect.orElseSucceed(() => ''));

    const isIgnored = makeGitIgnorePredicate(gitignore);
    const sources: Array<GrokInstructionSource> = [];
    const seen = new Set<string>();

    const add = (source: GrokInstructionSource | null, projectRoot: string | undefined) => {
        if (source === null || seen.has(source.path)) return;

        if (projectRoot !== undefined) {
            const projectPath = Arr.join(Str.split(path.relative(projectRoot, source.path), path.sep), '/');

            if (isIgnored(projectPath)) return;
        }

        seen.add(source.path);
        sources.push(source);
    };

    for (const name of instructionNames)
        add(yield* readNonEmpty(path.join(grokHome, name), 'global', false), undefined);

    for (const rulePath of yield* markdownRules(path.join(grokHome, 'rules')))
        add(yield* readNonEmpty(rulePath, 'global', true), undefined);

    if (home !== null) {
        for (const vendor of ['.claude', '.cursor']) {
            for (const name of instructionNames)
                add(yield* readNonEmpty(path.join(home, vendor, name), 'global', false), undefined);

            for (const rulePath of yield* markdownRules(path.join(home, vendor, 'rules')))
                add(yield* readNonEmpty(rulePath, 'global', true), undefined);
        }
    }

    for (const directory of directories) {
        for (const name of instructionNames)
            add(yield* readNonEmpty(path.join(directory, name), 'ancestor', false), ignoreRoot);

        for (const rulesDirectory of projectRuleDirectories)
            for (const rulePath of yield* markdownRules(path.join(directory, rulesDirectory)))
                add(yield* readNonEmpty(rulePath, 'ancestor', true), ignoreRoot);
    }

    return sources;
});

const escapeXmlAttribute = (text: string): string =>
    pipe(
        text,
        Str.replace(/&/g, '&amp;'),
        Str.replace(/</g, '&lt;'),
        Str.replace(/>/g, '&gt;'),
        Str.replace(/"/g, '&quot;'),
        Str.replace(/'/g, '&apos;'),
    );

export const renderGrokInstructions = (sources: ReadonlyArray<GrokInstructionSource>): string | null => {
    if (Arr.isReadonlyArrayEmpty(sources)) return null;

    return `<project_context>\n${Arr.join(
        Arr.map(
            sources,
            (source) =>
                `<project_instructions path="${escapeXmlAttribute(source.path)}">\n${Str.trim(source.content)}\n</project_instructions>`,
        ),
        '\n',
    )}\n</project_context>`;
};
