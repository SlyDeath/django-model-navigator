/** Verify source-module dependency boundaries and keep pure modules independent of VS Code */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';

import { group, test } from './harness';

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

/** Allowed imports by module: internal module names and external package names */
export const ALLOWED: Record<string, string[]> = {
    types: [],
    parser: ['types'],
    builtins: ['parser', 'types'],
    registry: ['builtins', 'parser', 'types', 'path'],
    lookup: [],
    config: ['vscode'],
    logger: ['vscode'],
    extension: [
        'builtins',
        'config',
        'logger',
        'lookup',
        'parser',
        'registry',
        'types',
        'path',
        'fs/promises',
        'vscode'
    ]
};

/**
 * Collect static imports, re-exports, require() and dynamic import() with the TypeScript
 * scanner, so comments, strings and indentation cannot hide a dependency
 * Relative imports become module paths relative to src/; package names are kept
 */
export function moduleImports(source: string, from = ''): string[] {
    const found = new Set<string>();
    const info = ts.preProcessFile(source, true, true);

    for (const { fileName: target } of info.importedFiles) {
        found.add(target.startsWith('.')
            ? path.posix.join(path.posix.dirname(from), target).replace(/\.ts$/, '')
            : target);
    }

    return [...found].sort();
}

/** Report unknown source modules and imports outside the allowed dependency graph */
export function graphViolations(sources: Record<string, string>): string[] {
    const violations: string[] = [];

    for (const [name, source] of Object.entries(sources)) {
        const allowed = ALLOWED[name];

        if (!allowed) {
            violations.push(`${name}: модуля нет в графе`);
            continue;
        }

        for (const target of moduleImports(source, name)) {
            if (!allowed.includes(target)) violations.push(`${name} -> ${target}`);
        }
    }

    return violations;
}

/** Source modules by name; nested files keep their relative path */
export function readSources(dir = SRC, prefix = ''): Record<string, string> {
    const sources: Record<string, string> = {};

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            Object.assign(sources, readSources(file, `${prefix}${entry.name}/`));
        } else if (entry.name.endsWith('.ts')) {
            sources[`${prefix}${path.basename(entry.name, '.ts')}`] = fs.readFileSync(file, 'utf8');
        }
    }

    return sources;
}

group('architecture: граф модулей');

test('импорты src/ соответствуют графу', () => {
    assert.deepStrictEqual(graphViolations(readSources()), []);
});

test('каждый модуль графа существует', () => {
    const missing = Object.keys(ALLOWED).filter(name => !fs.existsSync(path.join(SRC, `${name}.ts`)));

    assert.deepStrictEqual(missing, []);
});

test('чистый модуль с импортом vscode считается нарушением', () => {
    const violations = graphViolations({
        parser: "import * as vscode from 'vscode';\nimport { ModelField } from './types';",
        extra: ''
    });

    assert.deepStrictEqual(violations, ['parser -> vscode', 'extra: модуля нет в графе']);
});

test('require и импорт с расширением тоже учитываются', () => {
    assert.deepStrictEqual(
        moduleImports(
            "const fs = require('fs');\nexport { x } from './registry.ts';\n" +
            "import {\n    a,\n    b\n} from './types';\nconst text = \"from 'django' import x\";"
        ),
        ['fs', 'registry', 'types']
    );
});

test('динамический импорт, отступ и комментарий с апострофом не скрывают зависимость', () => {
    assert.deepStrictEqual(
        moduleImports(
            "async function load() {\n    return import('vscode');\n}\n" +
            "  import * as os from 'os';\n" +
            "import {\n    // it's a helper\n    parse\n} from './parser';"
        ),
        ['os', 'parser', 'vscode']
    );
});

test('файлы во вложенных папках src/ входят в граф под своим путём', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmn-graph-'));

    try {
        fs.mkdirSync(path.join(dir, 'sub'));
        fs.writeFileSync(path.join(dir, 'parser.ts'), "import { x } from './sub/parser';");
        fs.writeFileSync(path.join(dir, 'sub', 'parser.ts'), "import * as vscode from 'vscode';");
        const sources = readSources(dir);

        assert.deepStrictEqual(Object.keys(sources).sort(), ['parser', 'sub/parser']);
        assert.deepStrictEqual(graphViolations(sources),
            ['parser -> sub/parser', 'sub/parser: модуля нет в графе']);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
