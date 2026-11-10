/**
 * Minimal VS Code API stub for running providers in Node
 * Only implements the editor APIs exercised by the extension and its tests
 */

import * as fs from 'fs';

export class Position {
    constructor(readonly line: number, readonly character: number) { }
}

export class Range {
    readonly start: Position;
    readonly end: Position;

    constructor(
        startLine: number | Position,
        startCharacter: number | Position,
        endLine?: number,
        endCharacter?: number
    ) {
        if (startLine instanceof Position && startCharacter instanceof Position) {
            this.start = startLine;
            this.end = startCharacter;

            return;
        }

        this.start = new Position(startLine as number, startCharacter as number);
        this.end = new Position(endLine ?? 0, endCharacter ?? 0);
    }
}

export class Uri {
    private constructor(
        readonly fsPath: string,
        readonly fragment: string = '',
        readonly scheme: string = 'file',
        readonly authority: string = ''
    ) { }

    static file(fsPath: string): Uri {
        return new Uri(fsPath);
    }

    with(change: { fragment?: string; scheme?: string; authority?: string }): Uri {
        return new Uri(this.fsPath, change.fragment ?? this.fragment,
            change.scheme ?? this.scheme, change.authority ?? this.authority);
    }

    toString(): string {
        return `${this.scheme}://${this.authority}${this.fsPath}${this.fragment ? '#' + this.fragment : ''}`;
    }
}

export class Location {
    constructor(readonly uri: Uri, readonly range: Range) { }
}

export class MarkdownString {
    value = '';

    appendMarkdown(text: string): MarkdownString {
        this.value += text;

        return this;
    }
}

export class CodeLens {
    constructor(
        readonly range: Range,
        readonly command?: { title: string; command: string; arguments?: unknown[] }
    ) { }
}

export class Hover {
    constructor(readonly contents: MarkdownString, readonly range?: Range) { }
}

export enum TreeItemCollapsibleState {
    None = 0,
    Collapsed = 1,
    Expanded = 2
}

export class ThemeColor {
    constructor(readonly id: string) { }
}

export class ThemeIcon {
    constructor(readonly id: string, readonly color?: ThemeColor) { }
}

export class TreeItem {
    id?: string;
    description?: string;
    tooltip?: string | MarkdownString;
    iconPath?: ThemeIcon;
    resourceUri?: Uri;
    command?: { title: string; command: string; arguments?: unknown[] };

    constructor(readonly label: string,
        readonly collapsibleState = TreeItemCollapsibleState.None) { }
}

export interface TreeProvider {
    getChildren(element?: unknown): unknown[];
    getTreeItem(element: unknown): TreeItem;
    onDidChangeTreeData(listener: () => void): { dispose(): unknown };
}

export enum CompletionItemKind {
    Field = 4,
    Operator = 23,
    Reference = 17
}

export class CompletionItem {
    detail?: string;
    sortText?: string;
    documentation?: MarkdownString;
    range?: Range;

    constructor(readonly label: string, readonly kind?: CompletionItemKind) { }
}

export enum ProgressLocation {
    Window = 10,
    Notification = 15
}

export enum ConfigurationTarget {
    Global = 1,
    Workspace = 2
}

let documentVersion = 0;

function nextDocumentVersion(): number {
    return ++documentVersion;
}

/** In-memory document implementing the provider-facing subset of TextDocument */
export class TextDocument {
    readonly uri: Uri;
    readonly languageId = 'python';
    readonly isClosed = false;

    /**
     * Assign a distinct version to every test document so caches cannot leak across samples
     * Tests that check cache reuse deliberately retain the same document instance
     */
    private currentVersion = nextDocumentVersion();

    get version(): number {
        return this.currentVersion;
    }
    private readonly lines: string[];

    constructor(fsPath: string, content: string, uri = Uri.file(fsPath)) {
        this.uri = uri;
        this.lines = content.split('\n');
    }

    /** Simulate an edit on the same document object, as VS Code does */
    replaceText(content: string): void {
        this.lines.splice(0, this.lines.length, ...content.split('\n'));
        this.currentVersion = nextDocumentVersion();
    }

    static fromFile(fsPath: string): TextDocument {
        return new TextDocument(fsPath, fs.readFileSync(fsPath, 'utf-8'));
    }

    get lineCount(): number {
        return this.lines.length;
    }

    lineAt(line: number): { text: string } {
        return { text: this.lines[line] ?? '' };
    }

    getText(range?: Range): string {
        if (!range) return this.lines.join('\n');

        if (range.start.line === range.end.line) {
            return (this.lines[range.start.line] ?? '').slice(
                range.start.character,
                range.end.character
            );
        }

        const parts: string[] = [
            (this.lines[range.start.line] ?? '').slice(range.start.character)
        ];

        for (let line = range.start.line + 1; line < range.end.line; line++) {
            parts.push(this.lines[line] ?? '');
        }

        parts.push((this.lines[range.end.line] ?? '').slice(0, range.end.character));

        return parts.join('\n');
    }

    getWordRangeAtPosition(position: Position, pattern?: RegExp): Range | undefined {
        const text = this.lines[position.line] ?? '';
        const regexp = new RegExp(pattern ?? /[A-Za-z_]\w*/, 'g');

        let match: RegExpExecArray | null;

        while ((match = regexp.exec(text)) !== null) {
            const start = match.index;
            const end = start + match[0].length;

            if (position.character >= start && position.character <= end) {
                return new Range(position.line, start, position.line, end);
            }
        }

        return undefined;
    }
}

export const configValues: Record<string, unknown> = {};

/** Files returned by the stub search; glob matching itself is not simulated */
export let workspaceFiles: string[] = [];

export function setWorkspaceFiles(paths: string[]): void {
    workspaceFiles = paths;
}

export const registered: {
    definition: any[];
    hover: any[];
    completion: any[];
    references: any[];
    codeLens: any[];
    commands: Map<string, (...args: any[]) => any>;
    trees: Map<string, TreeProvider>;
} = {
    definition: [],
    hover: [],
    completion: [],
    references: [],
    codeLens: [],
    commands: new Map(),
    trees: new Map()
};

const noopDisposable = { dispose: () => undefined };
const noopEvent = () => noopDisposable;

/** Disposable emitter used by the extension for CodeLens changes */
export class EventEmitter<T> {
    private listeners: ((value: T) => unknown)[] = [];

    readonly event = (listener: (value: T) => unknown) => {
        this.listeners.push(listener);

        return { dispose: () => {
            this.listeners = this.listeners.filter(current => current !== listener);
        } };
    };

    fire(value: T): void {
        this.listeners.forEach(listener => listener(value));
    }

    dispose(): void {
        this.listeners = [];
    }
}

/** Workspace-event emitter used by test drivers */
class Emitter<T> {
    private listeners: ((value: T) => unknown)[] = [];

    readonly event = (listener: (value: T) => unknown) => {
        this.listeners.push(listener);

        return noopDisposable;
    };

    fire(value: T): void {
        this.listeners.forEach(listener => listener(value));
    }
}

/** Workspace events exposed to provider and cache tests */
export const emitters = {
    save: new Emitter<TextDocument>(),
    create: new Emitter<Uri>(),
    remove: new Emitter<Uri>(),
    fileChange: new Emitter<Uri>(),
    change: new Emitter<{ document: TextDocument }>(),
    config: new Emitter<{ affectsConfiguration: (section: string) => boolean }>()
};

export const outputLines: string[] = [];

export const window = {
    registerTreeDataProvider: (viewId: string, provider: TreeProvider) => {
        registered.trees.set(viewId, provider);

        return { dispose: () => { registered.trees.delete(viewId); } };
    },
    createOutputChannel: () => ({
        appendLine: (message: string) => { outputLines.push(message); },
        show: () => undefined,
        dispose: () => undefined
    }),
    withProgress: (_options: unknown, task: () => Promise<void>) => task(),
    setStatusBarMessage: () => noopDisposable,
    showInformationMessage: () => Promise.resolve(undefined)
};

export const workspace = {
    workspaceFolders: [{ uri: Uri.file('/workspace') }],
    textDocuments: [] as TextDocument[],

    getConfiguration: () => ({
        get: (key: string, fallback: unknown) =>
            key in configValues ? configValues[key] : fallback,
        update: () => Promise.resolve()
    }),

    openTextDocument: (uri: Uri) => Promise.resolve(
        workspace.textDocuments.find(document => document.uri.fsPath === uri.fsPath) ??
        TextDocument.fromFile(uri.fsPath)
    ),

    findFiles: (_include: string, _exclude?: string) =>
        Promise.resolve(workspaceFiles.map(Uri.file)),

    fs: {
        readFile: (uri: Uri) => Promise.resolve(fs.readFileSync(uri.fsPath))
    },

    createFileSystemWatcher: (_glob: string, _ignoreCreate = false, ignoreChange = false) => ({
        onDidCreate: emitters.create.event,
        onDidDelete: emitters.remove.event,
        onDidChange: ignoreChange ? noopEvent : emitters.fileChange.event,
        dispose: () => undefined
    }),

    onDidSaveTextDocument: emitters.save.event,
    onDidChangeTextDocument: emitters.change.event,
    onDidChangeConfiguration: emitters.config.event,
    onDidChangeWorkspaceFolders: noopEvent
};

/** Keep existing I/O fault and race controls shared by both test transports */
export const localFiles = {
    readFile: (fsPath: string): Promise<Buffer> => workspace.fs.readFile(Uri.file(fsPath))
};

export const env = { remoteName: undefined as string | undefined };

export const languages = {
    registerDefinitionProvider: (_selector: unknown, provider: any) => {
        registered.definition.push(provider);

        return noopDisposable;
    },
    registerHoverProvider: (_selector: unknown, provider: any) => {
        registered.hover.push(provider);

        return noopDisposable;
    },
    registerCompletionItemProvider: (_selector: unknown, provider: any) => {
        registered.completion.push(provider);

        return noopDisposable;
    },
    registerReferenceProvider: (_selector: unknown, provider: any) => {
        registered.references.push(provider);

        return noopDisposable;
    },
    registerCodeLensProvider: (_selector: unknown, provider: any) => {
        registered.codeLens.push(provider);

        return noopDisposable;
    }
};

export const commands = {
    registerCommand: (name: string, handler: (...args: any[]) => any) => {
        registered.commands.set(name, handler);

        return noopDisposable;
    },
    executeCommand: (name: string, ...args: any[]) =>
        Promise.resolve(registered.commands.get(name)?.(...args))
};
