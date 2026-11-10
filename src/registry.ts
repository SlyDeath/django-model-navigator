/**
 * Build a model index from parsed files without depending on VS Code
 * Resolves inheritance, relation targets, reverse accessors and lookup paths
 */

import * as path from 'path';

import { builtinClasses, isBuiltinModelImport } from './builtins';
import { FunctionReturn, ParsedClass, ParsedFunction, ParsedImport, modelAnnotationNames, splitTopLevelArgs } from './parser';
import {
    AUTH_USER_MODEL_REF,
    DJANGO_LOOKUP_SET,
    DJANGO_MODEL_BASES,
    ModelField,
    ModelIndex,
    ModelInfo,
    NON_MODEL_BASES,
    RELATION_FIELD_TYPES,
    SELF_MODEL_REF,
    createEmptyIndex
} from './types';

/** Parsed declarations and imports from one indexed source file */
export interface ParsedFile {
    filePath: string;
    classes: ParsedClass[];

    /** Import bindings used to disambiguate names in this file */
    imports?: ParsedImport[];
}

/** Imported symbol with an optional resolved source file */
interface ResolvedImport {
    original: string;
    filePath?: string;
    entry: ParsedImport;
}

export interface RegistryOptions {
    /** Override for settings.AUTH_USER_MODEL; empty means automatic inference */
    userModel?: string;

    /** Include built-in Django model descriptions unless explicitly disabled */
    includeBuiltins?: boolean;
}

interface ClassEntry {
    parsed: ParsedClass;
    key: string;
    appName: string;
    fullName: string;
}

/**
 * Infer an app name from a file path
 * app/models.py and app/models/user.py both identify app; AppConfig is not evaluated
 */
export function appNameFromPath(filePath: string): string {
    const dir = path.dirname(filePath);
    const base = path.basename(dir);

    if (base === 'models') {
        const parent = path.basename(path.dirname(dir));

        return parent || base;
    }

    return base || 'project';
}

/**
 * Resolve a from-import against indexed file paths
 * Relative imports use the current directory; absolute imports require a unique suffix match
 * Return undefined for missing or ambiguous sources
 */
export function resolveImportFile(
    entry: ParsedImport,
    currentFile: string,
    knownFiles: string[]
): string | undefined {
    const parts = entry.module.split('.').filter(Boolean);

    if (entry.level > 0) {
        let base = path.dirname(currentFile);

        for (let i = 1; i < entry.level; i++) base = path.dirname(base);

        // A bare relative module import does not identify a class source here
        if (parts.length === 0) return undefined;

        const candidates = [
            path.join(base, ...parts) + '.py',
            path.join(base, ...parts, '__init__.py')
        ];

        return candidates.find(candidate => knownFiles.includes(candidate));
    }

    if (parts.length === 0) return undefined;

    const suffixes = [
        path.join(...parts) + '.py',
        path.join(...parts, '__init__.py')
    ];

    const matches = knownFiles.filter(file =>
        suffixes.some(suffix => file === suffix || file.endsWith(path.sep + suffix))
    );

    // Do not guess when multiple indexed files share the same module suffix
    return matches.length === 1 ? matches[0] : undefined;
}

/** Directory of a package named by an import whose __init__.py is not indexed */
function importedPackageDir(
    entry: ParsedImport,
    currentFile: string,
    knownFiles: string[]
): string | undefined {
    const parts = entry.module.split('.').filter(Boolean);

    if (parts.length === 0) return undefined;

    if (entry.level > 0) {
        let base = path.dirname(currentFile);

        for (let i = 1; i < entry.level; i++) base = path.dirname(base);

        const dir = path.join(base, ...parts);

        return knownFiles.some(file => file.startsWith(dir + path.sep)) ? dir : undefined;
    }

    const suffix = path.join(...parts);
    const dirs = new Set<string>();

    for (const file of knownFiles) {
        for (let dir = path.dirname(file); dir !== path.dirname(dir); dir = path.dirname(dir)) {
            if (dir === suffix || dir.endsWith(path.sep + suffix)) dirs.add(dir);
        }
    }

    // As with modules, an ambiguous package suffix is not guessed
    return dirs.size === 1 ? [...dirs][0] : undefined;
}

/**
 * Resolve an explicitly imported model class
 * Django requires models of a package to be imported in its __init__.py, so an import of the
 * package selects the single model with that name inside it; otherwise nothing is guessed
 */
export function resolveImportedModel(
    index: ModelIndex,
    entry: ParsedImport,
    currentFile: string
): ModelInfo | null {
    const knownFiles = [...index.files];
    const filePath = resolveImportFile(entry, currentFile, knownFiles);
    const declared = filePath && index.models.find(model =>
        model.filePath === filePath && model.name === entry.original);

    if (declared) return declared;

    const packageDir = filePath
        ? path.basename(filePath) === '__init__.py' ? path.dirname(filePath) : undefined
        : importedPackageDir(entry, currentFile, knownFiles);

    if (!packageDir) return null;

    const matches = index.models.filter(model => !model.isBuiltin &&
        model.name === entry.original && model.filePath.startsWith(packageDir + path.sep));

    return matches.length === 1 ? matches[0] : null;
}

function shortName(reference: string): string {
    const cleaned = reference.trim().replace(/\[.*\]$/, '');
    const parts = cleaned.split('.');

    return parts[parts.length - 1];
}

/**
 * Build a fresh index, resolving fields, inheritance and relation targets
 * Input parsed classes are not modified
 */
export function buildModelIndex(
    files: ParsedFile[],
    options: RegistryOptions = {}
): ModelIndex {
    const index = createEmptyIndex();

    const entries: ClassEntry[] = [];

    const addClass = (filePath: string, parsed: ParsedClass) => {
        const appName = parsed.appName ?? appNameFromPath(filePath);

        entries.push({
            parsed,
            key: `${filePath}::${parsed.name}`,
            appName,
            fullName: `${appName}.models.${parsed.name}`
        });
    };

    for (const file of files) {
        index.files.add(file.filePath);

        for (const parsed of file.classes) addClass(file.filePath, parsed);
    }

    // Project class names take precedence over built-in descriptions
    if (options.includeBuiltins !== false) {
        const projectNames = new Set(entries.map(entry => entry.parsed.name));

        for (const parsed of builtinClasses(projectNames)) {
            addClass(parsed.filePath, parsed);
        }
    }

    const knownFiles = [...index.files];

    const importsByFile = new Map<string, Map<string, ResolvedImport>>();

    for (const file of files) {
        if (!file.imports || file.imports.length === 0) continue;

        const resolved = new Map<string, ResolvedImport>();

        for (const entry of file.imports) {
            resolved.set(entry.local, {
                original: entry.original,
                filePath: resolveImportFile(entry, file.filePath, knownFiles),
                entry
            });
        }

        importsByFile.set(file.filePath, resolved);
    }

    const entriesByName = new Map<string, ClassEntry[]>();

    for (const entry of entries) {
        const name = entry.parsed.name;
        const list = entriesByName.get(name) ?? [];

        list.push(entry);
        entriesByName.set(name, list);
    }

    /**
     * Resolve a class from its source context
     * Prefer a declaration in the same file, then an explicit import, then the same app
     * Unresolved ambiguity falls back to the first indexed candidate
     */
    const findEntry = (name: string, from?: ClassEntry): ClassEntry | undefined => {
        const short = shortName(name);
        const candidates = entriesByName.get(short) ?? [];

        if (from) {
            const sameFile = candidates.find(
                candidate => candidate.parsed.filePath === from.parsed.filePath
            );

            if (sameFile) return sameFile;

            const imported = importsByFile.get(from.parsed.filePath)?.get(short);

            if (imported) {
                const named = entriesByName.get(imported.original) ?? [];
                const target = named.find(candidate =>
                    candidate.parsed.filePath === imported.filePath);

                if (target) return target;

                // Models of a package are re-exported from its __init__.py
                const packageDir = imported.filePath
                    ? path.basename(imported.filePath) === '__init__.py'
                        ? path.dirname(imported.filePath) : undefined
                    : importedPackageDir(imported.entry, from.parsed.filePath, knownFiles);
                const inPackage = packageDir ? named.filter(candidate =>
                    candidate.parsed.filePath.startsWith(packageDir + path.sep)) : [];

                if (inPackage.length === 1) return inPackage[0];

                // An explicit import of an unindexed module is not a same-named project class
                if (!isBuiltinModelImport(imported.entry.module, imported.original)) {
                    return undefined;
                }

                const builtin = named.find(candidate => candidate.parsed.isBuiltin);

                if (builtin) return builtin;
            }

            if (candidates.length > 1) {
                const sameApp = candidates.find(candidate => candidate.appName === from.appName);

                if (sameApp) return sameApp;
            }
        }

        return candidates[0];
    };

    /** Classify models recursively, including subclasses of project-defined abstract bases */
    const modelFlags = new Map<string, boolean>();

    const isDjangoModel = (entry: ClassEntry, visited = new Set<string>()): boolean => {
        const cached = modelFlags.get(entry.key);
        if (cached !== undefined) return cached;

        if (visited.has(entry.key)) return false;
        visited.add(entry.key);

        let result = false;

        for (const base of entry.parsed.bases) {
            const name = shortName(base);

            if (NON_MODEL_BASES.has(name)) continue;

            if (DJANGO_MODEL_BASES.has(name)) {
                result = true;
                break;
            }

            const parent = findEntry(name, entry);

            if (parent && parent.key !== entry.key && isDjangoModel(parent, visited)) {
                result = true;
                break;
            }
        }

        modelFlags.set(entry.key, result);

        return result;
    };

    /**
     * Collect fields in inheritance order, allowing child declarations to override names
     * Clone fields so self references and related_name templates remain model-specific
     */
    const fieldsCache = new Map<string, ModelField[]>();

    const resolveFields = (entry: ClassEntry, visited = new Set<string>()): ModelField[] => {
        const cached = fieldsCache.get(entry.key);
        if (cached) return cached.map(field => ({ ...field }));

        if (visited.has(entry.key)) return [];
        visited.add(entry.key);

        const collected = new Map<string, ModelField>();

        for (const base of entry.parsed.bases) {
            const name = shortName(base);

            if (NON_MODEL_BASES.has(name)) continue;

            // A qualified base name may refer to a project class, not Django internals
            if (name === 'Model') continue;

            const parent = findEntry(name, entry);
            if (!parent || parent.key === entry.key) continue;

            for (const field of resolveFields(parent, visited)) {
                collected.set(field.name, {
                    ...field,
                    isInherited: true,
                    declaredIn: field.declaredIn ?? parent.fullName,
                    relationOwnerKey: field.relationOwnerKey ??
                        (parent.parsed.isAbstract ? undefined : parent.key)
                });
            }
        }

        for (const field of entry.parsed.fields) {
            collected.set(field.name, {
                ...field,
                isInherited: false,
                declaredIn: entry.fullName
            });
        }

        const result = [...collected.values()];

        fieldsCache.set(entry.key, result);

        return result.map(field => ({ ...field }));
    };

    const modelEntries = entries.filter(entry => isDjangoModel(entry));

    const entryByKey = new Map<string, ClassEntry>();

    for (const entry of modelEntries) {
        entryByKey.set(entry.key, entry);
        const model: ModelInfo = {
            key: entry.key,
            fullName: entry.fullName,
            appName: entry.appName,
            name: entry.parsed.name,
            filePath: entry.parsed.filePath,
            line: entry.parsed.line,
            column: entry.parsed.column,
            isAbstract: entry.parsed.isAbstract,
            isProxy: entry.parsed.isProxy,
            isBuiltin: entry.parsed.isBuiltin === true,
            bases: entry.parsed.bases,
            baseKeys: entry.parsed.bases
                .map(base => findEntry(base, entry))
                .filter(
                    (base): base is ClassEntry => !!base && base.key !== entry.key
                )
                .map(base => base.key),
            fields: resolveFields(entry)
        };

        index.models.push(model);
        index.byKey.set(model.key, model);
    }

    const userModel = resolveUserModel(index, options.userModel);

    /**
     * Resolve self and AUTH_USER_MODEL markers, app-qualified targets and local references
     * Relative string targets use the app of the concrete model owning the field; Python
     * symbols use declaration imports
     */
    const resolveTarget = (raw: string, model: ModelInfo, field: ModelField): ModelInfo | null => {
        const owner = (field.relationOwnerKey && index.byKey.get(field.relationOwnerKey)) || model;

        if (raw === SELF_MODEL_REF) return owner;
        if (raw === AUTH_USER_MODEL_REF) return userModel;

        const parts = raw.split('.');
        const name = parts[parts.length - 1];

        if (parts.length > 1) {
            const appLabel = parts[parts.length - 2].toLowerCase();

            const exact = index.models.find(
                model =>
                    model.name.toLowerCase() === name.toLowerCase() &&
                    model.appName.toLowerCase() === appLabel
            );

            if (exact) return exact;
        }

        // An app label without that model names a model outside the index
        if (parts.length > 1) return null;

        if (field.relatedModelIsString) {
            return index.models.find(
                model => model.name === name && model.appName === owner.appName
            ) ?? null;
        }

        // A Python target is evaluated in the declaring file even when the field is inherited
        const context = entries.find(entry => entry.parsed.filePath === field.sourceFilePath) ??
            entryByKey.get(owner.key);
        const entry = findEntry(name, context);

        return entry ? index.byKey.get(entry.key) ?? null : null;
    };

    for (const model of index.models) {
        for (const field of model.fields) {
            if (!field.relatedModelRaw) continue;

            const target = resolveTarget(field.relatedModelRaw, model, field);

            field.relatedModel = target ? target.name : shortName(field.relatedModelRaw);
            field.relatedModelKey = target?.key;
        }
    }

    addImplicitPrimaryKeys(index);

    buildNameIndex(index);
    buildReverseRelations(index);

    return index;
}

/** Add a synthetic id to concrete models without an explicit primary key or id field */
function addImplicitPrimaryKeys(index: ModelIndex): void {
    for (const model of index.models) {
        if (model.isAbstract) continue;

        const hasPrimaryKey = model.fields.some(
            field => field.isPrimaryKey || field.name === 'id'
        );

        if (hasPrimaryKey) continue;

        model.fields.unshift({
            name: 'id',
            type: 'AutoField',
            sourceFilePath: model.filePath,
            sourceLine: model.line,
            sourceColumn: model.column,
            isPrimaryKey: true,
            isImplicit: true,
            declaredIn: model.fullName
        });
    }
}

/** Choose the configured user model, a concrete custom descendant, or standard auth.User */
function resolveUserModel(index: ModelIndex, configured?: string): ModelInfo | null {
    const models = index.models;
    if (configured && configured.trim()) {
        const parts = configured.trim().split('.');
        const name = parts[parts.length - 1].toLowerCase();
        const appLabel = parts.length > 1 ? parts[parts.length - 2].toLowerCase() : null;

        const exact = models.find(
            model =>
                model.name.toLowerCase() === name &&
                (!appLabel || model.appName.toLowerCase() === appLabel)
        );

        if (exact) return exact;
    }

    // The swappable user model extends the abstract user bases directly or through abstract
    // project bases; its proxies and multi-table children are not AUTH_USER_MODEL
    const inheritsUser = (model: ModelInfo, visited = new Set<string>()): boolean => {
        if (visited.has(model.key)) return false;
        visited.add(model.key);

        return model.bases.some(base => ['AbstractUser', 'AbstractBaseUser'].includes(shortName(base))) ||
            model.baseKeys.some(key => {
                const parent = index.byKey.get(key);

                return !!parent && parent.isAbstract && inheritsUser(parent, visited);
            });
    };

    return models.find(model => !model.isAbstract && !model.isBuiltin && inheritsUser(model)) ??
        models.find(model => !model.isAbstract && model.appName === 'auth' && model.name === 'User') ?? null;
}

/**
 * Resolve a relation by its stored model key
 * Unresolved targets must not fall back to a same-named model in another app
 */
export function resolveRelatedModel(index: ModelIndex, field: ModelField): ModelInfo | null {
    // The index resolves every target once; a missing key is a model outside the index
    return field.relatedModelKey ? index.byKey.get(field.relatedModelKey) ?? null : null;
}

function buildNameIndex(index: ModelIndex): void {
    index.byLowerName.clear();

    for (const model of index.models) {
        const key = model.name.toLowerCase();
        const list = index.byLowerName.get(key) ?? [];

        list.push(model);
        index.byLowerName.set(key, list);
    }
}

/** Expand %(class)s and %(app_label)s using the concrete model's lower-case names */
function expandRelatedName(template: string, owner: ModelInfo): string {
    return template
        .replace(/%\(class\)s/g, owner.name.toLowerCase())
        .replace(/%\(app_label\)s/g, owner.appName.toLowerCase());
}

/** Add reverse accessors to relation targets using the original owner's model key */
function buildReverseRelations(index: ModelIndex): void {
    for (const owner of index.models) {
        // Only concrete models contribute reverse accessors
        if (owner.isAbstract) continue;

        // Skip proxy copies of fields already represented by the concrete model
        if (owner.isProxy) continue;

        // Iterate a snapshot because adding a reverse accessor can mutate the same model
        for (const field of [...owner.fields]) {
            if (field.isReverse) continue;
            // A concrete parent's field belongs to that parent and adds its accessor once
            if (field.relationOwnerKey) continue;
            if (!RELATION_FIELD_TYPES.has(field.type)) continue;
            if (!field.relatedModel) continue;

            // A related_name ending in + suppresses the reverse accessor
            if (field.relatedName === '+' || field.relatedName?.endsWith('+')) continue;

            const target = resolveRelatedModel(index, field);
            if (!target) continue;

            if (target.isAbstract) continue;

            let reverseName: string;

            if (field.relatedName) {
                reverseName = expandRelatedName(field.relatedName, owner);
            } else if (field.type === 'OneToOneField') {
                reverseName = owner.name.toLowerCase();
            } else {
                reverseName = `${owner.name.toLowerCase()}_set`;
            }

            if (target.fields.some(existing => existing.name === reverseName)) continue;

            target.fields.push({
                name: reverseName,
                queryName: field.relatedQueryName
                    ? expandRelatedName(field.relatedQueryName, owner)
                    : field.relatedName ? reverseName : owner.name.toLowerCase(),
                type: `Reverse${field.type}`,
                relatedModel: owner.name,
                relatedModelKey: owner.key,
                relatedModelRaw: owner.name,
                sourceFilePath: field.sourceFilePath,
                sourceLine: field.sourceLine,
                sourceColumn: field.sourceColumn,
                isReverse: true,
                declaredIn: owner.fullName,
                reverseOf: `${owner.name}.${field.name}`
            });
        }
    }
}

/** Return all indexed models matching a name case-insensitively */
export function findModelsByName(index: ModelIndex, name: string): ModelInfo[] {
    return index.byLowerName.get(name.trim().toLowerCase()) ?? [];
}

/**
 * Find a model by name, preferring the contextual file, then its app
 * Otherwise prefer a concrete model and finally the first candidate
 */
export function findModelByName(
    index: ModelIndex,
    name: string,
    context?: { filePath?: string; appName?: string }
): ModelInfo | null {
    const candidates = findModelsByName(index, name);
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    if (context?.filePath) {
        const sameFile = candidates.find(model => model.filePath === context.filePath);
        if (sameFile) return sameFile;
    }

    if (context?.appName) {
        const sameApp = candidates.find(model => model.appName === context.appName);
        if (sameApp) return sameApp;
    }

    return candidates.find(model => !model.isAbstract) ?? candidates[0];
}

/** Return whether the index contains a case-insensitive model-name match */
export function isKnownModel(index: ModelIndex, name: string): boolean {
    return index.byLowerName.has(name.trim().toLowerCase());
}

/** Follow relation fields and return the final model, or null when the chain breaks */
export function resolveFieldChain(
    index: ModelIndex,
    start: ModelInfo,
    parts: string[]
): ModelInfo | null {
    let current: ModelInfo | null = start;

    for (const part of parts) {
        if (!current) return null;

        const field = current.fields.find(
            candidate => candidate.name.toLowerCase() === part.toLowerCase()
        );

        if (!field || !field.relatedModel) return null;

        current = resolveRelatedModel(index, field);
    }

    return current;
}

/** Find a field case-insensitively; pk resolves to the model's primary key */
/** Name of a field in queryset lookups: reverse relations use their query name */
export function lookupFieldName(field: ModelField): string {
    return field.isReverse ? field.queryName ?? field.name : field.name;
}

/** Find a field by its lookup name, as filter(), values() and order_by() spell it */
export function findLookupField(model: ModelInfo, name: string): ModelField | undefined {
    const lower = name.trim().toLowerCase();

    if (lower === 'pk') return findModelField(model, name);

    return model.fields.find(field => lookupFieldName(field).toLowerCase() === lower);
}

export function findModelField(model: ModelInfo, name: string): ModelField | undefined {
    const lower = name.trim().toLowerCase();

    if (lower === 'pk') {
        return (
            model.fields.find(field => field.isPrimaryKey) ??
            model.fields.find(field => field.name === 'id')
        );
    }

    return model.fields.find(field => field.name.toLowerCase() === lower);
}

/** One field, lookup or unresolved segment in a Django lookup path */
export interface LookupStep {
    name: string;

    /** Model on which this segment was looked up, if the preceding path resolved */
    model: ModelInfo | null;

    /** Resolved field, or null for a lookup or unknown segment */
    field: ModelField | null;

    /** Whether an unresolved name matches a supported lookup or transform */
    isLookup: boolean;
}

/**
 * Walk lookup segments, recording each resolved field and its owner
 * After a scalar field or an unknown segment, remaining names are checked as lookups
 * Reverse relations match their query name unless byAccessor, as in prefetch_related()
 */
export function walkLookupPath(
    index: ModelIndex,
    root: ModelInfo,
    segments: string[],
    byAccessor = false
): LookupStep[] {
    const steps: LookupStep[] = [];

    let current: ModelInfo | null = root;

    for (const name of segments) {
        if (!current) {
            steps.push({
                name,
                model: null,
                field: null,
                isLookup: DJANGO_LOOKUP_SET.has(name.toLowerCase())
            });

            continue;
        }

        const field: ModelField | undefined = byAccessor
            ? findModelField(current, name) : findLookupField(current, name);

        if (!field) {
            steps.push({
                name,
                model: current,
                field: null,
                isLookup: DJANGO_LOOKUP_SET.has(name.toLowerCase())
            });

            // No further fields can be resolved after a lookup or unknown segment
            current = null;

            continue;
        }

        steps.push({ name, model: current, field, isLookup: false });

        current = field.relatedModel ? resolveRelatedModel(index, field) : null;
    }

    return steps;
}

/**
 * Return the model and last field reached by a completion prefix
 * An empty prefix returns the root model; a scalar field leaves no next model
 */
export function resolveLookupPrefix(
    index: ModelIndex,
    root: ModelInfo,
    segments: string[],
    byAccessor = false
): { model: ModelInfo | null; lastField: ModelField | null } {
    if (segments.length === 0) return { model: root, lastField: null };

    const steps = walkLookupPath(index, root, segments, byAccessor);
    const last = steps[steps.length - 1];

    if (!last.field) return { model: null, lastField: null };

    if (!last.field.relatedModel || !last.model) {
        return { model: null, lastField: last.field };
    }

    return {
        model: resolveRelatedModel(index, last.field),
        lastField: last.field
    };
}

/** An indexed relation or inheritance usage */
export interface ModelUsage {
    /** The model that contains this usage */
    model: ModelInfo;

    /** The relation field, absent for inheritance usages */
    field?: ModelField;

    kind: 'relation' | 'inheritance';
}

/**
 * Collect usages for all targets in one pass, keyed by the referenced model
 * CodeLens shares this result across models instead of rescanning for each lens
 */
export function collectAllModelUsages(index: ModelIndex): Map<string, ModelUsage[]> {
    const byTarget = new Map<string, ModelUsage[]>();

    const add = (key: string, usage: ModelUsage) => {
        const list = byTarget.get(key) ?? [];

        list.push(usage);
        byTarget.set(key, list);
    };

    for (const model of index.models) {
        for (const baseKey of model.baseKeys) {
            add(baseKey, { model, kind: 'inheritance' });
        }

        for (const field of model.fields) {
            if (field.isReverse) continue;
            if (!RELATION_FIELD_TYPES.has(field.type)) continue;

            // Inherited copies are not new source declarations
            if (field.isInherited) continue;

            const target = resolveRelatedModel(index, field);

            if (target) add(target.key, { model, field, kind: 'relation' });
        }
    }

    return byTarget;
}

/** Return relation declarations and subclasses that reference the target model */
export function collectModelUsages(index: ModelIndex, target: ModelInfo): ModelUsage[] {
    return collectAllModelUsages(index).get(target.key) ?? [];
}

/** Accept an annotation only when every non-None alternative resolves to the same model */
export function resolveModelAnnotation(
    annotation: string,
    resolveName: (name: string) => ModelInfo | null
): ModelInfo | null {
    const names = modelAnnotationNames(annotation);
    if (!names?.length) return null;
    let result: ModelInfo | null = null;

    for (const name of names) {
        const model = resolveName(name);
        if (!model || (result && result.key !== model.key)) return null;
        result = model;
    }

    return result;
}

/** Resolve one function result, keeping tuple slots and conflicting return paths separate */
export function resolveFunctionResult(
    fn: ParsedFunction,
    tupleIndex: number | undefined,
    resolveReturn: (expression: string, returned: FunctionReturn) => ModelInfo | null,
    resolveAnnotation: (annotation: string) => ModelInfo | null
): ModelInfo | null {
    if (fn.annotation) {
        const annotation = fn.annotation.replace(/^['"]|['"]$/g, '');
        const tuple = annotation.match(/^(?:typing\.)?(?:tuple|Tuple)\[([\s\S]*)\]$/);

        if (tupleIndex !== undefined) {
            if (!tuple) return null;

            const slot = splitTopLevelArgs(tuple[1])[tupleIndex];

            return slot ? resolveAnnotation(slot) : null;
        }

        return tuple ? null : resolveAnnotation(annotation);
    }

    let result: ModelInfo | null = null;

    for (const returned of fn.returns) {
        if (returned.tuple !== (tupleIndex !== undefined)) return null;

        const expression = returned.expressions[tupleIndex ?? 0];
        if (!expression) return null;

        const current = resolveReturn(expression, returned);
        if (!current || (result && current.key !== result.key)) return null;

        result = current;
    }

    return result;
}
