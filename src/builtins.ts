/**
 * Built-in Django model descriptions used when django.contrib is outside the workspace scan
 * Field definitions are maintained here without importing Django or depending on VS Code
 */

import { ParsedClass } from './parser';
import { AUTH_USER_MODEL_REF, ModelField } from './types';

/** Synthetic source path; built-in models have no navigable workspace file */
export const BUILTIN_FILE_PATH = '<django>';

/** Reverse names declared on a built-in relation, copied from django.contrib */
interface BuiltinRelation {
    relatedName?: string;
    relatedQueryName?: string;
}

/** Field name, Django field type, optional related model and its reverse names */
type BuiltinField = [name: string, type: string, relatedModel?: string, relation?: BuiltinRelation];

/** PermissionsMixin declares related_name="user_set", related_query_name="user" */
const USER_SET: BuiltinRelation = { relatedName: 'user_set', relatedQueryName: 'user' };

interface BuiltinModel {
    name: string;
    appName: string;
    bases: string[];
    isAbstract?: boolean;
    fields: BuiltinField[];
    /** Explicit primary key when Django does not create an automatic id */
    primaryKey?: string;
}

const BUILTIN_MODELS: BuiltinModel[] = [
    {
        name: 'AbstractBaseUser',
        appName: 'auth',
        bases: ['models.Model'],
        isAbstract: true,
        fields: [
            ['password', 'CharField'],
            ['last_login', 'DateTimeField']
        ]
    },
    {
        name: 'PermissionsMixin',
        appName: 'auth',
        bases: ['models.Model'],
        isAbstract: true,
        fields: [
            ['is_superuser', 'BooleanField'],
            ['groups', 'ManyToManyField', 'Group', USER_SET],
            ['user_permissions', 'ManyToManyField', 'Permission', USER_SET]
        ]
    },
    {
        name: 'AbstractUser',
        appName: 'auth',
        bases: ['AbstractBaseUser', 'PermissionsMixin'],
        isAbstract: true,
        fields: [
            ['username', 'CharField'],
            ['first_name', 'CharField'],
            ['last_name', 'CharField'],
            ['email', 'EmailField'],
            ['is_staff', 'BooleanField'],
            ['is_active', 'BooleanField'],
            ['date_joined', 'DateTimeField']
        ]
    },
    {
        name: 'User',
        appName: 'auth',
        bases: ['AbstractUser'],
        fields: []
    },
    {
        name: 'Group',
        appName: 'auth',
        bases: ['models.Model'],
        fields: [
            ['name', 'CharField'],
            ['permissions', 'ManyToManyField', 'Permission']
        ]
    },
    {
        name: 'Permission',
        appName: 'auth',
        bases: ['models.Model'],
        fields: [
            ['name', 'CharField'],
            ['content_type', 'ForeignKey', 'ContentType'],
            ['codename', 'CharField']
        ]
    },
    {
        name: 'ContentType',
        appName: 'contenttypes',
        bases: ['models.Model'],
        fields: [
            ['app_label', 'CharField'],
            ['model', 'CharField']
        ]
    },
    {
        name: 'Session',
        appName: 'sessions',
        bases: ['models.Model'],
        primaryKey: 'session_key',
        fields: [
            ['session_key', 'CharField'],
            ['session_data', 'TextField'],
            ['expire_date', 'DateTimeField']
        ]
    },
    {
        name: 'Site',
        appName: 'sites',
        bases: ['models.Model'],
        fields: [
            ['domain', 'CharField'],
            ['name', 'CharField']
        ]
    },
    {
        name: 'LogEntry',
        appName: 'admin',
        bases: ['models.Model'],
        fields: [
            ['action_time', 'DateTimeField'],
            ['user', 'ForeignKey', AUTH_USER_MODEL_REF],
            ['content_type', 'ForeignKey', 'ContentType'],
            ['object_id', 'TextField'],
            ['object_repr', 'CharField'],
            ['action_flag', 'PositiveSmallIntegerField'],
            ['change_message', 'TextField']
        ]
    }
];

/**
 * Return built-in classes, excluding names already declared by the project
 * Project classes take precedence even when their app differs from the built-in app
 */
export function builtinClasses(projectClassNames: Set<string>): ParsedClass[] {
    return BUILTIN_MODELS.filter(model => !projectClassNames.has(model.name)).map(model => {
        const fields: ModelField[] = model.fields.map(([name, type, relatedModel, relation]) => ({
            name,
            type,
            relatedModelRaw: relatedModel,
            relatedName: relation?.relatedName,
            relatedQueryName: relation?.relatedQueryName,
            isReverse: false,
            isPrimaryKey: name === model.primaryKey
        }));

        return {
            name: model.name,
            bases: model.bases,
            filePath: BUILTIN_FILE_PATH,
            line: 0,
            column: 0,
            isAbstract: model.isAbstract === true,
            isProxy: false,
            fields,
            appName: model.appName,
            isBuiltin: true
        };
    });
}

/** Recognize only the canonical Django module for a described built-in model */
export function isBuiltinModelImport(module: string, name: string): boolean {
    return BUILTIN_MODELS.some(model => model.name === name &&
        module === `django.contrib.${model.appName}.models`);
}
