import { presets } from '@effect/tsgo/oxlint-presets';
import * as Arr from 'effect/Array';
import * as Record from 'effect/Record';
import * as Struct from 'effect/Struct';

export const effectTsgoPresets = Record.values(presets);

const effectTsgoRuleNames = Arr.flatMap(effectTsgoPresets, (preset) => Struct.keys(preset.rules ?? {}));

export const effectTsgoRules = {
    ...Record.fromEntries(Arr.map(effectTsgoRuleNames, (rule) => [rule, 'error'] as const)),
    'effecttsgo/missing-pipeable-signature': 'off',
    'effecttsgo/unstable-api-usage': 'off',
    'effecttsgo/api-stability-leak': 'off',
} as const;
