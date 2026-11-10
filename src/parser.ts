/**
 * Parse Python declarations, imports and bindings without depending on VS Code
 * The parser reads source text only; it never executes Python
 */

import {
    AUTH_USER_MODEL_REF,
    ModelField,
    RELATION_FIELD_TYPES,
    SELF_MODEL_REF
} from './types';

/** A top-level class declaration with its directly declared fields */
export interface ParsedClass {
    name: string;

    /** Base expressions as written, before resolving imports or inheritance */
    bases: string[];

    filePath: string;

    /** Zero-based declaration line */
    line: number;

    /** Zero-based column of the class name */
    column: number;

    isAbstract: boolean;

    isProxy: boolean;

    /** Fields declared directly on this class, before inheritance or reverse relations */
    fields: ModelField[];

    /** App label override for classes whose path does not identify an app */
    appName?: string;

    /** Whether the class comes from the extension's built-in descriptions */
    isBuiltin?: boolean;
}

/** A top-level from-import binding */
export interface ParsedImport {
    /** Local name, including any import alias */
    local: string;

    /** Name exported by the source module */
    original: string;

    /** Module path without leading relative-import dots */
    module: string;

    /** Number of leading dots in a relative import */
    level: number;
}

/** Classes and import bindings parsed from one Python module */
export interface ParsedModule {
    classes: ParsedClass[];
    imports: ParsedImport[];
}

export interface ParserOptions {
    /** Additional field constructors such as TaggableManager that do not end in Field */
    additionalFieldTypes?: string[];
}

const TAB_WIDTH = 4;

/** Read one quoted string while retaining its source spelling and escapes */
function readSingleLineString(line: string, start: number): { text: string; next: number } {
    const quote = line[start];

    let text = quote;
    let i = start + 1;

    while (i < line.length) {
        const ch = line[i];

        // Keep escaped characters together so an escaped quote cannot close the string
        if (ch === '\\' && i + 1 < line.length) {
            text += ch + line[i + 1];
            i += 2;
            continue;
        }

        text += ch;
        i++;

        if (ch === quote) break;
    }

    return { text, next: i };
}

/**
 * Mask comments and triple-quoted literals without changing source coordinates
 * Single-line strings remain available for metadata unless maskStrings is requested
 * Whitespace-only literal lines cannot create false Python block boundaries
 */
export function sanitizeSource(content: string, maskStrings = false): string[] {
    const lines = content.split('\n');
    const result: string[] = [];

    /** Delimiter of the open triple-quoted literal */
    let tripleQuote: string | null = null;

    for (const rawLine of lines) {
        let out = '';
        let i = 0;

        while (i < rawLine.length) {
            const ch = rawLine[i];

            if (tripleQuote) {
                if (rawLine.startsWith(tripleQuote.repeat(3), i)) {
                    out += '   ';
                    i += 3;
                    tripleQuote = null;
                    continue;
                }

                // Literal contents must not participate in Python indentation checks
                out += ch === '\t' ? ch : ' ';
                i++;
                continue;
            }

            if (ch === '#') {
                out += ' '.repeat(rawLine.length - i);
                i = rawLine.length;
                break;
            }

            if (ch === '"' || ch === "'") {
                if (rawLine.startsWith(ch.repeat(3), i)) {
                    tripleQuote = ch;
                    out += '   ';
                    i += 3;
                    continue;
                }

                const { text, next } = readSingleLineString(rawLine, i);

                out += maskStrings ? ' '.repeat(text.length) : text;
                i = next;
                continue;
            }

            out += ch;
            i++;
        }

        result.push(out);
    }

    return result;
}

function indentWidth(line: string): number {
    let width = 0;

    for (const ch of line) {
        if (ch === ' ') width += 1;
        else if (ch === '\t') width += TAB_WIDTH;
        else break;
    }

    return width;
}

function isBlank(line: string): boolean {
    return line.trim().length === 0;
}

/**
 * Collect a multiline expression until its brackets balance or the file ends
 * Quoted brackets do not affect the balance
 */
function collectBalanced(
    lines: string[],
    startLine: number,
    startChar: number
): { text: string; endLine: number } {
    let text = '';
    let depth = 0;
    let started = false;
    let quote: string | null = null;

    for (let line = startLine; line < lines.length; line++) {
        const from = line === startLine ? startChar : 0;
        const current = lines[line];

        for (let i = from; i < current.length; i++) {
            const ch = current[i];

            text += ch;

            if (quote) {
                if (ch === '\\' && i + 1 < current.length) {
                    text += current[i + 1];
                    i++;
                    continue;
                }

                if (ch === quote) quote = null;

                continue;
            }

            if (ch === '"' || ch === "'") {
                quote = ch;
                continue;
            }

            if ('([{'.includes(ch)) {
                depth++;
                started = true;
            } else if (')]}'.includes(ch)) {
                depth--;

                if (started && depth === 0) {
                    return { text, endLine: line };
                }
            }
        }

        text += '\n';

        // Do not carry an incomplete single-line string into the next line
        quote = null;
    }

    return { text, endLine: lines.length - 1 };
}

/** Split at a top-level separator, preserving quoted and nested separators */
export function splitTopLevelArgs(args: string, separator = ','): string[] {
    const parts: string[] = [];

    let depth = 0;
    let quote: string | null = null;
    let current = '';

    for (let i = 0; i < args.length; i++) {
        const ch = args[i];

        if (quote) {
            current += ch;

            if (ch === '\\' && i + 1 < args.length) {
                current += args[i + 1];
                i++;
            } else if (ch === quote) {
                quote = null;
            }

            continue;
        }

        if (ch === '"' || ch === "'") {
            quote = ch;
            current += ch;
            continue;
        }

        if ('([{'.includes(ch)) depth++;
        if (')]}'.includes(ch)) depth--;

        if (ch === separator && depth === 0) {
            parts.push(current.trim());
            current = '';
            continue;
        }

        current += ch;
    }

    if (current.trim()) parts.push(current.trim());

    return parts.filter(Boolean);
}

function unquote(value: string): string {
    const trimmed = value.trim();
    const quote = trimmed[0];

    if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
        return trimmed.slice(1, -1);
    }

    return trimmed;
}

function isStringLiteral(value: string): boolean {
    const trimmed = value.trim();

    return (
        trimmed.length >= 2 &&
        (trimmed[0] === '"' || trimmed[0] === "'") &&
        trimmed.endsWith(trimmed[0])
    );
}

/**
 * Normalize model names and the self/AUTH_USER_MODEL markers
 * The caller preserves whether the original reference was a string literal
 */
function normalizeModelRef(rawValue: string): string | undefined {
    const value = unquote(rawValue).trim();
    if (!value) return undefined;

    if (value === SELF_MODEL_REF) return SELF_MODEL_REF;

    if (/(^|\.)AUTH_USER_MODEL$/.test(value) || /^get_user_model\s*\(/.test(value)) {
        return AUTH_USER_MODEL_REF;
    }

    // Reject expressions whose target cannot be identified statically
    if (!/^[A-Za-z_][\w.]*$/.test(value)) return undefined;

    return value;
}

/**
 * Read a relation target, its reference kind and an optional related_name
 * An omitted related_name is undefined; an explicit None is null
 */
export function parseRelationArgs(args: string): {
    relatedModelRaw?: string;
    relatedModelIsString?: boolean;
    relatedName?: string | null;
    relatedQueryName?: string;
} {
    const parts = splitTopLevelArgs(args);

    let targetRaw: string | undefined;
    let targetIsString: boolean | undefined;
    let relatedName: string | null | undefined;
    let relatedQueryName: string | undefined;

    for (const part of parts) {
        const kwargMatch = part.match(/^([A-Za-z_]\w*)\s*=\s*([\s\S]*)$/);

        // Use the first recognizable positional target unless to= supplies one
        if (!kwargMatch) {
            if (!targetRaw) {
                targetRaw = normalizeModelRef(part);
                targetIsString = isStringLiteral(part);
            }
            continue;
        }

        const [, key, value] = kwargMatch;

        if (key === 'to') {
            targetRaw = normalizeModelRef(value);
            targetIsString = isStringLiteral(value);
            continue;
        }

        if (key === 'related_query_name' && isStringLiteral(value)) {
            relatedQueryName = unquote(value);
        }

        if (key === 'related_name') {
            if (/^None$/.test(value.trim())) {
                relatedName = null;
            } else if (isStringLiteral(value)) {
                relatedName = unquote(value);
            }
        }
    }

    return { relatedModelRaw: targetRaw, relatedModelIsString: targetIsString, relatedName,
        relatedQueryName };
}

/** Recognize field constructors while excluding managers and other model helpers */
function isFieldCall(type: string, extraTypes: Set<string>): boolean {
    return (
        type.endsWith('Field') ||
        RELATION_FIELD_TYPES.has(type) ||
        type === 'GenericForeignKey' ||
        type === 'GenericRelation' ||
        extraTypes.has(type)
    );
}

const CLASS_START_RE = /^(\s*)class\s+(\w+)\s*([(:])/;

const FIELD_START_RE = /^(\s*)(\w+)\s*(?::[^=]+)?=\s*([A-Za-z_][\w.]*)\s*\(/;

/**
 * Parse top-level classes and their direct field declarations from source text
 * Model classification and inheritance are handled later by the registry
 */
export function parsePythonFile(
    filePath: string,
    content: string,
    options: ParserOptions = {}
): ParsedClass[] {
    const lines = sanitizeSource(content);
    const extraTypes = new Set(options.additionalFieldTypes ?? []);
    const classes: ParsedClass[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        const classMatch = line.match(CLASS_START_RE);
        if (!classMatch) continue;

        const [, indent, className, opener] = classMatch;

        // Only top-level classes are candidates for the model index
        if (indent.length > 0) continue;

        let headerEndLine = i;
        let bases: string[] = [];

        if (opener === '(') {
            const openIndex = line.indexOf('(', classMatch[0].length - 1);
            const { text, endLine } = collectBalanced(lines, i, openIndex);

            headerEndLine = endLine;

            const inner = text.slice(1, -1);

            bases = splitTopLevelArgs(inner)
                // Exclude metaclass= and other keyword arguments from the base-class list
                .filter(base => !base.includes('='));
        }

        const classIndent = indentWidth(line);

        let bodyEnd = headerEndLine;

        for (let j = headerEndLine + 1; j < lines.length; j++) {
            if (isBlank(lines[j])) continue;
            if (indentWidth(lines[j]) <= classIndent) break;

            bodyEnd = j;
        }

        const parsed: ParsedClass = {
            name: className,
            bases,
            filePath,
            line: i,
            column: line.indexOf(className),
            isAbstract: false,
            isProxy: false,
            fields: []
        };

        let bodyIndent = -1;

        for (let j = headerEndLine + 1; j <= bodyEnd; j++) {
            if (isBlank(lines[j])) continue;

            const currentIndent = indentWidth(lines[j]);

            if (bodyIndent === -1) bodyIndent = currentIndent;

            // Ignore method bodies and nested classes when collecting direct fields
            if (currentIndent !== bodyIndent) continue;

            const memberLine = lines[j];

            // Read abstract/proxy flags from the nested Meta block
            if (/^\s*class\s+Meta\b/.test(memberLine)) {
                for (let k = j + 1; k <= bodyEnd; k++) {
                    if (isBlank(lines[k])) continue;
                    if (indentWidth(lines[k]) <= currentIndent) break;

                    if (/^\s*abstract\s*=\s*True\b/.test(lines[k])) parsed.isAbstract = true;
                    if (/^\s*proxy\s*=\s*True\b/.test(lines[k])) parsed.isProxy = true;
                }

                continue;
            }

            const fieldMatch = memberLine.match(FIELD_START_RE);
            if (!fieldMatch) continue;

            const [, , fieldName, callee] = fieldMatch;

            const segments = callee.split('.');
            const fieldType = segments[segments.length - 1];

            if (!isFieldCall(fieldType, extraTypes)) continue;

            const openIndex = memberLine.indexOf('(', fieldMatch[0].length - 1);
            const { text, endLine } = collectBalanced(lines, j, openIndex);

            const field: ModelField = {
                name: fieldName,
                type: fieldType,
                sourceFilePath: filePath,
                sourceLine: j,
                sourceColumn: memberLine.indexOf(fieldName),
                isReverse: false
            };

            const args = text.slice(1, -1);

            if (splitTopLevelArgs(args).some(arg => /^primary_key\s*=\s*True$/.test(arg))) {
                field.isPrimaryKey = true;
            }

            if (RELATION_FIELD_TYPES.has(fieldType) || fieldType === 'GenericRelation') {
                const relation = parseRelationArgs(args);

                field.relatedModelRaw = relation.relatedModelRaw;
                field.relatedModelIsString = relation.relatedModelIsString;
                field.relatedName = relation.relatedName;
                if (relation.relatedQueryName) field.relatedQueryName = relation.relatedQueryName;
            }

            parsed.fields.push(field);

            // Skip continuation lines already consumed by this field expression
            j = Math.max(j, endLine);
        }

        classes.push(parsed);

        i = Math.max(i, headerEndLine);
    }

    return classes;
}

const FROM_IMPORT_RE = /^from\s+(\.*)([\w.]*)\s+import\s+([\s\S]*)$/;

/**
 * Parse top-level from-imports, including aliases and relative import levels
 * Plain module imports and star imports are not represented by this parser
 */
export function parseImports(
    content: string,
    lines = sanitizeSource(content)
): ParsedImport[] {
    const imports: ParsedImport[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (/^\s/.test(line)) continue;

        const match = line.match(FROM_IMPORT_RE);
        if (!match) continue;

        const [, dots, module, rest] = match;

        let names = rest;

        if (names.trimStart().startsWith('(')) {
            const openIndex = line.indexOf('(', line.indexOf(' import ') + 1);
            const { text, endLine } = collectBalanced(lines, i, openIndex);

            names = text.slice(1, -1);
            i = endLine;
        } else {
            // Join explicit backslash continuations before splitting imported names
            while (names.trimEnd().endsWith('\\') && i + 1 < lines.length) {
                names = names.trimEnd().slice(0, -1) + lines[++i];
            }
        }

        for (const part of splitTopLevelArgs(names)) {
            const aliasMatch = part.match(/^(\*|\w+)(?:\s+as\s+(\w+))?$/);
            if (!aliasMatch) continue;

            const [, original, alias] = aliasMatch;
            if (original === '*') continue;

            imports.push({
                local: alias || original,
                original,
                module,
                level: dots.length
            });
        }
    }

    return imports;
}

/** Parse classes and import bindings from the same source text */
export function parseModule(
    filePath: string,
    content: string,
    options: ParserOptions = {}
): ParsedModule {
    return {
        classes: parsePythonFile(filePath, content, options),
        imports: parseImports(content)
    };
}

/** One return statement, with tuple slots kept separate for caller unpacking */
export interface FunctionReturn {
    line: number;
    column: number;
    expressions: string[];
    tuple: boolean;
}

/** A top-level function whose result can be inspected without executing Python */
export interface ParsedFunction {
    name: string;
    bodyLine: number;
    parameters: string[];
    annotation?: string;
    returns: FunctionReturn[];
}

/** Lexical blocks used to keep bindings out of sibling and nested functions */
interface PythonScope {
    name: string;
    kind: 'def' | 'class';
    startLine: number;
    bodyLine: number;
    endLine: number;
    parameters: string[];
    parameterAnnotations: Map<string, string>;
    annotation?: string;
}

/**
 * Read `-> annotation:` or `:` after a def header without a regular expression:
 * nested optional whitespace around a lazy group backtracks polynomially on long lines
 */
function parseSignatureTail(tail: string): { annotation?: string } | null {
    const rest = tail.trimStart();

    if (rest.startsWith(':')) return {};
    if (!rest.startsWith('->')) return null;

    const colon = rest.indexOf(':', 2);

    return colon < 0 ? null : { annotation: rest.slice(2, colon).trim() || undefined };
}

function parseScopes(lines: string[]): PythonScope[] {
    const scopes: PythonScope[] = [];

    for (let line = 0; line < lines.length; line++) {
        const match = lines[line].match(/^\s*(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/);
        if (!match) continue;
        const indent = indentWidth(lines[line]);
        const open = lines[line].indexOf('(', match[0].length);
        const header = open >= 0 ? collectBalanced(lines, line, open) : null;
        const headerEnd = header?.endLine ?? line;
        const lastPart = header?.text.split('\n').pop() ?? '';
        const endColumn = header ? lastPart.length + (headerEnd === line ? open : 0) : 0;
        const signature = parseSignatureTail(lines[headerEnd].slice(endColumn));
        if (match[1] === 'def' && !signature) continue;
        let end = headerEnd + 1;

        while (end < lines.length && (isBlank(lines[end]) ||
            indentWidth(lines[end]) > indent)) end++;

        const parameters = match[1] === 'def' && header
            ? splitTopLevelArgs(header.text.slice(1, -1)) : [];
        const parameterAnnotations = new Map<string, string>();
        const names = parameters.map(parameter => {
            const name = parameter.match(/^[A-Za-z_]\w*/)?.[0] ?? '';
            const annotation = parameter.slice(name.length).match(/^\s*:\s*([^=]+)/)?.[1];

            if (name && annotation) parameterAnnotations.set(name, annotation.trim());

            return name;
        });

        scopes.push({ name: match[2], kind: match[1] as PythonScope['kind'], startLine: line,
            bodyLine: headerEnd + 1, endLine: end, parameters: names,
            parameterAnnotations, annotation: signature?.annotation });
        line = headerEnd;
    }

    return scopes;
}

/** Text from a column to the end of its logical line: open brackets and a backslash continue it */
function collectLogicalLine(
    lines: string[],
    startLine: number,
    startChar: number
): { text: string; endLine: number } {
    let text = '';
    let depth = 0;

    for (let line = startLine; line < lines.length; line++) {
        const current = lines[line];
        let quote: string | null = null;
        let continued = false;

        for (let i = line === startLine ? startChar : 0; i < current.length; i++) {
            const ch = current[i];

            if (quote) {
                text += ch;
                if (ch === '\\' && i + 1 < current.length) text += current[++i];
                else if (ch === quote) quote = null;
                continue;
            }

            if (ch === '#') break;
            if (ch === '\\' && current.slice(i + 1).trim() === '') {
                continued = true;
                break;
            }
            if (ch === '"' || ch === "'") quote = ch;
            else if ('([{'.includes(ch)) depth++;
            else if (')]}'.includes(ch)) depth = Math.max(0, depth - 1);

            text += ch;
        }

        if (depth === 0 && !continued) return { text, endLine: line };
        text += '\n';
    }

    return { text, endLine: lines.length - 1 };
}

/** Read top-level function signatures and their own return statements */
export function parseFunctions(
    content: string,
    lines = sanitizeSource(content),
    scopes = parseScopes(lines)
): ParsedFunction[] {
    const functions: ParsedFunction[] = [];

    for (const scope of scopes) {
        if (scope.kind !== 'def' || indentWidth(lines[scope.startLine]) !== 0) continue;
        const end = scope.endLine;
        const headerEnd = scope.bodyLine - 1;
        const parsed: ParsedFunction = {
            name: scope.name,
            bodyLine: scope.bodyLine,
            parameters: scope.parameters,
            annotation: scope.annotation,
            returns: []
        };

        for (let current = headerEnd + 1; current < end; current++) {
            // A nested block ends where its scope ends, including a multiline header whose
            // closing parenthesis sits at the nested indent
            const nested = scopes.find(item => item.startLine === current);

            if (nested) {
                current = Math.min(end, nested.endLine) - 1;
                continue;
            }

            if (/^\s*(?:(?:async\s+)?def|class)\s+/.test(lines[current])) {
                const nestedIndent = indentWidth(lines[current]);

                while (current + 1 < end && (isBlank(lines[current + 1]) ||
                    indentWidth(lines[current + 1]) > nestedIndent)) current++;
                continue;
            }

            const returned = lines[current].match(/^\s*return\b[ \t]*/);
            if (!returned) continue;

            const position = { line: current, column: returned[0].length };
            const logical = collectLogicalLine(lines, current, returned[0].length);
            const expression = logical.text.trim();

            current = logical.endLine;

            const inner = expression.startsWith('(') && expression.endsWith(')')
                ? expression.slice(1, -1).trim()
                : expression;
            const expressions = splitTopLevelArgs(inner);

            parsed.returns.push({
                ...position,
                expressions,
                tuple: expressions.length > 1 || inner.endsWith(',')
            });
        }

        functions.push(parsed);
    }

    return functions;
}

/** Nearest assignment, loop target, context-manager target or type annotation */
export interface VariableBinding {
    /** Offset within the lookback text; larger offsets are closer to the cursor */
    index: number;

    kind: 'expression' | 'annotation' | 'parameter';

    text: string;

    /** Slot selected by tuple unpacking, including multiline targets */
    tupleIndex?: number;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Collect bindings once so recursive lookups can select earlier writers without rescanning
 * Results are ordered nearest-first; annotations take precedence at an equal offset
 */
export function collectVariableBindings(
    source: ParsedSource,
    variableName: string,
    firstLine: number,
    endLine: number,
    endColumn: number
): VariableBinding[] {
    const name = escapeRegExp(variableName);
    const lines = source.codeLines.slice(firstLine, endLine + 1);
    const original = source.lines.slice(firstLine, endLine + 1);
    lines[lines.length - 1] = (lines[lines.length - 1] ?? '').slice(0, endColumn);
    original[original.length - 1] = (original[original.length - 1] ?? '').slice(0, endColumn);
    const text = lines.join('\n');
    const raw = original.join('\n');
    const scopes = source.scopes;
    const enclosing = scopes.filter(scope => scope.bodyLine <= endLine && endLine < scope.endLine)
        .reverse();
    const visible = enclosing.filter(scope => scope.kind !== 'class' || scope === enclosing[0]);
    const bindings: (VariableBinding & { scope?: PythonScope })[] = [];
    const lineOffsets = [0];
    for (const line of lines) {
        lineOffsets.push(lineOffsets[lineOffsets.length - 1] + line.length + 1);
    }
    const scopeAt = (index: number) => {
        while (index < text.length && /\s/.test(text[index])) index++;
        let line = 0;
        let upper = lineOffsets.length - 1;
        while (line < upper) {
            const middle = Math.ceil((line + upper) / 2);
            if (lineOffsets[middle] <= index) line = middle;
            else upper = middle - 1;
        }

        return scopes.filter(scope => scope.startLine <= firstLine + line &&
            firstLine + line < scope.endLine).pop();
    };
    const consider = (index: number, kind: VariableBinding['kind'], value: string) => {
        const scope = scopeAt(index);
        if (scope && !visible.includes(scope)) return;
        let start = index;
        while (start < text.length && /\s/.test(text[start])) start++;
        // Defaults and annotations in a def header describe parameters, not body bindings
        if (scope && (kind === 'annotation' || kind === 'expression' && scope.kind === 'def') &&
            start < (lineOffsets[scope.bodyLine - firstLine] ?? Infinity)) return;
        bindings.push({ index, kind, text: value, scope });
    };

    // Match standalone assignments, not attribute writes such as self.employee
    // Whitespace classes do not overlap: masked string literals are long runs of spaces
    const assignment = new RegExp(
        `(?:^|[\\n;])[ \\t]*(?:\\([ \\t]*)?${name}[ \\t]*(?::[^=\\n]*)?=(?!=)`,
        'g'
    );

    const loop = new RegExp(`\\bfor\\s+${name}\\s+in\\s+`, 'g');
    const contextTarget = new RegExp(`[ \\t]as[ \\t]+${name}\\b`);
    // Restrict annotations to line starts and argument lists to avoid loop colons
    const annotation = new RegExp(
        `(?:^|[\\n(,])[ \\t]*${name}[ \\t]*:[ \\t]*([\\w.'"\\[\\] |]+)`,
        'g'
    );

    let match: RegExpExecArray | null;

    let offset = 0;

    for (let line = 0; line < lines.length; line++) {
        const current = lines[line];
        const open = current.search(/\S/);
        let targets: string | undefined;
        let endLine = line;
        let endColumn = 0;

        if (open >= 0 && current[open] === '(') {
            const group = collectBalanced(lines, line, open);
            const lastPart = group.text.split('\n').pop() ?? '';

            targets = group.text.slice(1, -1);
            endLine = group.endLine;
            endColumn = lastPart.length + (endLine === line ? open : 0);
        } else {
            const group = current.match(/^[ \t]*([A-Za-z_]\w*(?:[ \t]*,[ \t]*[A-Za-z_]\w*)+)[ \t]*/);

            if (group) {
                targets = group[1];
                endColumn = group[0].length;
            }
        }

        const tail = lines[endLine].slice(endColumn).match(/^[ \t]*=(?!=)[ \t]*/);

        if (targets && tail) {
            const names = splitTopLevelArgs(targets);
            const slot = names.indexOf(variableName);
            const index = Math.max(0, offset - 1);

            if (slot >= 0 && names.every(name => /^[A-Za-z_]\w*$/.test(name))) {
                const rhs = original.slice(endLine).join('\n').slice(endColumn + tail[0].length);
                const before = bindings.length;

                consider(index, 'expression', rhs);
                if (bindings.length > before) bindings[bindings.length - 1].tupleIndex = slot;
            }
        }

        offset += current.length + 1;
    }

    while ((match = assignment.exec(text)) !== null) {
        consider(match.index, 'expression', raw.slice(match.index + match[0].length));
    }

    while ((match = loop.exec(text)) !== null) {
        consider(match.index, 'expression', raw.slice(match.index + match[0].length));
    }

    const withStatement = /\bwith[ \t]+/g;

    while ((match = withStatement.exec(text)) !== null) {
        const start = match.index + match[0].length;
        const lineEnd = text.indexOf('\n', start);
        const target = text.slice(start, lineEnd < 0 ? text.length : lineEnd).match(contextTarget);

        if (!target || target.index === undefined) continue;
        const expression = raw.slice(start, start + target.index).trim();

        if (expression) consider(match.index, 'expression', expression);
    }

    while ((match = annotation.exec(raw)) !== null) {
        const start = match.index + match[0].indexOf(variableName);
        if (text.slice(start, start + variableName.length) !== variableName) continue;
        consider(match.index, 'annotation', match[1]);
    }

    for (const scope of visible) {
        if (scope.parameters.includes(variableName)) {
            const index = scope.startLine < firstLine
                ? -1 : lineOffsets[scope.startLine - firstLine];

            bindings.push({ index, kind: 'parameter',
                text: scope.parameterAnnotations.get(variableName) ?? '', scope });
        }
    }

    const owner = [...visible, undefined].find(scope =>
        bindings.some(binding => binding.scope === scope));

    return bindings.filter(binding => binding.scope === owner)
        .reverse().sort((a, b) => b.index - a.index);
}

/** Bind positional and keyword arguments to known parameter names without evaluating defaults */
export function bindFunctionArguments(
    parameters: string[],
    argumentsText: string
): Map<string, string> {
    const argumentsList = splitTopLevelArgs(argumentsText);
    const bound = new Map<string, string>();

    for (let index = 0; index < parameters.length; index++) {
        const parameter = parameters[index];
        const keyword = argumentsList.find(value =>
            value.match(/^([A-Za-z_]\w*)\s*=(?!=)/)?.[1] === parameter);
        const argument = keyword ? keyword.slice(keyword.indexOf('=') + 1) : argumentsList[index];

        if (parameter && argument && !/^[A-Za-z_]\w*\s*=(?!=)/.test(argument)) {
            bound.set(parameter, argument);
        }
    }

    return bound;
}

/** Syntax metadata can be reused while model-dependent resolution results are invalidated */
export interface ParsedSource {
    lines: string[];
    codeLines: string[];
    scopes: PythonScope[];
    imports: ParsedImport[];
    functions: ParsedFunction[];
}

/** Cache reusable syntax and lexical blocks independently of the model index */
export function analyzeSource(content: string): ParsedSource {
    const lines = sanitizeSource(content);

    const scopes = parseScopes(lines);

    return {
        lines, codeLines: sanitizeSource(content, true), scopes,
        imports: parseImports(content, lines),
        functions: parseFunctions(content, lines, scopes)
    };
}

const SINGLE_MODEL_WRAPPERS = new Set(['Optional', 'QuerySet', 'Manager', 'list', 'List',
    'Iterable', 'Iterator', 'Sequence']);

/** Extract model alternatives only from supported annotations, rejecting unknown containers */
export function modelAnnotationNames(annotation: string, depth = 0): string[] | null {
    if (depth > 16) return null;
    const text = annotation.trim().replace(/^['"]|['"]$/g, '');
    if (text === 'None' || text === 'NoneType') return [];
    const union = splitTopLevelArgs(text, '|');
    const wrapper = text.match(/^(?:[A-Za-z_]\w*\.)?([A-Za-z_]\w*)\[([\s\S]*)\]$/);
    let alternatives: string[];

    if (union.length > 1) alternatives = union;
    else if (wrapper) {
        const args = splitTopLevelArgs(wrapper[2]);
        if (wrapper[1] !== 'Union' &&
            (!SINGLE_MODEL_WRAPPERS.has(wrapper[1]) || args.length !== 1)) return null;
        alternatives = args;
    } else return /^[A-Za-z_]\w*$/.test(text) ? [text] : null;

    const names: string[] = [];
    for (const alternative of alternatives) {
        const nested = modelAnnotationNames(alternative, depth + 1);
        if (!nested) return null;
        names.push(...nested);
    }

    return names;
}
