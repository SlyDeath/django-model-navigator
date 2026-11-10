/**
 * VS Code integration for Django model navigation
 * Owns workspace scanning, document context, provider registration and index lifetime
 */

import * as path from 'path';
import { readFile } from 'fs/promises';
import * as vscode from 'vscode';

import {
    NavigatorConfig,
    RESCAN_KEYS,
    buildExcludeGlob,
    buildSearchPatterns,
    defaultConfig,
    readConfig
} from './config';
import { logger } from './logger';
import { isBuiltinModelImport } from './builtins';
import {
    CONTEXT_EXPRESSIONS,
    LOOKUP_METHODS,
    LineAt,
    LookupContext,
    getLookupContext,
    modelResultChain,
    readCallArguments,
    readChainForward,
    stripQuerysetTokens,
    tupleSubscript,
    usesAccessorNames
} from './lookup';
import {
    ParsedImport,
    VariableBinding,
    analyzeSource,
    bindFunctionArguments,
    collectVariableBindings,
    parseModule,
    splitTopLevelArgs
} from './parser';
import {
    ModelUsage,
    ParsedFile,
    appNameFromPath,
    buildModelIndex,
    collectAllModelUsages,
    collectModelUsages,
    findModelByName,
    resolveImportFile,
    resolveImportedModel,
    findModelField,
    lookupFieldName,
    resolveFieldChain,
    resolveFunctionResult,
    resolveModelAnnotation,
    resolveRelatedModel,
    resolveLookupPrefix,
    walkLookupPath
} from './registry';
import {
    DJANGO_LOOKUPS,
    ModelField,
    ModelIndex,
    ModelInfo,
    RELATION_LOOKUPS,
    createEmptyIndex
} from './types';

let config: NavigatorConfig = defaultConfig();

/** Debounce file events before adding an update to the scan queue */
const RESCAN_DEBOUNCE_MS = 500;

/** Bound assignment searches so completion does not scan arbitrarily large documents */
const MAX_VARIABLE_LOOKBACK_LINES = 1000;

/** Bound recursive assignment resolution, including cyclic references */
const MAX_VARIABLE_DEPTH = 8;

/**
 * Wrappers whose result preserves the model type of their first argument
 * For example, sorted(sites, key=...) still contains Site objects
 */
const MODEL_SOURCE_CALLS = new Set([
    'list',
    'sorted',
    'reversed',
    'tuple',
    'set',
    'iter',
    'next',
    'copy',
    'deepcopy',
    'get_object_or_404',
    'get_list_or_404',
    'aget_object_or_404',
    'aget_list_or_404'
]);

/** File events accumulated during the debounce interval */
interface PendingUpdate {
    full: boolean;

    files: Set<string>;

    removals: Set<string>;
}

interface IndexStatus {
    phase: 'idle' | 'scanning' | 'ready' | 'error';
    lastUpdated?: number;
    durationMs?: number;
    error?: string;
}

/**
 * Cache parsed files so saving one model file does not reread the workspace
 * Full and partial scans share a queue to preserve independent updates
 */
class ModelStore {
    private index: ModelIndex = createEmptyIndex();
    private scanStatus: IndexStatus = { phase: 'idle' };

    private parsed = new Map<string, ParsedFile>();
    private sourcePaths: vscode.Uri[] | undefined;
    private sourcePathEpoch = 0;

    // Disposal invalidates in-flight results and work already queued in this lifetime
    private generation = 0;
    private updates: Promise<void> = Promise.resolve();
    private timer: ReturnType<typeof setTimeout> | undefined;

    private pending: PendingUpdate = {
        full: false,
        files: new Set(),
        removals: new Set()
    };

    get current(): ModelIndex {
        return this.index;
    }

    get status(): IndexStatus {
        return this.scanStatus;
    }

    get sourceFiles(): vscode.Uri[] | undefined {
        return this.sourcePaths;
    }

    invalidateSourcePaths(): void {
        this.sourcePaths = undefined;
        this.sourcePathEpoch++;
    }

    private scanFailed(error: unknown): void {
        this.scanStatus = { ...this.scanStatus, phase: 'error',
            error: error instanceof Error ? error.message : String(error) };
        overviewChanged.fire();
    }

    has(fsPath: string): boolean {
        return this.parsed.has(fsPath);
    }

    /** Queue a full workspace scan after earlier updates */
    refresh(): Promise<void> {
        return this.enqueue(() => this.scan());
    }

    private async scan(): Promise<void> {
        const generation = this.generation;
        const startedAt = Date.now();

        try {
            const pathEpoch = this.sourcePathEpoch;
            const [files, sources] = await Promise.all([
                collectParsedFiles(config), collectSourcePaths(config)
            ]);

            if (generation !== this.generation) {
                logger.debug('⏭ Scan result dropped: the store was disposed');

                return;
            }

            this.sourcePaths = pathEpoch === this.sourcePathEpoch ? sources : undefined;
            this.parsed = new Map(files.map(file => [file.filePath, file]));
            this.rebuild(`full scan in ${Date.now() - startedAt} ms`, true, startedAt);
        } catch (error) {
            this.scanFailed(error);
            logger.error('❌ Failed to update the model cache:', error);
        }
    }

    /** Queue a partial scan and optional removals without discarding other files */
    refreshFiles(paths: string[], removals: string[] = []): Promise<void> {
        if (paths.length === 0 && removals.length === 0) return Promise.resolve();

        return this.enqueue(() => this.scanFiles(paths, removals));
    }

    private async scanFiles(paths: string[], removals: string[]): Promise<void> {
        if (paths.length === 0 && removals.length === 0) return;

        const generation = this.generation;
        const startedAt = Date.now();

        try {
            const updated = await Promise.all(paths.map(fsPath => parseOneFile(fsPath, config)));

            if (generation !== this.generation) {
                logger.debug('⏭ Partial update dropped: the store was disposed');

                return;
            }

            for (const fsPath of removals) this.parsed.delete(fsPath);

            for (const item of updated) {
                if (item.file) this.parsed.set(item.path, item.file);
                else this.parsed.delete(item.path);
            }

            const touched = paths.length + removals.length;

            this.rebuild(`${touched} file(s) in ${Date.now() - startedAt} ms`, false, startedAt);
        } catch (error) {
            this.scanFailed(error);
            logger.error('❌ Failed to update the model cache:', error);
        }
    }

    /** Serialize scans so independent partial updates cannot invalidate each other */
    private enqueue(update: () => Promise<void>): Promise<void> {
        const generation = this.generation;

        this.updates = this.updates.then(async () => {
            if (generation !== this.generation) return;

            this.scanStatus = { ...this.scanStatus, phase: 'scanning', error: undefined };
            overviewChanged.fire();
            await update();
        }).catch(error => {
            this.scanFailed(error);
            logger.error('❌ Failed to process a model cache update:', error);
        });

        return this.updates;
    }

    /** Coalesce file events during the debounce interval, then enqueue one update */
    schedule(
        reason: string,
        update: { full?: boolean; files?: string[]; removals?: string[] } = {}
    ): void {
        if (update.full) this.pending.full = true;

        for (const fsPath of update.files ?? []) {
            this.pending.files.add(fsPath);
            this.pending.removals.delete(fsPath);
        }

        for (const fsPath of update.removals ?? []) {
            this.pending.removals.add(fsPath);
            this.pending.files.delete(fsPath);
        }

        if (this.timer) clearTimeout(this.timer);

        this.timer = setTimeout(() => {
            this.timer = undefined;

            const { full, files, removals } = this.pending;

            this.pending = { full: false, files: new Set(), removals: new Set() };

            logger.debug(`🔁 Rescan triggered by ${reason}`);

            void (full
                ? this.refresh()
                : this.refreshFiles([...files], [...removals]));
        }, RESCAN_DEBOUNCE_MS);
    }

    /** Publish an index from parsed files and invalidate dependent provider caches */
    private rebuild(reason: string, verbose = false, scanStartedAt = Date.now()): void {
        const startedAt = Date.now();

        this.index = buildModelIndex([...this.parsed.values()], {
            userModel: config.userModel,
            includeBuiltins: config.includeBuiltinModels
        });

        logger.debug(
            `✅ Models in cache: ${this.index.models.length}` +
            ` (${reason}, index rebuilt in ${Date.now() - startedAt} ms)`
        );

        this.scanStatus = { phase: 'ready', lastUpdated: Date.now(),
            durationMs: Date.now() - scanStartedAt };
        clearFunctionDocuments();
        codeLensChanged.fire();
        overviewChanged.fire();

        if (verbose && logger.isDebugEnabled) {
            for (const model of this.index.models) {
                logger.debug(
                    `   • ${model.fullName}${model.isAbstract ? ' [abstract]' : ''}` +
                    `${model.isProxy ? ' [proxy]' : ''} — ${model.fields.length} field(s)`
                );
            }
        }
    }

    dispose(): void {
        if (this.timer) clearTimeout(this.timer);

        this.timer = undefined;
        this.generation++;
        this.invalidateSourcePaths();
        clearFunctionDocuments();
        this.pending = { full: false, files: new Set(), removals: new Set() };
        this.parsed.clear();
        this.index = createEmptyIndex();
        this.scanStatus = { phase: 'idle' };
    }
}

const store = new ModelStore();

/** Notify CodeLens consumers after a new index is published */
const codeLensChanged = new vscode.EventEmitter<void>();
const overviewChanged = new vscode.EventEmitter<void>();

/** Register extension resources and start the initial workspace scan */
export function activate(context: vscode.ExtensionContext): void {
    config = readConfig();
    logger.setDebug(config.debug);
    logger.debug('🔄 Django Model Navigator is activated');

    context.subscriptions.push({ dispose: () => logger.dispose() });
    context.subscriptions.push({ dispose: () => store.dispose() });
    context.subscriptions.push(codeLensChanged);
    context.subscriptions.push(overviewChanged);
    registerSidebar(context);

    void store.refresh();

    registerCommands(context);
    registerWatchers(context);
    registerProviders(context);
}

type ModelTreeNode =
    { kind: 'app'; id: string; label: string; models: ModelInfo[] } |
    { kind: 'model'; model: ModelInfo } |
    { kind: 'field'; owner: ModelInfo; field: ModelField };

/** Native tree backed by the published index; expanding it performs no source I/O */
class ModelTreeProvider implements vscode.TreeDataProvider<ModelTreeNode> {
    readonly onDidChangeTreeData = codeLensChanged.event;
    private cachedIndex: ModelIndex | undefined;
    private groups: Extract<ModelTreeNode, { kind: 'app' }>[] = [];

    private applications(): Extract<ModelTreeNode, { kind: 'app' }>[] {
        const index = store.current;
        if (this.cachedIndex === index) return this.groups;

        const byApp = new Map<string, Extract<ModelTreeNode, { kind: 'app' }>>();

        for (const model of index.models) {
            const id = `${model.isBuiltin ? 'builtin' : 'project'}:${model.appName}`;
            let group = byApp.get(id);

            if (!group) {
                group = { kind: 'app', id,
                    label: model.appName + (model.isBuiltin ? ' (Django)' : ''), models: [] };
                byApp.set(id, group);
            }

            group.models.push(model);
        }

        this.groups = [...byApp.values()].sort((a, b) => a.label.localeCompare(b.label));
        for (const group of this.groups) {
            group.models.sort((a, b) => a.name.localeCompare(b.name));
        }
        this.cachedIndex = index;

        return this.groups;
    }

    getChildren(element?: ModelTreeNode): ModelTreeNode[] {
        if (!element) return this.applications();
        if (element.kind === 'app') {
            const group = this.applications().find(app => app.id === element.id);

            return group?.models.map(model => ({ kind: 'model', model })) ?? [];
        }
        if (element.kind === 'model') {
            const owner = store.current.byKey.get(element.model.key);

            return owner?.fields.map(field => ({ kind: 'field', owner, field })) ?? [];
        }

        return [];
    }

    getTreeItem(element: ModelTreeNode): vscode.TreeItem {
        if (element.kind === 'app') {
            const item = new vscode.TreeItem(element.label,
                vscode.TreeItemCollapsibleState.Collapsed);

            item.id = element.id;
            item.description = String(element.models.length);
            item.iconPath = new vscode.ThemeIcon('package');

            return item;
        }

        const model = element.kind === 'model' ? element.model : element.owner;
        const field = element.kind === 'field' ? element.field : undefined;
        const item = new vscode.TreeItem(field?.name ?? model.name,
            field ? vscode.TreeItemCollapsibleState.None :
            vscode.TreeItemCollapsibleState.Collapsed);
        const badges = field
            ? [field.isImplicit ? 'implicit' : '', field.isInherited ? 'inherited' : '',
                field.isReverse ? 'reverse' : ''].filter(Boolean)
            : [model.isAbstract ? 'abstract' : '', model.isProxy ? 'proxy' : ''].filter(Boolean);

        item.id = field ? `${model.key}::field:${field.name}` : model.key;
        item.description = [field ? describeFieldType(field) : `${model.fields.length} fields`,
            ...badges].join(' · ');
        const source = field ? field.sourceFilePath ?? 'Built-in Django description' :
            model.isBuiltin ? 'Built-in Django description' : model.filePath;

        item.tooltip = field ? `${model.fullName}.${field.name} — ${item.description}\n${source}` :
            `${model.fullName}\n${source}`;
        item.iconPath = new vscode.ThemeIcon(field ? 'symbol-field' : 'symbol-class');
        const location = field && !field.isImplicit ? fieldLocation(field) : modelLocation(model);

        if (location) {
            item.resourceUri = location.uri;
            item.command = { command: 'vscode.open', title: 'Go to Definition',
                arguments: [location.uri, { selection: location.range, preview: true }] };
        }

        return item;
    }

    dispose(): void {
        this.cachedIndex = undefined;
        this.groups = [];
    }
}

/** Status is updated by scan events, without polling or provider-time parsing */
class OverviewTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    readonly onDidChangeTreeData = overviewChanged.event;

    getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
        return item;
    }

    getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
        if (element) return [];

        const index = store.current;
        const status = store.status;
        const builtins = index.models.filter(model => model.isBuiltin).length;
        const states = { idle: 'Waiting for scan', scanning: 'Scanning...', ready: 'Ready', error: 'Error' };
        const rows: [string, string, string][] = [
            ['Index', states[status.phase], status.phase === 'scanning' ? 'sync~spin' :
            status.phase === 'error' ? 'error' : 'database'],
            ['Project models', String(index.models.length - builtins), 'symbol-class'],
            ['Built-in models', String(builtins), 'library'],
            ['Indexed files', String(index.files.size), 'files'],
            ['Last scan', status.durationMs === undefined ? 'Not yet' : `${status.durationMs} ms`, 'watch'],
            ['Last update', status.lastUpdated === undefined ? 'Not yet' :
            new Date(status.lastUpdated).toLocaleTimeString(), 'history']
        ];

        return rows.map(([label, description, icon]) => {
            const item = new vscode.TreeItem(label);

            item.id = `overview:${label}`;
            item.description = description;
            item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor('icon.foreground'));
            if (label === 'Index' && status.error) item.tooltip = status.error;
            if (label === 'Last scan') {
                item.tooltip = 'Elapsed time for the last successful model index update';
            }
            if (label === 'Project models' && index.models.length === builtins) {
                item.tooltip = 'No project models found. Check additionalModelPaths for split model packages.';
            }

            return item;
        });
    }
}

function registerSidebar(context: vscode.ExtensionContext): void {
    const models = new ModelTreeProvider();

    context.subscriptions.push(models,
        vscode.window.registerTreeDataProvider('djangoModelNavigator.models', models),
        vscode.window.registerTreeDataProvider('djangoModelNavigator.overview', new OverviewTreeProvider()));
}

function registerCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('djangoModelNavigator.updateCache', async () => {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Window,
                    title: 'Django Model Navigator: rebuilding the model cache...'
                },
                () => store.refresh()
            );

            const total = store.current.models.length;

            vscode.window.setStatusBarMessage(
                `Django Model Navigator: ${total} model(s) in cache`,
                4000
            );
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'djangoModelNavigator.showReferences',
            (uri: vscode.Uri, position: vscode.Position, locations: vscode.Location[]) => {
                void vscode.commands.executeCommand(
                    'editor.action.showReferences',
                    uri,
                    position,
                    locations
                );
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('djangoModelNavigator.showLog', () => {
            logger.show();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('djangoModelNavigator.toggleDebug', async () => {
            const target = vscode.workspace.workspaceFolders
                ? vscode.ConfigurationTarget.Workspace
                : vscode.ConfigurationTarget.Global;

            const next = !config.debug;

            await vscode.workspace
                .getConfiguration('djangoModelNavigator')
                .update('debug', next, target);

            vscode.window.showInformationMessage(
                `Django Model Navigator: debug logging ${next ? 'enabled' : 'disabled'}`
            );
        })
    );
}

function registerWatchers(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(event => {
            if (functionDocuments.has(event.document.uri.toString())) clearFunctionDocuments();
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(document => {
            if (document.languageId !== 'python') return;

            clearFunctionDocuments();

            const fsPath = document.uri.fsPath;
            const reason = `save of ${path.basename(fsPath)}`;

            // Known files can be refreshed without another workspace search
            if (store.has(fsPath)) {
                store.schedule(reason, { files: [fsPath] });

                return;
            }

            // New files need a full search so VS Code applies the configured globs and
            // exclusions
            if (isWatchedModelFile(fsPath)) store.schedule(reason, { full: true });
        })
    );

    // Private helper snapshots also need changes made outside the editor
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.py', false, false, false);

    context.subscriptions.push(watcher);

    context.subscriptions.push(watcher.onDidChange(() => clearFunctionDocuments()));

    context.subscriptions.push(
        watcher.onDidCreate(uri => {
            store.invalidateSourcePaths();
            clearFunctionDocuments();
            if (isWatchedModelFile(uri.fsPath)) store.schedule('file creation', { full: true });
        })
    );

    context.subscriptions.push(
        watcher.onDidDelete(uri => {
            store.invalidateSourcePaths();
            clearFunctionDocuments();
            if (store.has(uri.fsPath)) {
                store.schedule('file deletion', { removals: [uri.fsPath] });
            }
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            store.invalidateSourcePaths();
            clearFunctionDocuments();
            store.schedule('workspace folders change', { full: true });
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(event => {
            if (!event.affectsConfiguration('djangoModelNavigator')) return;

            config = readConfig();
            logger.setDebug(config.debug);

            // Shown lenses stay until VS Code is told to request them again
            if (event.affectsConfiguration('djangoModelNavigator.enableCodeLens')) {
                codeLensChanged.fire();
            }

            if (RESCAN_KEYS.some(key => event.affectsConfiguration(key))) {
                store.invalidateSourcePaths();
                clearFunctionDocuments();
                store.schedule('configuration change', { full: true });
            }
        })
    );
}

/**
 * Decide whether a Python file event might affect the index
 * This is deliberately conservative; findFiles performs the actual glob filtering
 */
function isWatchedModelFile(fsPath: string): boolean {
    if (store.current.files.has(fsPath)) return true;

    const fileName = path.basename(fsPath);

    if (fileName === 'models.py') return true;
    if (fsPath.includes(`${path.sep}models${path.sep}`)) return true;

    return config.additionalModelPaths.some(pattern => pattern.trim()) && fileName.endsWith('.py');
}

/** Minimal source view shared by editor documents and private helper snapshots */
interface SourceDocument {
    readonly uri: vscode.Uri;
    readonly version: number;
    readonly isClosed: boolean;
    readonly lineCount: number;
    getText(): string;
    lineAt(line: number): { text: string };
}

interface HoverTiming {
    searchMs: number;
    readMs: number;
    parseMs: number;
    resolveMs: number;
    waitMs: number;
    modules: number;
    nativeReads: number;
    apiReads: number;
}
let activeHoverTiming: HoverTiming | undefined;

interface DocumentAnalysis {
    version: number;
    syntax: ReturnType<typeof analyzeSource>;
    bindings: Map<string, VariableBinding[]>;
}

// A document version owns its syntax; WeakMap does not keep obsolete editor documents alive
let documentAnalyses = new WeakMap<SourceDocument, DocumentAnalysis>();
const MAX_CACHED_POSITIONS = 64;

function documentAnalysis(document: SourceDocument): DocumentAnalysis {
    let cached = documentAnalyses.get(document);

    if (!cached || cached.version !== document.version) {
        const startedAt = activeHoverTiming ? Date.now() : 0;
        const text = document.getText();

        cached = { version: document.version, syntax: analyzeSource(text),
            bindings: new Map() };
        if (activeHoverTiming) activeHoverTiming.parseMs += Date.now() - startedAt;
        documentAnalyses.set(document, cached);
    }

    return cached;
}

function documentBindings(
    document: SourceDocument,
    firstLine: number,
    position: vscode.Position,
    variableName: string
): VariableBinding[] {
    const analysis = documentAnalysis(document);
    const key = `${firstLine}:${position.line}:${position.character}:${variableName}`;
    let bindings = analysis.bindings.get(key);

    if (!bindings) {
        bindings = collectVariableBindings(analysis.syntax, variableName, firstLine,
            position.line, position.character);
        if (analysis.bindings.size >= MAX_CACHED_POSITIONS) analysis.bindings.clear();
        analysis.bindings.set(key, bindings);
    }

    return bindings;
}

/** Helpers remain private source snapshots unless the user already has their document open */
const functionDocuments = new Map<string, SourceDocument>();
interface ImportedFunctionRequest {
    document: SourceDocument;
    entry: ParsedImport;
}
const functionLoads = new Map<string, Promise<void>>();
/** Helper URI each import request resolved to against the full path catalog */
const functionSources = new Map<string, string>();
let requestedFunctions: Map<string, ImportedFunctionRequest> | undefined;
let functionEpoch = 0;
const MAX_FUNCTION_MODULES = 32;

function clearFunctionDocuments(): void {
    functionEpoch++;
    functionDocuments.clear();
    functionLoads.clear();
    functionSources.clear();
    variableCache.epoch++;
}

function functionRequestKey(document: SourceDocument, entry: ParsedImport): string {
    return JSON.stringify([document.uri.toString(), entry.level, entry.module]);
}

/** Keep file I/O separate from the editor's Python document lifecycle */
function sourceSnapshot(uri: vscode.Uri, text: string): SourceDocument {
    const lines = text.split('\n');

    return { uri, version: 0, isClosed: false, lineCount: lines.length,
        getText: () => text,
        lineAt: line => ({ text: lines[line] ?? '' }) };
}

/** Schemes and authorities define separate file namespaces even when paths match */
function sameFileSystem(left: vscode.Uri, right: vscode.Uri): boolean {
    return left.scheme === right.scheme && left.authority === right.authority;
}

/** Local helpers avoid editor IPC; other schemes and remote hosts keep their provider */
async function readHelperBytes(
    uri: vscode.Uri,
    caller: vscode.Uri,
    timing?: HoverTiming
): Promise<Uint8Array> {
    if (uri.scheme === 'file' && caller.scheme === 'file' && !vscode.env.remoteName) {
        try {
            if (timing) timing.nativeReads++;

            return await readFile(uri.fsPath);
        } catch {
            logger.debug('Local helper read failed; retrying through the VS Code file provider');
        }
    }

    if (timing) timing.apiReads++;

    return vscode.workspace.fs.readFile(uri);
}

/** Resolve only imports encountered while tracing the requested expression */
function loadFunctionDocument(
    key: string,
    request: ImportedFunctionRequest,
    timing?: HoverTiming
): Promise<void> {
    const cached = functionLoads.get(key);
    if (cached) return cached;

    const epoch = functionEpoch;
    const { document, entry } = request;
    const task = (async () => {
        if (!entry.module) return;
        const modulePath = entry.module.split('.').join('/');

        try {
            let files = store.sourceFiles;
            if (!files) {
                const searchedAt = timing ? Date.now() : 0;
                const matches = await vscode.workspace.findFiles(
                    `**/{${modulePath}.py,${modulePath}/__init__.py}`,
                    buildExcludeGlob(config) ?? undefined
                );
                if (timing) timing.searchMs += Date.now() - searchedAt;
                files = matches;
            }
            if (epoch !== functionEpoch) return;
            files = files.filter(uri => sameFileSystem(uri, document.uri));
            const targetPath = resolveImportFile(entry, document.uri.fsPath,
                files.map(uri => uri.fsPath));
            if (!targetPath) return;
            const uri = files.find(candidate => candidate.fsPath === targetPath);
            if (!uri) return;
            if (functionDocuments.has(uri.toString())) {
                functionSources.set(key, uri.toString());

                return;
            }
            let target: SourceDocument | undefined = openSourceDocument(uri);
            if (!target) {
                // Reading a helper must not emit didOpen and trigger other language services
                const readAt = timing ? Date.now() : 0;
                const text = Buffer.from(await readHelperBytes(uri, document.uri, timing)).toString('utf8');
                if (timing) timing.readMs += Date.now() - readAt;
                // The user may open and edit the helper while its disk read is pending
                target = openSourceDocument(uri) ?? sourceSnapshot(uri, text);
            }
            if (epoch !== functionEpoch) return;
            functionDocuments.set(uri.toString(), target);
            functionSources.set(key, uri.toString());
            if (timing) timing.modules++;
        } catch {
            logger.debug(`Could not inspect imported helper module: ${entry.module}`);
        }
    })().then(() => {
        if (epoch === functionEpoch) variableCache.epoch++;
    });

    // Retain failed lookups too, until a workspace change invalidates helper documents
    functionLoads.set(key, task);

    return task;
}

function withFunctionDocuments<T>(
    document: vscode.TextDocument,
    provide: () => T,
    timing?: HoverTiming
): T | Promise<T | undefined> {
    if ([...functionDocuments.values()].some(source => source.isClosed)) clearFunctionDocuments();
    const version = document.version;
    const epoch = functionEpoch;
    const attempted = new Set<string>();
    const capture = () => {
        const previous = requestedFunctions;
        const previousTiming = activeHoverTiming;
        const startedAt = timing ? Date.now() : 0;
        const parsedBefore = timing?.parseMs ?? 0;
        const requests = new Map<string, ImportedFunctionRequest>();

        // Collection is synchronous and scoped to one provider evaluation
        requestedFunctions = requests;
        activeHoverTiming = timing;
        try {
            return { result: provide(), requests };
        } finally {
            requestedFunctions = previous;
            activeHoverTiming = previousTiming;
            if (timing) {timing.resolveMs += Math.max(0,
                Date.now() - startedAt - (timing.parseMs - parsedBefore));}
        }
    };
    const initial = capture();
    if (initial.requests.size === 0) return initial.result;

    return (async () => {
        let current = initial;

        while (current.requests.size > 0) {
            const pending = [...current.requests].filter(([key]) => !attempted.has(key))
                .slice(0, MAX_FUNCTION_MODULES - attempted.size);
            if (pending.length === 0) return current.result;
            for (const [key, request] of pending) {
                attempted.add(key);
                const startedAt = timing ? Date.now() : 0;
                const ioBefore = timing ? timing.searchMs + timing.readMs : 0;
                await loadFunctionDocument(key, request, timing);
                if (timing) {timing.waitMs += Math.max(0,
                    Date.now() - startedAt - (timing.searchMs + timing.readMs - ioBefore));}
                if (document.version !== version || document.isClosed || epoch !== functionEpoch) {
                    return undefined;
                }
            }
            current = capture();
        }

        return current.result;
    })();
}

/**
 * Register providers once and check feature settings on each call
 * Configuration changes then take effect without reloading the window
 */
function registerProviders(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.languages.registerDefinitionProvider('python', {
            provideDefinition(document, position) {
                if (!config.enableDefinition) return undefined;

                return withFunctionDocuments(document, () =>
                    provideDefinition(document, position));
            }
        })
    );

    context.subscriptions.push(
        vscode.languages.registerHoverProvider('python', {
            provideHover(document, position) {
                if (!config.enableHover) return null;

                const startedAt = logger.isDebugEnabled ? Date.now() : undefined;
                const timing: HoverTiming | undefined = startedAt === undefined ? undefined : {
                    searchMs: 0, readMs: 0, parseMs: 0, resolveMs: 0, waitMs: 0, modules: 0,
                    nativeReads: 0, apiReads: 0
                };
                const result = withFunctionDocuments(document, () =>
                    provideHover(document, position), timing);
                if (startedAt === undefined) return result;

                const report = (hover: vscode.Hover | null | undefined) => {
                    if (hover !== undefined) {
                        logger.debug(`Hover ready in ${Date.now() - startedAt} ms`);
                        if (timing) {logger.debug(`Hover stages: search=${timing.searchMs} ms ` +
                            `read=${timing.readMs} ms parse=${timing.parseMs} ms ` +
                            `resolve=${timing.resolveMs} ms wait=${timing.waitMs} ms ` +
                            `modules=${timing.modules} nativeReads=${timing.nativeReads} ` +
                                `apiReads=${timing.apiReads}`);}
                    }

                    return hover;
                };

                return result instanceof Promise ? result.then(report) : report(result);
            }
        })
    );

    context.subscriptions.push(
        vscode.languages.registerReferenceProvider('python', {
            provideReferences(document, position, context) {
                if (!config.enableReferences) return undefined;

                return withFunctionDocuments(document, () =>
                    provideReferences(document, position, context.includeDeclaration));
            }
        })
    );

    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider('python', {
            onDidChangeCodeLenses: codeLensChanged.event,

            provideCodeLenses(document) {
                if (!config.enableCodeLens) return [];

                return provideCodeLenses(document);
            }
        })
    );

    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            'python',
            {
                provideCompletionItems(document, position) {
                    if (!config.enableCompletion) return undefined;

                    return withFunctionDocuments(document, () =>
                        provideCompletions(document, position));
                }
            },
            '.',
            '_',
            '"',
            "'"
        )
    );
}

// Workspace scanning

/** Parse one file, returning null when reading or parsing fails */
async function parseOneFile(
    fsPath: string,
    current: NavigatorConfig
): Promise<{ path: string; file: ParsedFile | null }> {
    const content = await readFileContent(fsPath);

    if (content === null) return { path: fsPath, file: null };

    try {
        const parsed = parseModule(fsPath, content, {
            additionalFieldTypes: current.additionalFieldTypes
        });

        return {
            path: fsPath,
            file: { filePath: fsPath, classes: parsed.classes, imports: parsed.imports }
        };
    } catch (error) {
        logger.error(`❌ Failed to parse ${fsPath}:`, error);

        return { path: fsPath, file: null };
    }
}

/** Cache only filenames; helper contents are still read solely on demand */
async function collectSourcePaths(current: NavigatorConfig): Promise<vscode.Uri[] | undefined> {
    try {
        const files = await vscode.workspace.findFiles('**/*.py',
            buildExcludeGlob(current) ?? undefined);

        return files;
    } catch {
        logger.debug('Could not cache Python source paths; imports will use on-demand search');

        return undefined;
    }
}

/** Find and parse model files using the current search and exclusion settings */
async function collectParsedFiles(current: NavigatorConfig): Promise<ParsedFile[]> {
    const patterns = buildSearchPatterns(current);
    const exclude = buildExcludeGlob(current);

    const paths = new Set<string>();

    for (const pattern of patterns) {
        try {
            const uris = await vscode.workspace.findFiles(pattern, exclude ?? undefined);

            uris.forEach(uri => paths.add(uri.fsPath));
        } catch (error) {
            logger.error(`❌ Invalid search pattern "${pattern}":`, error);
        }
    }

    logger.debug(`🔍 Model files found: ${paths.size}`);

    const parsed = await Promise.all(
        [...paths].map(fsPath => parseOneFile(fsPath, current))
    );

    return parsed
        .map(item => item.file)
        .filter((file): file is ParsedFile => file !== null);
}

function openSourceDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find(document =>
        document.uri.toString() === uri.toString() && !document.isClosed);
}

/** Prefer open document text to disk contents so scans can include unsaved edits */
async function readFileContent(fsPath: string): Promise<string | null> {
    const open = openSourceDocument(vscode.Uri.file(fsPath));

    if (open) return open.getText();

    try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(fsPath));

        return Buffer.from(bytes).toString('utf8');
    } catch (error) {
        logger.error(`⚠️ Couldn't read the file ${fsPath}:`, error);

        return null;
    }
}

// Expression and document context

/** Dotted expression around the cursor */
interface ChainContext {
    /** For employee.profile.email, contains ["employee", "profile", "email"] */
    parts: string[];

    /** Zero-based segment under the cursor; client. selects the empty segment at index 1 */
    index: number;
}

/** Read lines lazily because providers run on interactive editor requests */
function lineReader(document: vscode.TextDocument): LineAt {
    return (line: number) =>
        line >= 0 && line < document.lineCount ? document.lineAt(line).text : '';
}

/** Treat generic Python calls as ordinary symbols, not failed ORM lookups */
function documentLookupContext(
    document: vscode.TextDocument,
    position: vscode.Position
): LookupContext | null {
    const lookup = getLookupContext(lineReader(document), position.line, position.character);

    return lookup?.calls.some(call => LOOKUP_METHODS.has(call.callee)) ? lookup : null;
}

function isIdentifierChar(char: string | undefined): boolean {
    return !!char && /[A-Za-z0-9_]/.test(char);
}

/** Read the dotted identifier surrounding the cursor on the current line */
function getChainContext(
    document: vscode.TextDocument,
    position: vscode.Position
): ChainContext | null {
    const lineText = document.lineAt(position.line).text;

    let start = position.character;

    while (start > 0 && (isIdentifierChar(lineText[start - 1]) || lineText[start - 1] === '.')) {
        start--;
    }

    let end = position.character;

    while (end < lineText.length && (isIdentifierChar(lineText[end]) || lineText[end] === '.')) {
        end++;
    }

    const raw = lineText.slice(start, end);
    if (!raw || raw === '.') return null;

    const prefix = lineText.slice(start, position.character);

    return {
        parts: raw.split('.'),
        index: (prefix.match(/\./g) ?? []).length
    };
}

/** Find a preceding top-level model declaration for self or cls resolution */
function findEnclosingModel(
    document: SourceDocument,
    position: vscode.Position
): ModelInfo | null {
    for (let line = position.line; line >= 0; line--) {
        const match = document.lineAt(line).text.match(/^class\s+(\w+)\s*[(:]/);

        if (match) return findModelForDocument(document, match[1]);
    }

    return null;
}

function documentImports(document: SourceDocument): ParsedImport[] {
    return documentAnalysis(document).syntax.imports;
}

/** Use the document path and inferred app to disambiguate model names */
function documentContext(document: SourceDocument): {
    filePath: string;
    appName: string;
} {
    return {
        filePath: document.uri.fsPath,
        appName: appNameFromPath(document.uri.fsPath)
    };
}

/** Resolve a model using the document's explicit imports before the index fallback */
function findModelForDocument(
    document: SourceDocument,
    name: string
): ModelInfo | null {
    const imported = documentImports(document).find(entry => entry.local === name);

    if (imported) {
        const target = resolveImportedModel(store.current, imported, document.uri.fsPath);

        if (target) return target;

        return isBuiltinModelImport(imported.module, imported.original)
            ? findModelByName(store.current, imported.original, documentContext(document)) : null;
    }

    return findModelByName(store.current, name, documentContext(document));
}

/** Keep model results per document so helper lookups cannot evict the caller's cache */
const variableCache = {
    epoch: 0,
    documents: new WeakMap<SourceDocument, {
        version: number;
        epoch: number;
        entries: Map<string, string | null | undefined>;
    }>()
};

function variableCacheFor(document: SourceDocument): Map<string, string | null | undefined> {
    let cached = variableCache.documents.get(document);

    if (!cached || cached.version !== document.version || cached.epoch !== variableCache.epoch) {
        cached = { version: document.version, epoch: variableCache.epoch, entries: new Map() };
        variableCache.documents.set(document, cached);
    }

    return cached.entries;
}

/** Recursive assignment resolution state */
interface ResolveContext {
    depth: number;

    /** Search nested names before the binding whose right-hand side is being evaluated */
    before?: number;
    scopeStartLine?: number;
    callDepth?: number;
    /** Lazily resolve argument types in the caller's original source context */
    parameters?: Map<string, () => ModelInfo | null>;
    /**
     * Resolve the model behind a queryset regardless of its result shape: lookups in
     * values().filter(...) still name model fields, while its rows are not instances
     */
    queryset?: boolean;
}

/** Resolve a model name inside annotations such as QuerySet[Employee] or Optional[Employee] */
function resolveAnnotationModel(
    document: SourceDocument,
    annotation: string
): ModelInfo | null {
    return resolveModelAnnotation(annotation, name => findModelForDocument(document, name));
}

/**
 * Resolve an expression's model through assignments, wrappers and relation fields
 * Trailing queryset operations do not change the inferred model
 */
function resolveExpressionModel(
    document: SourceDocument,
    position: vscode.Position,
    expression: string,
    context: ResolveContext,
    tupleIndex?: number
): ModelInfo | null {
    if (context.depth > MAX_VARIABLE_DEPTH) return null;

    const text = expression.replace(/^\s*await\s+/, '');
    const chain = readChainForward(text);

    if (chain.length === 0) return null;

    if (chain.length === 1 && MODEL_SOURCE_CALLS.has(chain[0])) {
        const args = readCallArguments(text);
        const first = args ? splitTopLevelArgs(args)[0] : undefined;

        return first ? resolveExpressionModel(document, position, first, context) : null;
    }

    const argumentsText = chain.length === 1 ? readCallArguments(text) : null;
    if (argumentsText !== null) {
        const returned = resolveCalledFunction(document, position, chain[0],
            argumentsText, context, tupleIndex);

        if (returned !== undefined) return returned;
    }

    const parts = context.queryset ? stripQuerysetTokens(chain)
        : modelResultChain(chain, tupleIndex ?? tupleSubscript(text));
    if (!parts?.length) return null;

    // Only a bare queryset variable keeps the queryset view; a relation needs an instance
    const variable = resolveVariableModel(document, position, parts[0],
        { ...context, queryset: context.queryset && parts.length === 1 });
    const root = variable === undefined ? findModelForDocument(document, parts[0]) : variable;

    if (!root) return null;

    return resolveFieldChain(store.current, root, parts.slice(1));
}

/** Resolve an explicitly declared function; undefined means no declaration was found */
function resolveCalledFunction(
    document: SourceDocument,
    position: vscode.Position,
    name: string,
    argumentsText: string,
    context: ResolveContext,
    tupleIndex?: number
): ModelInfo | null | undefined {
    if ((context.callDepth ?? 0) >= MAX_VARIABLE_DEPTH) return null;

    let source = document;
    let original = name;
    const imported = documentImports(document).find(entry => entry.local === name);

    if (imported) {
        // Reuse the catalog resolution; loaded helpers alone cannot prove a module is unique
        const resolved = functionSources.get(functionRequestKey(document, imported));
        const targetDocument = resolved ? functionDocuments.get(resolved) : undefined;
        if (!targetDocument) {
            // An explicit import resolves to a model only for its own source or a Django import
            if (findModelForDocument(document, name)) return undefined;

            requestedFunctions?.set(functionRequestKey(document, imported),
                { document, entry: imported });

            return null;
        }

        source = targetDocument;
        original = imported.original;
    }

    const declarations = documentAnalysis(source).syntax.functions
        .filter(fn => fn.name === original);
    if (declarations.length === 0) return undefined;
    if (declarations.length !== 1) return null;

    const fn = declarations[0];
    const parameters = new Map<string, () => ModelInfo | null>(
        fn.parameters.filter(Boolean).map(name => [name, () => null])
    );

    for (const [parameter, argument] of bindFunctionArguments(fn.parameters, argumentsText)) {
        parameters.set(parameter, () => resolveExpressionModel(document, position,
            argument, { ...context, depth: context.depth + 1 }));
    }

    return resolveFunctionResult(fn, tupleIndex,
        (value, returned) => resolveExpressionModel(source,
            new vscode.Position(returned.line, returned.column), value,
            { depth: 0, callDepth: (context.callDepth ?? 0) + 1,
                scopeStartLine: fn.bodyLine, parameters }),
        annotation => resolveAnnotationModel(source, annotation));
}

/**
 * Follow bindings above the cursor within bounded lookback and recursion limits
 * Nested lookups retain the evaluation time of the right-hand side
 */
function resolveVariableModel(
    document: SourceDocument,
    position: vscode.Position,
    variableName: string,
    context: ResolveContext = { depth: 0 }
): ModelInfo | null | undefined {
    if (context.depth > MAX_VARIABLE_DEPTH) return null;

    const limit = context.before;

    // A nested result depends on its binding cutoff and must not enter the top-level cache
    const cacheable = limit === undefined && !context.parameters;
    const cache = variableCacheFor(document);
    const cacheKey = `${position.line}:${position.character}:${variableName}` +
        (context.queryset ? ':queryset' : '');

    if (cacheable && cache.has(cacheKey)) {
        const cached = cache.get(cacheKey);

        if (cached === undefined) return undefined;

        return cached ? store.current.byKey.get(cached) ?? null : null;
    }

    // Limit the lookback window and exclude assignments below the cursor
    const firstLine = Math.max(context.scopeStartLine ?? 0,
        position.line - MAX_VARIABLE_LOOKBACK_LINES);

    const bindings = documentBindings(document, firstLine, position, variableName);
    let binding = bindings.find(item => limit === undefined || item.index < limit);
    const hadBinding = !!binding;

    // Queryset-preserving self assignments do not consume recursion depth
    while (binding?.kind === 'expression' && binding.tupleIndex === undefined) {
        const chain = readChainForward(binding.text);
        const previousRoot = context.queryset ? stripQuerysetTokens(chain)
            : modelResultChain(chain);
        if (previousRoot?.length !== 1 || previousRoot[0] !== variableName) break;

        const before = binding.index;

        binding = bindings.find(item => item.index < before);
    }

    // Keep the binding cutoff for every nested name, not just the variable being resolved
    const nested: ResolveContext = {
        ...context,
        depth: context.depth + 1,
        before: binding ? binding.index : 0
    };

    const parameter = context.parameters?.get(variableName);
    const result = !binding
        ? parameter ? parameter() : hadBinding ? null : undefined
        : binding.kind === 'parameter'
            ? parameter ? parameter() : resolveAnnotationModel(document, binding.text)
            : binding.kind === 'annotation'
                ? resolveAnnotationModel(document, binding.text)
                : resolveExpressionModel(document, position, binding.text, nested,
                    binding.tupleIndex);

    if (cacheable && !requestedFunctions?.size) cache.set(cacheKey, result ? result.key : result);

    return result;
}

/** Resolve self, cls, a variable binding or a model name at the expression root */
function resolveRoot(
    document: SourceDocument,
    position: vscode.Position,
    root: string,
    queryset = false
): ModelInfo | null {
    if (!root) return null;

    if (root === 'self' || root === 'cls') {
        return findEnclosingModel(document, position);
    }

    // Bindings take precedence over case-insensitive model-name matches
    const variable = resolveVariableModel(document, position, root, { depth: 0, queryset });

    if (variable !== undefined) return variable;

    return findModelForDocument(document, root);
}

/**
 * Resolve the owner of the next field in a dotted chain
 * For ["employee", "profile"], return the related Profile model
 */
function resolveChainModel(
    document: SourceDocument,
    position: vscode.Position,
    parts: string[],
    queryset = false
): ModelInfo | null {
    if (parts.length === 0) return null;

    const root = resolveRoot(document, position, parts[0], queryset && parts.length === 1);
    if (!root) return null;

    return resolveFieldChain(store.current, root, parts.slice(1));
}

/**
 * Resolve the receiver model for a lookup call
 * Nested Q expressions use the surrounding queryset call as context
 */
function resolveLookupRoot(
    document: vscode.TextDocument,
    position: vscode.Position,
    lookup: LookupContext
): ModelInfo | null {
    for (const call of lookup.calls) {
        if (!LOOKUP_METHODS.has(call.callee) || call.receiver.length === 0 ||
            CONTEXT_EXPRESSIONS.has(call.callee)) continue;

        const chain = stripQuerysetTokens([...call.receiver, call.callee]);
        if (chain.length === 0) continue;

        return resolveChainModel(document, position, chain, true);
    }

    return null;
}

function resolveLookupField(
    document: vscode.TextDocument,
    position: vscode.Position,
    lookup: LookupContext
): { model: ModelInfo; field: ModelField } | null {
    const root = resolveLookupRoot(document, position, lookup);
    if (!root) return null;

    const steps = walkLookupPath(store.current, root, lookup.segments,
        usesAccessorNames(lookup));
    const step = steps[lookup.index];

    if (!step || !step.field || !step.model) return null;

    return { model: step.model, field: step.field };
}

// Go to Definition

/** Return the model declaration location, or null for a built-in without source */
function modelLocation(model: ModelInfo): vscode.Location | null {
    if (model.isBuiltin) return null;

    return new vscode.Location(
        vscode.Uri.file(model.filePath),
        new vscode.Range(
            model.line,
            model.column,
            model.line,
            model.column + model.name.length
        )
    );
}

/** Return the original field declaration location when source coordinates are available */
function fieldLocation(field: ModelField): vscode.Location | null {
    if (!field.sourceFilePath || field.sourceLine === undefined) return null;

    const column = field.sourceColumn ?? 0;

    return new vscode.Location(
        vscode.Uri.file(field.sourceFilePath),
        new vscode.Range(
            field.sourceLine,
            column,
            field.sourceLine,
            column + field.name.length
        )
    );
}

/** Add field locations; reverse relations also link to the related model declaration */
function collectFieldTargets(
    locations: vscode.Location[],
    owner: ModelInfo,
    field: ModelField
): void {
    const location = fieldLocation(field);

    if (location) locations.push(location);

    if (field.isReverse && field.relatedModel) {
        const related = resolveRelatedModel(store.current, field);
        const relatedLocation = related ? modelLocation(related) : null;

        if (relatedLocation) locations.push(relatedLocation);
    }
}

/** Provide definition locations for model names, dotted fields and lookup segments */
function provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position
): vscode.Location | vscode.Location[] | undefined {
    const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
    if (!wordRange) return undefined;

    const word = document.getText(wordRange);

    const lookup = documentLookupContext(document, position);

    if (lookup) {
        const resolved = resolveLookupField(document, position, lookup);

        if (resolved) {
            const targets: vscode.Location[] = [];

            collectFieldTargets(targets, resolved.model, resolved.field);

            const unique = dedupeLocations(targets);

            if (unique.length === 1) return unique[0];
            if (unique.length > 1) return unique;
        }

        return undefined;
    }

    const chain = getChainContext(document, position);
    if (!chain) return undefined;

    const isAttribute = chain.index > 0;

    // An imported alias may not appear among the index's class names
    if (!isAttribute && !resolveRoot(document, position, word)) return undefined;

    const locations: vscode.Location[] = [];

    if (isAttribute) {
        const owner = resolveChainModel(document, position, chain.parts.slice(0, chain.index));

        if (owner) {
            const field = findModelField(owner, word);

            if (field) collectFieldTargets(locations, owner, field);
        }

        const unique = dedupeLocations(locations).slice(0, config.maxDefinitionResults);

        return unique.length === 1 ? unique[0] : unique.length > 1 ? unique : undefined;
    }

    const model = resolveRoot(document, position, word);
    const location = model ? modelLocation(model) : null;
    if (location) locations.push(location);

    const unique = dedupeLocations(locations).slice(0, config.maxDefinitionResults);

    if (unique.length === 0) return undefined;
    if (unique.length === 1) return unique[0];

    return unique;
}

function dedupeLocations(locations: vscode.Location[]): vscode.Location[] {
    const seen = new Set<string>();
    const result: vscode.Location[] = [];

    for (const location of locations) {
        const key = `${location.uri.fsPath}:${location.range.start.line}:${location.range.start.character}`;

        if (seen.has(key)) continue;

        seen.add(key);
        result.push(location);
    }

    return result;
}

/** Convert indexed usages to unique source locations */
function usageLocations(usages: ModelUsage[]): vscode.Location[] {
    const locations: vscode.Location[] = [];

    for (const usage of usages) {
        if (usage.kind === 'inheritance') {
            const location = modelLocation(usage.model);

            if (location) locations.push(location);

            continue;
        }

        if (!usage.field) continue;

        const location = fieldLocation(usage.field);

        if (location) locations.push(location);
    }

    return dedupeLocations(locations);
}

function modelUsageLocations(model: ModelInfo): vscode.Location[] {
    return usageLocations(collectModelUsages(store.current, model));
}

/**
 * Find references recorded in the model index: relation declarations and inheritance
 * Ordinary Python attribute usages remain the responsibility of the language server
 */
function provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    includeDeclaration: boolean
): vscode.Location[] | undefined {
    const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
    if (!wordRange) return undefined;

    const word = document.getText(wordRange);
    const index = store.current;

    const locations: vscode.Location[] = [];

    const chain = getChainContext(document, position);
    const isField = !!documentLookupContext(document, position) ||
        (chain?.index ?? 0) > 0;
    const model = isField ? null : resolveRoot(document, position, word);

    if (model) {
        const declaration = includeDeclaration ? modelLocation(model) : null;

        if (declaration) locations.push(declaration);

        locations.push(...modelUsageLocations(model));

        return dedupeLocations(locations);
    }

    const resolved = resolveFieldAtPosition(document, position, word);

    if (!resolved) return undefined;

    if (includeDeclaration) {
        const declaration = fieldLocation(resolved.field);

        if (declaration) locations.push(declaration);
    }

    const related = resolveRelatedModel(index, resolved.field);

    if (related) {
        const declaration = modelLocation(related);

        if (declaration) locations.push(declaration);

        locations.push(...modelUsageLocations(related));
    }

    return locations.length > 0 ? dedupeLocations(locations) : undefined;
}

/** Resolve a field under the cursor in either a dotted chain or a lookup path */
function resolveFieldAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position,
    word: string
): { model: ModelInfo; field: ModelField } | null {
    const lookup = documentLookupContext(document, position);

    if (lookup) {
        const resolved = resolveLookupField(document, position, lookup);

        if (resolved) return resolved;
    }

    const chain = getChainContext(document, position);

    if (chain && chain.index > 0) {
        const owner = resolveChainModel(document, position, chain.parts.slice(0, chain.index));

        if (owner) {
            const field = findModelField(owner, word);

            if (field) return { model: owner, field };
        }
    }

    return null;
}

/**
 * Show field, reverse-relation and usage counts above each model
 * The command opens the indexed usage locations
 */
function provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const models = store.current.models.filter(
        model => model.filePath === document.uri.fsPath
    );

    if (models.length === 0) return [];

    // Collect usages once for all models in this document
    const usagesByModel = collectAllModelUsages(store.current);

    const lenses: vscode.CodeLens[] = [];

    for (const model of models) {
        const reverse = model.fields.filter(field => field.isReverse).length;
        const usages = usageLocations(usagesByModel.get(model.key) ?? []);

        const parts = [
            `${model.fields.length} field(s)`,
            reverse > 0 ? `${reverse} reverse` : '',
            `${usages.length} usage(s)`
        ].filter(Boolean);

        const range = new vscode.Range(
            model.line,
            model.column,
            model.line,
            model.column + model.name.length
        );

        const lens = new vscode.CodeLens(range, {
            title: parts.join(' · '),
            command: usages.length > 0 ? 'djangoModelNavigator.showReferences' : '',
            arguments: [document.uri, range.start, usages]
        });

        lenses.push(lens);
    }

    return lenses;
}

// Hover

function sourceLink(filePath: string, line: number): string {
    const uri = vscode.Uri.file(filePath).with({ fragment: `L${line + 1}` });

    return `[${path.basename(filePath)}:${line + 1}](${uri.toString()})`;
}

function describeFieldType(field: ModelField): string {
    if (field.relatedModel) return `${field.type}('${field.relatedModel}')`;

    return `${field.type}()`;
}

/** Render a model's fields with source information and abstract/proxy badges */
function renderModel(model: ModelInfo): vscode.MarkdownString {
    const md = new vscode.MarkdownString();

    const badges = [
        model.isAbstract ? '`abstract`' : '',
        model.isProxy ? '`proxy`' : ''
    ].filter(Boolean);

    const source = model.isBuiltin
        ? '_built-in Django model_'
        : sourceLink(model.filePath, model.line);

    md.appendMarkdown(
        `**Model** \`${model.fullName}\`${badges.length ? ' ' + badges.join(' ') : ''}  \n` +
        `${source}\n\n`
    );

    const shown = model.fields.slice(0, Math.max(1, config.hoverMaxFields));

    const body = shown
        .map(field => `    ${field.name} = ${describeFieldType(field)}`)
        .join('\n');

    md.appendMarkdown(
        '```python\n' +
        `class ${model.name}(models.Model):\n` +
        (body || '    pass') +
        '\n```'
    );

    const hidden = model.fields.length - shown.length;

    if (hidden > 0) md.appendMarkdown(`\n\n_…and ${hidden} more field(s)_`);

    return md;
}

/** Render a field's origin, relation metadata and related model when available */
function renderField(owner: ModelInfo, field: ModelField): vscode.MarkdownString {
    const md = new vscode.MarkdownString();

    md.appendMarkdown(`**${owner.name}.${field.name}** — \`${describeFieldType(field)}\`\n\n`);

    const notes: string[] = [];

    if (field.isReverse && field.reverseOf) {
        notes.push(`Reverse relation of \`${field.reverseOf}\``);
    }

    if (!field.isReverse && field.relatedName) {
        notes.push(`related_name: \`${field.relatedName}\``);
    }

    if (field.isInherited && field.declaredIn) {
        notes.push(`Inherited from \`${field.declaredIn}\``);
    }

    if (field.sourceFilePath && field.sourceLine !== undefined) {
        notes.push(sourceLink(field.sourceFilePath, field.sourceLine));
    }

    if (notes.length) md.appendMarkdown(notes.join('  \n') + '\n\n');

    if (field.relatedModel) {
        const related = resolveRelatedModel(store.current, field);

        if (related) md.appendMarkdown(renderModel(related).value);
    }

    return md;
}

/** Provide hover content for a lookup segment, dotted field, variable or model name */
function provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
): vscode.Hover | null {
    const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
    if (!wordRange) return null;

    const word = document.getText(wordRange);

    const lookup = documentLookupContext(document, position);

    if (lookup) {
        const resolved = resolveLookupField(document, position, lookup);

        if (resolved) {
            return new vscode.Hover(
                renderField(resolved.model, resolved.field),
                new vscode.Range(
                    position.line,
                    lookup.segmentStart,
                    position.line,
                    lookup.segmentStart + resolved.field.name.length
                )
            );
        }
    }

    if (lookup) return null;

    const chain = getChainContext(document, position);
    if (!chain) return null;

    if (chain.index > 0) {
        const owner = resolveChainModel(document, position, chain.parts.slice(0, chain.index));
        const field = owner ? findModelField(owner, word) : undefined;

        return owner && field ? new vscode.Hover(renderField(owner, field), wordRange) : null;
    }

    const root = resolveRoot(document, position, word);
    if (root) return new vscode.Hover(renderModel(root), wordRange);

    return null;
}

// Completion

/** Build a field completion item with type, origin and optional replacement range */
function createFieldItem(
    model: ModelInfo,
    field: ModelField,
    range?: vscode.Range,
    label = field.name
): vscode.CompletionItem {
    const item = new vscode.CompletionItem(
        label,
        field.relatedModel
            ? vscode.CompletionItemKind.Reference
            : vscode.CompletionItemKind.Field
    );

    item.detail = describeFieldType(field);

    // Sort own fields before inherited fields, then reverse relations
    const group = field.isReverse ? '2' : field.isInherited ? '1' : '0';

    item.sortText = `${group}${label}`;

    if (range) item.range = range;

    const documentation = new vscode.MarkdownString();

    documentation.appendMarkdown(`\`${model.name}.${field.name}\`\n\n`);

    if (field.isReverse && field.reverseOf) {
        documentation.appendMarkdown(`Reverse relation of \`${field.reverseOf}\`\n\n`);
    }

    if (field.isInherited && field.declaredIn) {
        documentation.appendMarkdown(`Inherited from \`${field.declaredIn}\`\n\n`);
    }

    item.documentation = documentation;

    return item;
}

function createLookupItem(name: string, range: vscode.Range): vscode.CompletionItem {
    const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Operator);

    item.detail = 'lookup';
    item.sortText = `3${name}`;
    item.range = range;

    return item;
}

/**
 * Complete the current lookup segment, replacing only the typed prefix
 * Relation fields also offer the supported relation lookups
 */
function provideLookupCompletions(
    document: vscode.TextDocument,
    position: vscode.Position,
    lookup: LookupContext
): vscode.CompletionItem[] | undefined {
    const root = resolveLookupRoot(document, position, lookup);
    if (!root) return undefined;

    const byAccessor = usesAccessorNames(lookup);
    const { model, lastField } = resolveLookupPrefix(
        store.current,
        root,
        lookup.segments.slice(0, lookup.index),
        byAccessor
    );

    const range = new vscode.Range(
        position.line,
        lookup.segmentStart,
        position.line,
        position.character
    );

    const items: vscode.CompletionItem[] = [];

    if (model) {
        items.push(...model.fields.map(field => createFieldItem(model, field, range,
            byAccessor ? field.name : lookupFieldName(field))));
    }

    // Relations accept fewer lookup operators than scalar fields
    if (lastField) {
        const lookups = lastField.relatedModel ? RELATION_LOOKUPS : DJANGO_LOOKUPS;

        items.push(...lookups.map(name => createLookupItem(name, range)));
    } else if (model && lookup.index > 0) {
        items.push(...RELATION_LOOKUPS.map(name => createLookupItem(name, range)));
    }

    return items.length > 0 ? items : undefined;
}

/** Complete fields after a dot; VS Code filters the items against the typed prefix */
function provideCompletions(
    document: vscode.TextDocument,
    position: vscode.Position
): vscode.CompletionItem[] | undefined {
    const lookup = documentLookupContext(document, position);

    if (lookup) {
        const items = provideLookupCompletions(document, position, lookup);

        if (items) return items;
    }

    const chain = getChainContext(document, position);

    // Leave expression-root completion to the Python language provider
    if (!chain || chain.index === 0) return undefined;

    const model = resolveChainModel(document, position, chain.parts.slice(0, chain.index));
    if (!model) return undefined;

    return model.fields.map(field => createFieldItem(model, field));
}

/** Dispose the store and logger and release document caches */
export function deactivate(): void {
    store.dispose();
    variableCache.documents = new WeakMap();
    documentAnalyses = new WeakMap();
    logger.dispose();
}
