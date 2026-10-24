import { tactical } from '@stegosaurus/fold-tui-theme/tactical';
import { SyntaxStyle, TreeSitterClient, type MarkdownTableOptions, type NativeResourceOwner } from '@opentui/core';

export type MarkdownTone = 'normal' | 'muted';

class MarkdownTreeSitterClient extends TreeSitterClient {
    constructor() {
        super({ dataPath: '' }, { autoStartWorker: false });
    }

    override highlightOnce(_content: string, _filetype: string): Promise<{ highlights: [] }> {
        // Streaming Markdown already supplies StyledText; avoid starting a worker just to restyle those same blocks.
        return Promise.resolve({ highlights: [] });
    }
}

export const markdownTreeSitterClient = new MarkdownTreeSitterClient();

export const markdownStyleDefinitions = (tone: MarkdownTone) => {
    const muted = tone === 'muted';
    const text = muted ? tactical.color.textDim : tactical.color.text;
    const textDim = muted ? tactical.color.textFaint : tactical.color.textDim;
    const accent = muted ? tactical.color.gridDim : tactical.color.grid;
    const bright = muted ? tactical.color.coreDim : tactical.color.coreBright;

    return {
        keyword: { fg: bright, bold: true },
        string: { fg: accent },
        comment: { fg: textDim, italic: true },
        number: { fg: tactical.color.inject },
        function: { fg: tactical.color.core },
        type: { fg: accent },
        operator: { fg: bright },
        variable: { fg: text },
        property: { fg: accent },
        'punctuation.bracket': { fg: textDim },
        'punctuation.delimiter': { fg: textDim },
        'markup.heading': { fg: bright, bold: true },
        'markup.heading.1': { fg: bright, bold: true },
        'markup.heading.2': { fg: tactical.color.core, bold: true },
        'markup.heading.3': { fg: accent, bold: true },
        'markup.bold': { fg: text, bold: true },
        'markup.strong': { fg: text, bold: true },
        'markup.italic': { fg: text, italic: true },
        'markup.list': { fg: tactical.color.core },
        'markup.quote': { fg: textDim, italic: true },
        'markup.raw': { fg: accent, bg: tactical.color.raised },
        'markup.raw.block': { fg: accent, bg: tactical.color.raised },
        'markup.raw.inline': { fg: accent, bg: tactical.color.raised },
        'markup.link': { fg: accent, underline: true },
        'markup.link.label': { fg: accent, underline: true },
        'markup.link.url': { fg: tactical.color.gridDim, underline: true },
        'diff.plus': { fg: tactical.color.grid },
        'diff.minus': { fg: tactical.color.alert },
        label: { fg: tactical.color.core },
        conceal: { fg: tactical.color.textFaint },
        default: { fg: text, dim: muted },
    };
};

// A SyntaxStyle's native resources belong to one renderer scene, so the cache is per owner.
const syntaxStyleCache = new WeakMap<NativeResourceOwner, Map<MarkdownTone, SyntaxStyle>>();

export const markdownSyntaxStyle = (tone: MarkdownTone, owner: NativeResourceOwner): SyntaxStyle => {
    const ownerStyles = syntaxStyleCache.get(owner) ?? new Map<MarkdownTone, SyntaxStyle>();
    syntaxStyleCache.set(owner, ownerStyles);

    const cached = ownerStyles.get(tone);
    if (cached !== undefined) return cached;

    const syntaxStyle = SyntaxStyle.fromStyles(markdownStyleDefinitions(tone), owner);
    ownerStyles.set(tone, syntaxStyle);
    return syntaxStyle;
};

export const markdownTableOptions = {
    style: 'grid',
    widthMode: 'full',
    columnFitter: 'balanced',
    wrapMode: 'word',
    cellPaddingX: 1,
    borderStyle: tactical.chrome.panelStyle,
    borderColor: tactical.chrome.border,
} as const satisfies MarkdownTableOptions;
