/**
 * Shared SKILL.md parsing for every skill loader (disk, Codex, Grok): split the leading `---` YAML
 * block from the body, parse the YAML, and decode the fields Fold reads. Loader policy (name
 * validation, required description, namespaces, fallbacks) stays with each loader.
 */
import { Effect, Option, Schema, String as Str, pipe } from 'effect';
import { parse as parseYaml } from 'yaml';

/**
 * The SKILL.md frontmatter fields Fold reads. Keys may be absent; a bare `name:` decodes as `null`.
 * Other keys (`allowed-tools`, `metadata`, ...) are ignored.
 */
export const SkillFrontmatter = Schema.Struct({
    name: Schema.optionalKey(Schema.NullOr(Schema.String)),
    description: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

export type SkillFrontmatter = typeof SkillFrontmatter.Type;

/** A SKILL.md split into its raw YAML frontmatter (if any) and trimmed body, newlines normalized. */
export type SkillFileParts = {
    readonly frontmatter: Option.Option<string>;
    readonly body: string;
};

/** A SKILL.md with decoded frontmatter. */
export type SkillDocument = {
    readonly frontmatter: SkillFrontmatter;
    readonly body: string;
};

/** The SKILL.md has no leading `---` YAML block. */
export class SkillFrontmatterMissing extends Schema.TaggedError<
    SkillFrontmatterMissing,
    { readonly brand: unique symbol }
>()('SkillFrontmatterMissing', {
    message: Schema.String,
}) {}

/** The frontmatter block is not valid YAML. */
export class SkillFrontmatterInvalidYaml extends Schema.TaggedError<
    SkillFrontmatterInvalidYaml,
    { readonly brand: unique symbol }
>()('SkillFrontmatterInvalidYaml', {
    message: Schema.String,
    cause: Schema.Defect(),
}) {}

/** The frontmatter parsed but its fields have the wrong types (or it is not a mapping). */
export class SkillFrontmatterInvalidFields extends Schema.TaggedError<
    SkillFrontmatterInvalidFields,
    { readonly brand: unique symbol }
>()('SkillFrontmatterInvalidFields', {
    message: Schema.String,
    cause: Schema.instanceOf(Schema.SchemaError),
}) {}

export type SkillFrontmatterError =
    | SkillFrontmatterMissing
    | SkillFrontmatterInvalidYaml
    | SkillFrontmatterInvalidFields;

const decodeFields = Schema.decodeUnknownEffect(SkillFrontmatter);

/**
 * Split a SKILL.md into frontmatter and body. CRLF and CR normalize to LF first so a trailing `\r`
 * never leaks into a field. Frontmatter opens with a first line of exactly `---` and closes at the
 * next line starting with `---`; without both, the whole file is the body.
 */
export const splitSkillFile = (raw: string): SkillFileParts => {
    const content = pipe(raw, Str.replace(/\r\n/g, '\n'), Str.replace(/\r/g, '\n'));

    if (!Str.startsWith('---\n')(content)) return { frontmatter: Option.none(), body: Str.trim(content) };
    const end = Option.map(Str.indexOf('\n---')(Str.slice(3)(content)), (index) => index + 3);

    if (Option.isNone(end)) return { frontmatter: Option.none(), body: Str.trim(content) };

    return {
        frontmatter: Option.some(Str.slice(4, end.value)(content)),
        body: Str.trim(Str.slice(end.value + 4)(content)),
    };
};

/** Parse raw frontmatter YAML and decode it into {@link SkillFrontmatter}. */
export const decodeSkillFrontmatter = (
    yaml: string,
): Effect.Effect<SkillFrontmatter, SkillFrontmatterInvalidYaml | SkillFrontmatterInvalidFields> =>
    Effect.try({
        try: () => parseYaml(yaml),
        catch: (cause) => SkillFrontmatterInvalidYaml.make({ message: String(cause), cause }),
    }).pipe(
        Effect.flatMap(decodeFields),
        Effect.catchTag('SchemaError', (cause) =>
            Effect.fail(SkillFrontmatterInvalidFields.make({ message: cause.message, cause })),
        ),
    );

/** Parse a SKILL.md that must carry frontmatter; fails with reason `missing` when it has none. */
export const parseSkillFile = (raw: string): Effect.Effect<SkillDocument, SkillFrontmatterError> => {
    const { frontmatter, body } = splitSkillFile(raw);

    return Option.match(frontmatter, {
        onNone: () => Effect.fail(SkillFrontmatterMissing.make({ message: 'missing YAML frontmatter' })),
        onSome: (yaml) => Effect.map(decodeSkillFrontmatter(yaml), (fields) => ({ frontmatter: fields, body })),
    });
};

/** The frontmatter `name` when it is a non-empty string, else `fallback` (the skill directory name). */
export const skillNameOr = (frontmatter: SkillFrontmatter, fallback: string): string => {
    const name = frontmatter.name ?? '';

    return name.length > 0 ? name : fallback;
};
