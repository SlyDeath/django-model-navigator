# Django Model Navigator

Navigate Django models in Visual Studio Code with Go to Definition, hover information,
field completion, Find All References and CodeLens. Follow relationships across models
without running Python or loading your Django project.

## Getting started

1. Open the Django project folder in VS Code 1.100 or later.
2. Open a Python file. The extension activates automatically and indexes `**/models.py`.
3. Use `Ctrl+Click` (`Cmd+Click` on macOS) or Go to Definition on a model or field,
   hover for field details, or request completion after a dot.

For example:

```python
# accounts/models.py
from django.db import models


class Profile(models.Model):
    email = models.EmailField()


class Employee(models.Model):
    profile = models.OneToOneField(Profile, on_delete=models.CASCADE)
```

```python
# accounts/views.py
from .models import Employee

employee = Employee.objects.first()
employee.profile.email  # Navigate to email in Profile, or hover for its type
```

Completion works on `employee.`, `employee.profile.` and partial field names.

### Models in packages or custom files

Only files named `models.py` are searched by default. Add workspace glob patterns for
split model packages or custom filenames in your VS Code settings:

```json
{
  "djangoModelNavigator.additionalModelPaths": [
    "**/models/*.py",
    "**/*_models.py"
  ]
}
```

The default `**/models.py` search remains enabled. Model files are refreshed after
saves, creation and deletion. File events are debounced, and scans run sequentially.
To force a full scan, run **Django Model Navigator: Rebuild Model Cache**.

## Sidebar

Open **Django Model Navigator** from its model-tree icon in the Activity Bar.
The panel can activate the extension even before you open a Python file.

- **Overview** shows index status, project and built-in model counts, indexed file
  count, and the duration and time of the last successful index update.
- **Models** groups models by app. Expand a model to browse its fields and their types;
  abstract/proxy models and inherited, reverse and implicit fields are marked.
  Django's built-in app groups have a `(Django)` suffix.
- Click a project model or a field with a source location to open its declaration.
  An implicit `id` links to the model declaration; built-in declarations have no
  project source to open. Hover an item to see its full name and source path.
- Use the panel title buttons to **Rebuild Model Cache** or **Show Log**.

The native tree reads the existing index and updates on scan events. Expanding it
neither searches the workspace nor reparses Python, and there is no polling timer.
The scan duration describes index updates, not completion latency or CPU usage.

## Navigation features

- **Definitions and hovers:** model and field declarations, field types, relation targets,
  `related_name` and the source of inherited fields.
- **Field chains:** forward and reverse relations, such as `employee.profile.email`.
- **Queryset lookup paths:** completion, definitions and hovers for individual segments
  in `filter(profile__email__icontains=...)`, `order_by("-profile__email")` and
  `select_related("profile")`.
- **Inheritance:** fields from indexed project bases, including abstract models and
  qualified base names, plus built-in user-model bases such as `AbstractUser`.
- **Imports:** top-level `from ... import ...` bindings, including aliases and relative
  imports, help distinguish models with the same name in different apps.
- **Django relations:** `'self'`, app-qualified strings, `settings.AUTH_USER_MODEL`,
  conventional reverse accessors, `related_name='+'` and the `%(class)s` /
  `%(app_label)s` templates. Queryset lookups name reverse relations by their query
  name (`related_query_name`, `related_name` or the model name), while
  `prefetch_related()` and `Prefetch()` use accessors such as `review_set`. String targets and imported Python class targets retain
  their different resolution contexts when fields are inherited.
- **Primary keys:** implicit `id` fields and the `pk` alias for explicit or implicit
  primary keys.
- **Declarations:** multiline fields and constructors imported without the `models.`
  prefix, such as `name = CharField(...)`.
- **References:** relation declarations pointing to a model and classes inheriting from it.
- **CodeLens:** field, reverse-relation and indexed usage counts above model declarations;
  click the usage lens to open references when any are available.

### Variable inference

The extension follows assignments, type annotations, `for` targets, `with ... as`
bindings, common wrappers such as `sorted` and `list`, and shortcuts such as
`get_object_or_404`:

```python
from shop.models import Client

query = Client.objects.all()
rows = sorted(query, key=lambda row: row.name)
for row in rows:
    staff = row.employees.all()
    for item in staff:
        item.profile.email  # Follow relations across the assignment chain
```

Bindings take precedence over a variable name that happens to match a model name.
Nested assignments are resolved as of the original binding, so later reassignment of
the source variable does not change an earlier value's inferred model. `self.field`
and `cls.field` are recognized in model methods.

### Function results and tuple unpacking

The extension follows explicit `from ... import ...` calls into local workspace
modules, using the function's own imports to resolve its result. Top-level functions
in the current file work too. A return annotation can identify the model; otherwise,
the return expressions and their local assignments are inspected.

```python
# shop/query_helpers.py
from shop.models import Client


def filter_rows(query, name):
    return query.filter(name__icontains=name)


def get_clients_query(request):
    name = request.GET.get("name", "")
    query = filter_rows(Client.objects.all(), name)
    return name, query
```

```python
# shop/views.py
from .query_helpers import get_clients_query

name, rows = get_clients_query(request)
for row in rows:
    row.name  # Completion, hovers and definitions follow the Client model
```

Multiline tuple unpacking and ignored slots such as `_, rows = ...` are supported.
Each target uses its own return slot: a string filter value is not treated as a model.
Passing a queryset through another inspected helper preserves its model, including
positional and keyword arguments. Conflicting or unresolved return types remain
unknown rather than selecting an arbitrary model.

Helper modules are read into private source snapshots only when tracing the requested
value, without executing Python or opening extra Python documents in the editor.
Unsaved text is reused when the user already has the helper open; external file changes
invalidate cached snapshots. Unrelated calls do not load their imports.
Local `file:` helpers use asynchronous native reads. Remote extension hosts and
other URI schemes retain the VS Code filesystem provider; a failed native read is
retried once through that provider. Source caches keep URI scheme and authority
separate, and already-open unsaved text takes priority over either disk reader. Import lookup is
bounded to 32 searches per request and eight dependency levels, honoring
`excludePatterns`. Editing an inspected helper invalidates cached result types;
repeated typing with unchanged imports reuses module lookup results.
The initial workspace scan also caches Python source filenames with the configured
exclusions. This lets a cold hover resolve an imported helper without another
workspace search; only model files are parsed during indexing. Creating or deleting
files invalidates the filename cache, and imports use on-demand search until the next
full scan. If collecting filenames fails, imports also retain on-demand search.

With debug logging enabled, `Hover ready in ... ms` records when this extension's
response is ready, separately from other language providers in the combined tooltip.
`Hover stages` splits it into workspace search, file read, syntax parse, resolution
and remaining asynchronous wait; `modules` counts newly loaded helper sources.
`nativeReads` and `apiReads` show which filesystem transport was used.

Definitions, hovers and references use the resolved expression context. Unknown
bindings and unresolved explicit imports do not fall back to unrelated model names.
Comments, string contents and bindings in sibling or nested functions do not change
the current variable's model. An unknown inner queryset does not borrow an outer
queryset's model; context-only expressions such as `Q(...)` still use their queryset.

Shortcuts accept a model, manager or queryset argument. `values()`, `values_list()`,
`aggregate()` and `update()` results are not treated as model instances, while field
arguments inside those calls retain the queryset context. Unpacking `get_or_create()`
or `update_or_create()` preserves the model only for the object slot.

Annotations such as `Optional[Client]`, `Client | None` and `QuerySet[Client]` retain
one model. Annotations with conflicting models or unsupported containers remain
unknown rather than selecting their first model name.

### Built-in models

The index includes descriptions of Django's `auth.User`, `Group`, `Permission`,
`ContentType`, `Session`, `sites.Site` and `admin.LogEntry`, plus abstract user-model
bases. These allow completion and relationship traversal when Django's own source
files are outside the workspace search.

A project class with the same name takes precedence over a built-in description.
Built-ins have no project source location, so Go to Definition is not offered for
their synthetic declarations. Set `includeBuiltinModels` to `false` to disable them.

For `settings.AUTH_USER_MODEL`, `userModel` can specify an explicit model such as
`accounts.User`. When it is empty, the index looks for a concrete project descendant
of `AbstractUser` or `AbstractBaseUser`, then falls back to `auth.User` when available.

## Commands

Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`):

| Command | Action |
| --- | --- |
| Django Model Navigator: Rebuild Model Cache | Rescan model files and rebuild the index. |
| Django Model Navigator: Show Log | Open the extension's output channel. |
| Django Model Navigator: Toggle Debug Logging | Toggle detailed scan diagnostics. |

Errors are logged even when debug logging is disabled.

## Settings

All settings use the `djangoModelNavigator.` prefix. Changes take effect without
reloading the window; index-related changes schedule a workspace rescan.

| Setting | Default | Description |
| --- | --- | --- |
| `debug` | `false` | Log scanned files, models and rescan reasons. |
| `additionalModelPaths` | `[]` | Extra model-file globs; `**/models.py` is always included. |
| `excludePatterns` | See below | Globs excluded from model-file searches. |
| `additionalFieldTypes` | `[]` | Extra field constructors that do not end in `Field`, such as `TaggableManager`. |
| `userModel` | `""` | Explicit target for `settings.AUTH_USER_MODEL`, or infer it when empty. |
| `includeBuiltinModels` | `true` | Include Django's built-in model descriptions. |
| `hoverMaxFields` | `40` | Maximum fields displayed in a model hover. |
| `maxDefinitionResults` | `20` | Maximum definition candidates. |
| `enableDefinition` | `true` | Enable Go to Definition. |
| `enableHover` | `true` | Enable model and field hovers. |
| `enableCompletion` | `true` | Enable field and lookup completion. |
| `enableReferences` | `true` | Enable indexed model references. |
| `enableCodeLens` | `true` | Show counts and reference links above model declarations. |

Default exclusions:

```json
[
  "**/__pycache__/**",
  "**/migrations/**",
  "**/node_modules/**",
  "**/.git/**",
  "**/.venv/**",
  "**/venv/**",
  "**/site-packages/**"
]
```

Setting `excludePatterns` replaces this list. Preserve any defaults you still need.

## Scope and limitations

This extension uses static text parsing, not Python execution or Django's app registry.
A configured interpreter and installed Django runtime are not required for its own
indexing. Dynamic model or field construction, star imports and plain module imports
are not resolved. Nonstandard layouts may need additional search patterns or an
explicit `userModel` setting.

Variable inference is heuristic: it searches up to 1,000 lines above the cursor and
uses an eight-step binding-depth limit and an eight-call function-depth limit.
It is not a full Python type checker. Function analysis covers top-level declarations;
class methods, dynamic call targets, argument packs and module re-exports are not
resolved as a general Python call graph.
Some queryset operations change the shape of their results; inferred model fields do
not describe every possible Python return value.

Find All References searches the model index for relation declarations and inheritance.
Ordinary attribute usages in application code are left to your Python language server.
Built-in fields are maintained as static descriptions and do not reflect every Django
version or project customization.

## Development

```bash
npm ci
npm run lint
npm run compile
npm test
```

`compile` writes the extension to `out/`. `npm test` first compiles sources and tests
to `out-test/`, then runs parser, registry, lookup, dependency-boundary, provider and
cache tests. Providers use a VS Code API stub; the suite does not launch VS Code or
Django. GitHub Actions runs lint, compilation and tests on Node.js 20 and 22.

Use `npm run watch` during development. To check actual editor integration, launch
the extension in a VS Code Extension Development Host and open a Django workspace.

## License

[MIT](LICENSE)
