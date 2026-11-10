/** Shared model-index types and Django name sets, independent of VS Code */

/** Field types that represent direct model relations */
export const RELATION_FIELD_TYPES = new Set([
    'ForeignKey',
    'OneToOneField',
    'ManyToManyField',
    'ForeignObject'
]);

/** Base names recognized as Django models without resolving a project definition */
export const DJANGO_MODEL_BASES = new Set([
    'Model',
    'AbstractUser',
    'AbstractBaseUser',
    'PermissionsMixin',
    // Recognized third-party model bases
    'MPTTModel',
    'PolymorphicModel',
    'TranslatableModel'
]);

/** Base names excluded from model classification, such as choices and querysets */
export const NON_MODEL_BASES = new Set([
    'TextChoices',
    'IntegerChoices',
    'Choices',
    'Enum',
    'IntEnum',
    'StrEnum',
    'Manager',
    'QuerySet',
    'Func',
    'Aggregate',
    'Lookup',
    'Transform',
    'Expression',
    'Index',
    'Form',
    'ModelForm',
    'Serializer',
    'ModelSerializer',
    'ModelAdmin',
    'AppConfig',
    'Migration',
    'TestCase',
    'Exception',
    'ABC',
    'object'
]);

/**
 * Recognized Django lookups and transforms after a field path
 * Custom lookups are not discovered from Python code
 */
export const DJANGO_LOOKUPS = [
    'exact',
    'iexact',
    'contains',
    'icontains',
    'in',
    'gt',
    'gte',
    'lt',
    'lte',
    'startswith',
    'istartswith',
    'endswith',
    'iendswith',
    'range',
    'isnull',
    'regex',
    'iregex',
    'date',
    'year',
    'iso_year',
    'month',
    'day',
    'week',
    'week_day',
    'quarter',
    'time',
    'hour',
    'minute',
    'second',
    'len',
    'unaccent',
    'trigram_similar',
    'overlap',
    'contained_by',
    'has_key',
    'has_keys',
    'has_any_keys'
];

/** Lookup operators offered after a relation field */
export const RELATION_LOOKUPS = ['exact', 'in', 'isnull'];

export const DJANGO_LOOKUP_SET = new Set(DJANGO_LOOKUPS);

/** Internal marker for settings.AUTH_USER_MODEL and get_user_model() */
export const AUTH_USER_MODEL_REF = '<AUTH_USER_MODEL>';

/** Internal marker for ForeignKey('self') */
export const SELF_MODEL_REF = 'self';

/** A declared, inherited or synthetic field in the model index */
export interface ModelField {
    name: string;

    /** Django constructor name or a synthetic Reverse-prefixed relation type */
    type: string;

    /** Resolved target's short name, used for display and legacy name fallback */
    relatedModel?: string;

    /** Resolved target identity, preserving models with the same name in different apps */
    relatedModelKey?: string;

    /**
     * Normalized source target before model resolution
     * Examples: Client, app.Client, self and <AUTH_USER_MODEL>
     */
    relatedModelRaw?: string;

    /** Whether the target is a Django string reference rather than a Python symbol */
    relatedModelIsString?: boolean;

    /**
     * related_name value: undefined when omitted, null for None, or a literal string
     * May contain %(class)s and %(app_label)s templates
     */
    relatedName?: string | null;

    /** File where the field is physically declared */
    sourceFilePath?: string;

    /** Zero-based source line */
    sourceLine?: number;

    /** Zero-based source column */
    sourceColumn?: number;

    isReverse?: boolean;

    isInherited?: boolean;

    /** Full name of the model that originally declared the field */
    declaredIn?: string;

    /**
     * Key of the concrete ancestor that owns an inherited field
     * Django copies fields only from abstract bases, so self and relative string references of
     * a multi-table or proxy parent resolve from that parent, not from the child
     */
    relationOwnerKey?: string;

    /** Original relation in Model.field form, for reverse-accessor descriptions */
    reverseOf?: string;

    /**
     * Name of a reverse relation in queryset lookups such as filter(entry__title=...)
     * Django uses related_query_name, else related_name, else the lowercase model name
     */
    queryName?: string;

    /** related_query_name argument of a relation field, possibly with templates */
    relatedQueryName?: string;

    /** Whether this field is a parsed or synthetic primary key */
    isPrimaryKey?: boolean;

    /** Whether the field was synthesized as an implicit id */
    isImplicit?: boolean;
}

/** A Django model with resolved inheritance and fields */
export interface ModelInfo {
    /** Identity composed of source path and class name */
    key: string;

    /** Display name in app.models.Model form */
    fullName: string;

    /** App name inferred from the path or supplied by a built-in description */
    appName: string;

    name: string;

    /** Source path, or a synthetic path for built-in descriptions */
    filePath: string;

    /** Zero-based class declaration line */
    line: number;

    /** Zero-based column of the class name */
    column: number;

    isAbstract: boolean;

    isProxy: boolean;

    /** Whether this model has no navigable project source */
    isBuiltin: boolean;

    /** Base expressions as written in the class declaration */
    bases: string[];

    /** Keys of resolved base classes, including built-in descriptions */
    baseKeys: string[];

    /** Declared, inherited, implicit and reverse fields */
    fields: ModelField[];
}

/** Resolved model index with name-based lookup tables for interactive providers */
export interface ModelIndex {
    models: ModelInfo[];

    byKey: Map<string, ModelInfo>;

    /** Case-insensitive names can map to multiple models from different apps */
    byLowerName: Map<string, ModelInfo[]>;

    /** Source files included in the workspace scan */
    files: Set<string>;
}

/** Create an index with empty lookup tables and no models */
export function createEmptyIndex(): ModelIndex {
    return {
        models: [],
        byKey: new Map(),
        byLowerName: new Map(),
        files: new Set()
    };
}
