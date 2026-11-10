# Changelog

## 1.4.1

- The changelog and the rest of the project text are now in English.

## 1.4.0

### New

- Django Model Navigator view in the Activity Bar: index status, model and
  file counts, the time of the last update and a tree of apps, models and
  fields. From the view you can jump to a declaration, refresh the index or
  open the log.
- Function results: a variable returned by a local or imported function used
  to have no completions; its model is now taken from the function's
  annotation or `return`, including tuple unpacking, an indexed
  `get_or_create(...)[0]` result and a queryset passed in as an argument.
  Ambiguous results are not guessed.

### Accuracy

- An unknown value could previously get the fields of a same-named model; a
  model is no longer picked by a matching name, and navigation, completion
  and go to field only use what follows from the code.
- Imports are resolved the same way everywhere: models re-exported from a
  `models/__init__.py` package are found, and a relation to a third-party
  model such as `"taggit.Tag"` is no longer replaced by a same-named project
  model.
- In `filter()`, `values()` and `order_by()` reverse relations are named the
  way Django expects: `review__text`, not `review_set__text`;
  `prefetch_related()` and `Prefetch()` still use `review_set`.
- Fields inside `Q`, `F`, aggregates and `Prefetch` belong to the outer
  queryset, including the `models.Q(...)` form; a queryset stored in a
  variable after `values()` keeps its completions in later calls.
- Results of `values()`, `values_list()`, `aggregate()` and `update()` are no
  longer treated as model instances.
- Inheritance: fields of abstract bases resolve in the child's app, while
  relations of a concrete parent and its proxy resolve in the parent's app;
  a child no longer adds a bogus reverse accessor such as `restaurant_set`.
- User model: the default user resolves to the concrete `auth.User`, a custom
  user model is found through an intermediate abstract base, and its proxy
  or subclass is never taken for `AUTH_USER_MODEL`. The built-in `groups`
  and `user_permissions` provide the `user_set` accessor, and `LogEntry.user`
  points to the project's user model.
- Python parsing: multiline `return` statements and signatures, nested
  functions, comments, strings and docstrings no longer distort variable
  types, primary keys or the set of fields.

### Performance

- Unchanged documents are not parsed again, the first hover no longer
  searches the whole project for an imported file, and imported helpers are
  read from disk without opening them in the editor or triggering work in
  other extensions.
- Very long lines no longer slow down parsing; a crafted file used to keep
  the editor busy for a long time.

### Index updates

- New files matching additional patterns are indexed automatically,
  overlapping file changes are no longer lost, and unsaved edits and helper
  changes on disk are reflected in completions right away.
- Turning off `enableCodeLens` removes lenses that are already shown.
- The debug log shows when a hover is ready and how its time splits between
  stages.

## 1.3.2

- Built-in Django models (`auth.User`, `Group`, `Permission`, `ContentType`,
  `Session`, `sites.Site`, `admin.LogEntry`) were added to the cache:
  previously any chain through `ForeignKey(User)` stopped there. A project
  model with the same name always wins; turn them off with the
  `includeBuiltinModels` setting.
- Fields are inherited from the built-in `AbstractUser` / `AbstractBaseUser` /
  `PermissionsMixin`: a custom user model now has `username`, `email`,
  `is_staff` and the rest.
- With several same-named models, the file's imports and its app are taken
  into account: in `sites/views_sites.py` the name `Site` no longer resolves
  to a model from another app.
- A variable assignment takes precedence over its name matching a model name.

## 1.3.1

- A variable's model is inferred from its assignment chain: `for x in <expression>`,
  `with ... as x`, the `sorted`/`list`/`reversed` wrappers, `get_object_or_404`
  and relations of another variable (`staff = site.employees.all()`).
- Fixed: `for item in staff:` was taken for a type annotation.

## 1.3.0

### Fixes

- Completion now works right after a dot (`client.`), not only after the first typed letter.
- Fields followed by a trailing comment (`name = models.CharField(max_length=10)  # name`) are no longer lost.
- Brackets and hashes inside strings and docstrings no longer break parsing of the rest of the file.
- `ForeignKey(to=Client)` is no longer resolved as a model named `to`.
- Models that inherit from abstract project models (`class Client(TimeStampedModel)`) are cached.
- `models.Manager()`, `models.Q()`, `models.Index()` and similar calls are no longer treated as fields.
- Assignments inside methods and nested classes are no longer treated as model fields.
- `class Meta(...)` inside a model no longer cuts off parsing of its fields.
- Same-named models in different apps no longer overwrite each other in the cache.
- The app name is detected correctly for an `app/models/*.py` package (it used to be `models`).
- Go to definition opens the right place: the cursor lands on the model or field name, and duplicate targets are removed.
- The broken QuickPick for choosing a definition was replaced by the standard VS Code list of targets.
- `ForeignKey('self')` and `settings.AUTH_USER_MODEL` resolve to real models.
- Reverse relations are built for self-relations, respect `%(class)s` / `%(app_label)s` and are not created for abstract models.
- A variable uses the nearest assignment above the cursor, not the last one matched by the list of patterns.
- The output channel and the rescan timer are released correctly on deactivation.
- Concurrent scans can no longer write a stale result to the cache.
- Removed the override of the `python` language in `contributes.languages` and fixed the extension's Marketplace category.

### New

- The `djangoModelNavigator.debug` setting for a detailed log, plus the `Show Log` and `Toggle Debug Logging` commands.
- The `excludePatterns`, `additionalFieldTypes`, `userModel`, `hoverMaxFields`, `maxDefinitionResults`, `enableDefinition`, `enableHover` and `enableCompletion` settings.
- Setting changes apply without reloading the window.
- Support for `self.field` inside model methods.
- A variable's model is inferred from its assignment chain: `for x in <expression>`,
  `with ... as x`, tuple unpacking, the `sorted`/`list`/`reversed` wrappers,
  `get_object_or_404` and relations of another variable
  (`staff = site.employees.all()`) are understood.
- Queryset lookup paths: completion, go to definition and hovers for
  `filter(client__profile__email=...)`, `order_by("-client__name")`,
  `values("client__name")`, `select_related(...)` and `Q(...)`, including
  lookups such as `__icontains` and `__gte`.
- The implicit `id` field and the `pk` alias that Django creates.
- The file's imports are used to resolve base classes and relation targets:
  `from shop.models import Client as ShopClient` now points to `shop.Client`,
  and same-named models from different apps are no longer confused.
- Fields without the `models.` prefix and field types from settings are supported.
- Hovers show `related_name`, the origin of an inherited field, the reverse relation and a link to the declaration.
- Completion lists own fields above inherited fields and reverse relations and shows documentation.
- `Find All References` for a model: relation fields that point to it and its subclasses;
  the `enableReferences` setting.
- A CodeLens above a model declaration with the number of fields, reverse relations and usages;
  the `enableCodeLens` setting.
- The cache includes unsaved edits of open files and updates when files are created or deleted.
- Saving a single `models.py` rereads only that file instead of the whole
  workspace; deleting a file removes only its models.
- A variable's model is cached per document version and limited to a window of 1000 lines above the cursor.
- Code parsing moved to `src/parser.ts`, `src/registry.ts` and `src/lookup.ts`
  and is covered by tests (`npm test`) that do not need to launch VS Code.
- Added the MIT license and a GitHub Actions build with tests.
- `package-lock.json` is kept in the repository, so builds and CI are reproducible (`npm ci`).
- Added ESLint with rules matching the project style (`npm run lint`); it also runs in CI and before packaging.

## 1.2.0

- Go to definition, hovers and completion for Django model fields.
