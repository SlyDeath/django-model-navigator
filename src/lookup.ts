/**
 * Parse cursor context for Django lookup paths and read identifier chains
 * Independent of VS Code: callers provide line access and cursor coordinates
 */

/** Read a document line by its zero-based number */
export type LineAt = (line: number) => string;

/** Calls where arguments may contain model fields or lookup paths */
export const LOOKUP_METHODS = new Set([
    'filter',
    'exclude',
    'get',
    'get_or_create',
    'update_or_create',
    'create',
    'update',
    'annotate',
    'aggregate',
    'alias',
    'order_by',
    'values',
    'values_list',
    'only',
    'defer',
    'distinct',
    'select_related',
    'prefetch_related',
    'latest',
    'earliest',
    'dates',
    'datetimes',
    'F',
    'Q',
    'OuterRef',
    'Count',
    'Sum',
    'Avg',
    'Min',
    'Max',
    'Prefetch',
    'exists',
    'count'
]);

/**
 * Expressions whose arguments name fields of the enclosing queryset
 * A receiver such as models.Q names a module, not a queryset
 */
export const CONTEXT_EXPRESSIONS = new Set(['F', 'Q', 'OuterRef', 'Count', 'Sum', 'Avg', 'Min',
    'Max', 'Prefetch']);

/** Strip these queryset API names from the end of a model expression */
export const QUERYSET_TOKENS = new Set([
    'objects',
    'all',
    'filter',
    'exclude',
    'annotate',
    'aggregate',
    'alias',
    'order_by',
    'values',
    'values_list',
    'only',
    'defer',
    'distinct',
    'select_related',
    'prefetch_related',
    'get',
    'get_or_create',
    'update_or_create',
    'create',
    'update',
    'first',
    'last',
    'latest',
    'earliest',
    'reverse',
    'none',
    'union',
    'intersection',
    'difference',
    'using',
    'iterator',
    '_default_manager',
    '_base_manager'
]);

/** A call surrounding the cursor */
export interface EnclosingCall {
    callee: string;

    /** Receiver chain before the callee, such as ["Review", "objects"] */
    receiver: string[];
}

/** Lookup path and segment coordinates at the cursor */
export interface LookupContext {
    /** Enclosing calls, from innermost to outermost */
    calls: EnclosingCall[];

    /** Full lookup path, such as client__profile__email */
    path: string;

    segments: string[];

    /** Zero-based segment index at the cursor */
    index: number;

    /** Zero-based start column of the current segment */
    segmentStart: number;

    /** Zero-based end column of the full path */
    pathEnd: number;

    /** Whether the path is inside a string literal */
    inString: boolean;
}

/** prefetch_related() and Prefetch() traverse attribute names, not query names */
const ACCESSOR_LOOKUPS = new Set(['prefetch_related', 'Prefetch']);

/** Whether the innermost queryset call names reverse relations by their accessors */
export function usesAccessorNames(lookup: LookupContext): boolean {
    const call = lookup.calls.find(item => LOOKUP_METHODS.has(item.callee));

    return !!call && ACCESSOR_LOOKUPS.has(call.callee);
}

/** Bound bracket scanning to nearby lines for interactive provider calls */
const MAX_LOOKBACK_LINES = 40;

function isWordChar(char: string | undefined): boolean {
    return !!char && /[A-Za-z0-9_]/.test(char);
}

/** An opening bracket that has not closed before the cursor */
interface OpenBracket {
    char: string;
    line: number;
    column: number;
}

/**
 * Read the identifier chain before a call, skipping completed calls and subscripts
 * Review.objects.filter(x=1).exclude( yields ["Review", "objects", "filter", "exclude"]
 */
function readChainBefore(line: string, column: number): string[] {
    const parts: string[] = [];

    let current = '';
    let i = column - 1;

    const flush = () => {
        if (current) {
            parts.unshift(current);
            current = '';
        }
    };

    while (i >= 0) {
        const char = line[i];

        if (isWordChar(char)) {
            current = char + current;
            i--;
            continue;
        }

        if (char === '.') {
            flush();
            i--;
            continue;
        }

        if (char === ')' || char === ']') {
            const closing = char;
            const opening = closing === ')' ? '(' : '[';

            let depth = 0;

            while (i >= 0) {
                if (line[i] === closing) depth++;
                else if (line[i] === opening) {
                    depth--;

                    if (depth === 0) {
                        i--;
                        break;
                    }
                }

                i--;
            }

            flush();

            continue;
        }

        break;
    }

    flush();

    return parts;
}

/** Bracket and string state at the cursor */
interface ScanState {
    brackets: OpenBracket[];
    quote: string | null;
    quoteTriple: boolean;
    quoteLine: number;
    quoteColumn: number;
}

/** Scan a bounded lookback window for unmatched brackets and string state */
function scanToCursor(lineAt: LineAt, line: number, character: number): ScanState {
    const state: ScanState = {
        brackets: [],
        quote: null,
        quoteTriple: false,
        quoteLine: -1,
        quoteColumn: -1
    };

    const from = Math.max(0, line - MAX_LOOKBACK_LINES);

    for (let current = from; current <= line; current++) {
        const text = lineAt(current);
        const limit = current === line ? character : text.length;

        let i = 0;

        while (i < limit) {
            const char = text[i];

            if (state.quote) {
                if (char === '\\' && !state.quoteTriple) {
                    i += 2;
                    continue;
                }

                if (char === state.quote) {
                    if (state.quoteTriple) {
                        if (text.startsWith(state.quote.repeat(3), i)) {
                            state.quote = null;
                            state.quoteTriple = false;
                            i += 3;
                            continue;
                        }
                    } else {
                        state.quote = null;
                        i++;
                        continue;
                    }
                }

                i++;
                continue;
            }

            if (char === '#') break;

            if (char === '"' || char === "'") {
                state.quote = char;
                state.quoteTriple = text.startsWith(char.repeat(3), i);
                state.quoteLine = current;
                state.quoteColumn = state.quoteTriple ? i + 2 : i;
                i += state.quoteTriple ? 3 : 1;
                continue;
            }

            if ('([{'.includes(char)) {
                state.brackets.push({ char, line: current, column: i });
                i++;
                continue;
            }

            if (')]}'.includes(char)) {
                state.brackets.pop();
                i++;
                continue;
            }

            i++;
        }

        // Keep an incomplete single-line string only on the cursor's line
        if (current < line && state.quote && !state.quoteTriple) state.quote = null;
    }

    return state;
}

function previousMeaningfulChar(lineAt: LineAt, line: number, column: number): string | null {
    for (let current = line; current >= 0; current--) {
        const text = lineAt(current);
        const from = current === line ? column - 1 : text.length - 1;

        for (let i = from; i >= 0; i--) {
            if (!/\s/.test(text[i])) return text[i];
        }
    }

    return null;
}

/** Return lookup context for a keyword or string argument, or null outside a call */
export function getLookupContext(
    lineAt: LineAt,
    line: number,
    character: number
): LookupContext | null {
    const state = scanToCursor(lineAt, line, character);

    const openParens = state.brackets.filter(bracket => bracket.char === '(');
    if (openParens.length === 0) return null;

    const text = lineAt(line);

    let pathStart: number;
    let pathEnd: number;

    if (state.quote) {
        // Only string paths starting on the cursor's line have usable replacement coordinates
        if (state.quoteLine !== line) return null;

        pathStart = state.quoteColumn + 1;
        pathEnd = pathStart;

        while (pathEnd < text.length && text[pathEnd] !== state.quote) pathEnd++;

        // Accept a standalone string argument, not a string inside an unrelated expression
        const before = previousMeaningfulChar(lineAt, line, state.quoteColumn);

        if (before !== '(' && before !== ',' && before !== '[') return null;
    } else {
        pathStart = character;

        while (pathStart > 0 && isWordChar(text[pathStart - 1])) pathStart--;

        pathEnd = character;

        while (pathEnd < text.length && isWordChar(text[pathEnd])) pathEnd++;

        // Only consider keyword names at an argument boundary
        const before = previousMeaningfulChar(lineAt, line, pathStart);

        if (before !== '(' && before !== ',') return null;
    }

    let path = text.slice(pathStart, pathEnd);

    // Ignore the descending-order prefix in order_by("-created_at")
    if (path.startsWith('-')) {
        path = path.slice(1);
        pathStart++;
    }

    if (character < pathStart) return null;

    const calls: EnclosingCall[] = [];

    for (const paren of [...openParens].reverse()) {
        const chain = readChainBefore(lineAt(paren.line), paren.column);
        if (chain.length === 0) continue;

        calls.push({
            callee: chain[chain.length - 1],
            receiver: chain.slice(0, -1)
        });
    }

    if (calls.length === 0) return null;

    const prefix = path.slice(0, character - pathStart);
    const prefixSegments = prefix.split('__');
    const segments = path.split('__');

    const index = prefixSegments.length - 1;
    const segmentStart = pathStart + prefix.length - prefixSegments[index].length;

    return {
        calls,
        path,
        segments,
        index,
        segmentStart,
        pathEnd,
        inString: state.quote !== null
    };
}

const NON_MODEL_RESULTS = new Set(['values', 'values_list', 'aggregate', 'update']);
const TUPLE_RESULTS = new Set(['get_or_create', 'update_or_create']);

/** Element of an (object, created) result taken by a literal subscript: get_or_create(...)[0] */
export function tupleSubscript(text: string): number | undefined {
    const { parts, end } = scanChainForward(text);

    if (!TUPLE_RESULTS.has(parts[parts.length - 1] ?? '')) return undefined;

    const index = text.slice(0, end).match(/\)\s*\[\s*(\d+)\s*\]$/)?.[1];

    return index === undefined ? undefined : Number(index);
}

/** Separate the model used by lookup arguments from the shape of an ORM result */
export function modelResultChain(chain: string[], tupleIndex?: number): string[] | null {
    const tupleCall = chain.findIndex((part, index) => index > 0 && TUPLE_RESULTS.has(part));

    if (chain.some((part, index) => index > 0 && NON_MODEL_RESULTS.has(part))) return null;
    if (tupleCall >= 0) {
        if (tupleIndex !== 0 || tupleCall !== chain.length - 1) return null;
    } else if (tupleIndex !== undefined) return null;

    return stripQuerysetTokens(chain);
}

/** Return a copy of the chain without trailing manager/queryset API names */
export function stripQuerysetTokens(chain: string[]): string[] {
    const result = [...chain];

    while (result.length > 0 && QUERYSET_TOKENS.has(result[result.length - 1])) {
        result.pop();
    }

    return result;
}

/** Return the position after the matching bracket, or text.length if it remains open */
function skipBracketGroup(text: string, start: number): number {
    const open = text[start];
    const close = open === '(' ? ')' : open === '[' ? ']' : '}';

    let depth = 0;
    let quote: string | null = null;
    let i = start;

    while (i < text.length) {
        const char = text[i];

        if (quote) {
            if (char === '\\') i++;
            else if (char === quote) quote = null;

            i++;
            continue;
        }

        if (char === '"' || char === "'") {
            quote = char;
            i++;
            continue;
        }

        if (char === open) depth++;
        else if (char === close) {
            depth--;

            if (depth === 0) return i + 1;
        }

        i++;
    }

    return text.length;
}

/**
 * Read the initial identifier chain, ignoring call arguments and subscripts
 * site.employees.all() yields ["site", "employees", "all"]; sorted(sites) yields ["sorted"]
 */
export function readChainForward(text: string): string[] {
    return scanChainForward(text).parts;
}

/** Dotted names of a leading expression and the offset where that expression ends */
function scanChainForward(text: string): { parts: string[]; end: number } {
    const parts: string[] = [];

    let current = '';
    let i = 0;

    // Allow whitespace and opening parentheses around the expression
    while (i < text.length && (/\s/.test(text[i]) || text[i] === '(')) i++;

    const flush = () => {
        if (current) {
            parts.push(current);
            current = '';
        }
    };

    while (i < text.length) {
        const char = text[i];

        if (/[A-Za-z0-9_]/.test(char)) {
            current += char;
            i++;
            continue;
        }

        if (char === '.') {
            flush();
            i++;
            continue;
        }

        if (char === '(' || char === '[') {
            flush();
            i = skipBracketGroup(text, i);
            continue;
        }

        break;
    }

    flush();

    return { parts, end: i };
}

/**
 * Return arguments of a call to a single name at the start of an expression
 * Return null for method chains such as site.employees.all()
 */
export function readCallArguments(text: string): string | null {
    let start = 0;

    while (start < text.length && /\s/.test(text[start])) start++;

    const open = text.indexOf('(', start);
    if (open === -1) return null;

    if (!/^[A-Za-z_]\w*\s*$/.test(text.slice(start, open))) return null;

    const end = skipBracketGroup(text, open);

    return text.slice(open + 1, end - 1);
}
