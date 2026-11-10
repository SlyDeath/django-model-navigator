/** Read VS Code settings and build workspace search patterns */

import * as vscode from 'vscode';

export const CONFIG_SECTION = 'djangoModelNavigator';

export const DEFAULT_EXCLUDE_PATTERNS = [
    '**/__pycache__/**',
    '**/migrations/**',
    '**/node_modules/**',
    '**/.git/**',
    '**/.venv/**',
    '**/venv/**',
    '**/site-packages/**'
];

/** Always search for models.py, regardless of additionalModelPaths */
export const DEFAULT_MODEL_PATTERN = '**/models.py';

export interface NavigatorConfig {
    debug: boolean;

    /** Additional workspace globs, including split model packages */
    additionalModelPaths: string[];

    excludePatterns: string[];

    /** Extra field constructors that do not end in Field */
    additionalFieldTypes: string[];

    /** Override for settings.AUTH_USER_MODEL; an empty value enables inference */
    userModel: string;

    includeBuiltinModels: boolean;

    hoverMaxFields: number;

    maxDefinitionResults: number;

    enableHover: boolean;
    enableDefinition: boolean;
    enableCompletion: boolean;
    enableReferences: boolean;
    enableCodeLens: boolean;
}

/** Return defaults used before the first configuration read */
export function defaultConfig(): NavigatorConfig {
    return {
        debug: false,
        additionalModelPaths: [],
        excludePatterns: [...DEFAULT_EXCLUDE_PATTERNS],
        additionalFieldTypes: [],
        userModel: '',
        includeBuiltinModels: true,
        hoverMaxFields: 40,
        maxDefinitionResults: 20,
        enableHover: true,
        enableDefinition: true,
        enableCompletion: true,
        enableReferences: true,
        enableCodeLens: true
    };
}

/** Read the current workspace configuration without changing it */
export function readConfig(): NavigatorConfig {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);

    return {
        debug: config.get('debug', false),
        additionalModelPaths: config.get('additionalModelPaths', []),
        excludePatterns: config.get('excludePatterns', DEFAULT_EXCLUDE_PATTERNS),
        additionalFieldTypes: config.get('additionalFieldTypes', []),
        userModel: config.get('userModel', ''),
        includeBuiltinModels: config.get('includeBuiltinModels', true),
        hoverMaxFields: config.get('hoverMaxFields', 40),
        maxDefinitionResults: config.get('maxDefinitionResults', 20),
        enableHover: config.get('enableHover', true),
        enableDefinition: config.get('enableDefinition', true),
        enableCompletion: config.get('enableCompletion', true),
        enableReferences: config.get('enableReferences', true),
        enableCodeLens: config.get('enableCodeLens', true)
    };
}

/** Settings that change the model index and require a workspace rescan */
export const RESCAN_KEYS = [
    'additionalModelPaths',
    'excludePatterns',
    'additionalFieldTypes',
    'userModel',
    'includeBuiltinModels'
].map(key => `${CONFIG_SECTION}.${key}`);

/** Return deduplicated search globs, always including models.py */
export function buildSearchPatterns(config: NavigatorConfig): string[] {
    const patterns = new Set<string>([DEFAULT_MODEL_PATTERN]);

    for (const pattern of config.additionalModelPaths) {
        const trimmed = pattern.trim();

        if (trimmed) patterns.add(trimmed);
    }

    return [...patterns];
}

/** Combine exclusion globs for workspace.findFiles; return null when none are configured */
export function buildExcludeGlob(config: NavigatorConfig): string | null {
    const patterns = config.excludePatterns.map(p => p.trim()).filter(Boolean);

    if (patterns.length === 0) return null;
    if (patterns.length === 1) return patterns[0];

    return `{${patterns.join(',')}}`;
}
