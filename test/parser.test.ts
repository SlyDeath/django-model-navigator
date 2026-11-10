/** Test Python parsing and model indexing without VS Code or a Django runtime */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import {
    analyzeSource,
    collectVariableBindings,
    parseFunctions,
    parseImports,
    parseModule,
    parsePythonFile,
    parseRelationArgs,
    sanitizeSource,
    splitTopLevelArgs
} from '../src/parser';
import {
    ParsedFile,
    appNameFromPath,
    buildModelIndex,
    findModelByName,
    findModelField,
    resolveFieldChain,
    resolveImportFile,
    walkLookupPath
} from '../src/registry';
import { ModelIndex, ModelInfo } from '../src/types';
import { group, test } from './harness';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');

const SHOP = path.join(FIXTURES, 'shop', 'models.py');
const ACCOUNTS = path.join(FIXTURES, 'accounts', 'models', 'user.py');
const BLOG = path.join(FIXTURES, 'blog', 'models.py');

function parseFixture(filePath: string): ParsedFile {
    const parsed = parseModule(filePath, fs.readFileSync(filePath, 'utf-8'));

    return { filePath, classes: parsed.classes, imports: parsed.imports };
}

function buildIndex(): ModelIndex {
    return buildModelIndex([parseFixture(SHOP), parseFixture(ACCOUNTS), parseFixture(BLOG)]);
}

function model(index: ModelIndex, name: string): ModelInfo {
    const found = findModelByName(index, name);

    assert.ok(found, `model ${name} not found in the index`);

    return found;
}

function fieldNames(target: ModelInfo): string[] {
    return target.fields.map(field => field.name);
}

group('sanitizeSource');

test('комментарии вырезаются, позиции символов сохраняются', () => {
    const [line] = sanitizeSource('x = f(1)  # (комментарий)');

    assert.strictEqual(line.length, 'x = f(1)  # (комментарий)'.length);
    assert.strictEqual(line.trimEnd(), 'x = f(1)');
});

test('содержимое однострочных литералов сохраняется', () => {
    const [line] = sanitizeSource('x = f("(%(class)s")');

    assert.strictEqual(line, 'x = f("(%(class)s")');
});

test('докстринг целиком маскируется', () => {
    const lines = sanitizeSource('"""\nclass Fake(models.Model):\n"""\nx = 1');

    assert.ok(/^[_ ]+$/.test(lines[1]), `docstring line is not masked: ${lines[1]}`);
    assert.strictEqual(lines[3], 'x = 1');
});

test('незакрытая скобка внутри строки не ломает разбор следующих полей', () => {
    const classes = parsePythonFile(
        'app/models.py',
        [
            'class A(models.Model):',
            '    a = models.TextField(help_text="(")',
            '    b = models.CharField(max_length=1)'
        ].join('\n')
    );

    assert.deepStrictEqual(classes[0].fields.map(field => field.name), ['a', 'b']);
});

test('докстринг на верхнем уровне не создаёт фантомную модель', () => {
    const classes = parsePythonFile(
        'app/models.py',
        ['"""', 'class Fake(models.Model):', '"""', 'x = 1'].join('\n')
    );

    assert.deepStrictEqual(classes, []);
});

group('splitTopLevelArgs / parseRelationArgs');

test('запятая внутри строки не разбивает аргументы', () => {
    assert.deepStrictEqual(
        splitTopLevelArgs('Client, help_text="a, b", choices=[(1, 2)]'),
        ['Client', 'help_text="a, b"', 'choices=[(1, 2)]']
    );
});

test('позиционный аргумент распознаётся как модель', () => {
    assert.strictEqual(
        parseRelationArgs('Client, on_delete=models.CASCADE').relatedModelRaw,
        'Client'
    );
});

test('kwarg to= распознаётся как модель', () => {
    assert.strictEqual(
        parseRelationArgs('to="accounts.User", on_delete=models.PROTECT').relatedModelRaw,
        'accounts.User'
    );
});

test('related_name=None отличается от отсутствующего related_name', () => {
    assert.strictEqual(parseRelationArgs('Client, related_name=None').relatedName, null);
    assert.strictEqual(parseRelationArgs('Client').relatedName, undefined);
});

group('parsePythonFile');

const shopClasses = parseFixture(SHOP).classes;

test('TextChoices и QuerySet не считаются моделями', () => {
    const index = buildIndex();

    assert.strictEqual(findModelByName(index, 'Status'), null);
    assert.strictEqual(findModelByName(index, 'ClientQuerySet'), null);
});

test('абстрактная база помечена флагом abstract', () => {
    const base = shopClasses.find(cls => cls.name === 'TimeStampedModel');

    assert.ok(base);
    assert.strictEqual(base.isAbstract, true);
});

test('proxy-модель помечена флагом proxy', () => {
    const proxy = parseFixture(ACCOUNTS).classes.find(cls => cls.name === 'LegacyProfile');

    assert.ok(proxy);
    assert.strictEqual(proxy.isProxy, true);
});

test('поле с комментарием в конце строки не теряется', () => {
    const client = shopClasses.find(cls => cls.name === 'Client');

    assert.ok(client);
    assert.ok(client.fields.some(field => field.name === 'name' && field.type === 'CharField'));
});

test('присваивания внутри методов не попадают в поля', () => {
    const client = shopClasses.find(cls => cls.name === 'Client');

    assert.ok(client);
    assert.ok(!client.fields.some(field => field.name === 'title'));
});

test('менеджеры и прочие вызовы не считаются полями', () => {
    const client = shopClasses.find(cls => cls.name === 'Client');

    assert.ok(client);
    assert.ok(!client.fields.some(field => field.name === 'objects'));
});

test('многострочное объявление поля разбирается', () => {
    const client = shopClasses.find(cls => cls.name === 'Client');
    const owner = client?.fields.find(field => field.name === 'owner');

    assert.ok(owner);
    assert.strictEqual(owner.type, 'ForeignKey');
    assert.strictEqual(owner.relatedName, 'clients');
});

test('запоминается позиция объявления поля', () => {
    const client = shopClasses.find(cls => cls.name === 'Client');
    const name = client?.fields.find(field => field.name === 'name');
    const lines = fs.readFileSync(SHOP, 'utf-8').split('\n');

    assert.ok(name?.sourceLine !== undefined && name.sourceColumn !== undefined);
    assert.strictEqual(
        lines[name.sourceLine].slice(name.sourceColumn, name.sourceColumn + 4),
        'name'
    );
});

group('buildModelIndex');

test('имя приложения берётся из каталога пакета, а не из models/', () => {
    assert.strictEqual(appNameFromPath(SHOP), 'shop');
    assert.strictEqual(appNameFromPath(ACCOUNTS), 'accounts');
});

test('модель, унаследованная от локальной абстрактной базы, попадает в индекс', () => {
    const index = buildIndex();

    assert.ok(findModelByName(index, 'Client'));
    assert.ok(findModelByName(index, 'Review'));
});

test('унаследованные поля подтягиваются из абстрактной базы', () => {
    const client = model(buildIndex(), 'Client');

    assert.ok(fieldNames(client).includes('created_at'));
    assert.strictEqual(
        client.fields.find(field => field.name === 'created_at')?.isInherited,
        true
    );
});

test("ForeignKey('self') разрешается в саму модель", () => {
    const client = model(buildIndex(), 'Client');
    const parent = client.fields.find(field => field.name === 'parent');

    assert.strictEqual(parent?.relatedModel, 'Client');
    assert.ok(fieldNames(client).includes('children'));
});

test('settings.AUTH_USER_MODEL разрешается в кастомную модель пользователя', () => {
    const client = model(buildIndex(), 'Client');
    const owner = client.fields.find(field => field.name === 'owner');

    assert.strictEqual(owner?.relatedModel, 'User');
});

test('обратная связь появляется у целевой модели', () => {
    const index = buildIndex();
    const user = model(index, 'User');

    assert.ok(fieldNames(user).includes('clients'));
});

test("related_name='+' не создаёт обратной связи", () => {
    const user = model(buildIndex(), 'User');

    assert.ok(!fieldNames(user).includes('client_set'));
});

test('обратная связь без related_name получает суффикс _set', () => {
    const client = model(buildIndex(), 'Client');

    assert.ok(fieldNames(client).includes('review_set'));
});

test('OneToOneField даёт обратную связь без суффикса', () => {
    const profile = model(buildIndex(), 'Profile');

    assert.ok(fieldNames(profile).includes('review'));
    assert.ok(fieldNames(profile).includes('user'));
});

test('шаблон %(class)s в related_name раскрывается', () => {
    const tag = model(buildIndex(), 'Tag');

    assert.ok(fieldNames(tag).includes('review_items'));
});

test('абстрактная модель не получает обратных связей', () => {
    const index = buildIndex();
    const base = index.models.find(item => item.name === 'TimeStampedModel');

    assert.ok(base);
    assert.strictEqual(base.isAbstract, true);
    assert.ok(!base.fields.some(field => field.isReverse));
});

group('resolveFieldChain');

test('цепочка связей проходит до нужной модели', () => {
    const index = buildIndex();
    const review = model(index, 'Review');

    const target = resolveFieldChain(index, review, ['profile']);

    assert.strictEqual(target?.name, 'Profile');
});

test('цепочка через обратную связь работает', () => {
    const index = buildIndex();
    const client = model(index, 'Client');

    const target = resolveFieldChain(index, client, ['review_set', 'profile']);

    assert.strictEqual(target?.name, 'Profile');
});

test('обычное поле обрывает цепочку', () => {
    const index = buildIndex();
    const review = model(index, 'Review');

    assert.strictEqual(resolveFieldChain(index, review, ['text', 'anything']), null);
});

group('parseImports');

test('импорты с псевдонимами и в скобках разбираются', () => {
    const imports = parseImports(fs.readFileSync(BLOG, 'utf-8'));

    const alias = imports.find(entry => entry.local === 'ShopClient');

    assert.strictEqual(alias?.original, 'Client');
    assert.strictEqual(alias.module, 'shop.models');
    assert.strictEqual(alias.level, 0);

    assert.ok(imports.some(entry => entry.local === 'Review' && entry.module === 'shop.models'));
});

test('относительный импорт сохраняет уровень', () => {
    const imports = parseImports('from ..common.models import Base\n');

    assert.strictEqual(imports[0].level, 2);
    assert.strictEqual(imports[0].module, 'common.models');
});

test('import * пропускается', () => {
    assert.deepStrictEqual(parseImports('from shop.models import *\n'), []);
});

test('импорт внутри функции не учитывается', () => {
    assert.deepStrictEqual(parseImports('def f():\n    from shop.models import Client\n'), []);
});

group('resolveImportFile');

test('абсолютный импорт находит файл по хвосту пути', () => {
    const resolved = resolveImportFile(
        { local: 'Client', original: 'Client', module: 'shop.models', level: 0 },
        BLOG,
        [SHOP, ACCOUNTS, BLOG]
    );

    assert.strictEqual(resolved, SHOP);
});

test('относительный импорт считается от каталога файла', () => {
    const resolved = resolveImportFile(
        { local: 'User', original: 'User', module: 'user', level: 1 },
        path.join(FIXTURES, 'accounts', 'models', '__init__.py'),
        [SHOP, ACCOUNTS]
    );

    assert.strictEqual(resolved, ACCOUNTS);
});

test('неоднозначный импорт ничего не уточняет', () => {
    const resolved = resolveImportFile(
        { local: 'Tag', original: 'Tag', module: 'models', level: 0 },
        BLOG,
        [SHOP, BLOG]
    );

    assert.strictEqual(resolved, undefined);
});

group('разрешение одноимённых моделей');

test('связь без импорта указывает на модель из того же файла', () => {
    const index = buildIndex();
    const post = model(index, 'Post');
    const tag = post.fields.find(field => field.name === 'tag');

    assert.strictEqual(tag?.relatedModel, 'Tag');

    const target = tag.relatedModelKey ? index.byKey.get(tag.relatedModelKey) : null;

    assert.strictEqual(target?.appName, 'blog');
});

test('импорт с псевдонимом указывает на модель другого приложения', () => {
    const index = buildIndex();
    const post = model(index, 'Post');
    const client = post.fields.find(field => field.name === 'client');

    assert.strictEqual(client?.relatedModel, 'Client');

    const target = client.relatedModelKey ? index.byKey.get(client.relatedModelKey) : null;

    assert.strictEqual(target?.appName, 'shop');
});

test('обратная связь попадает в модель из нужного приложения', () => {
    const index = buildIndex();

    const shopTag = index.models.find(item => item.name === 'Tag' && item.appName === 'shop');
    const blogTag = index.models.find(item => item.name === 'Tag' && item.appName === 'blog');

    assert.ok(shopTag && blogTag);

    // Post.shop_tag targets shop.Tag; Post.tag targets blog.Tag
    assert.ok(fieldNames(shopTag).includes('posts'), 'shop.Tag не получил обратную связь posts');
    assert.ok(!fieldNames(shopTag).includes('posts_by_tag'), 'в shop.Tag попала чужая связь');
    assert.ok(fieldNames(blogTag).includes('posts_by_tag'), 'blog.Tag не получил posts_by_tag');
    assert.ok(!fieldNames(blogTag).includes('posts'), 'в blog.Tag попала чужая связь');
});

test('цепочка идёт по модели из импорта', () => {
    const index = buildIndex();
    const post = model(index, 'Post');

    const target = resolveFieldChain(index, post, ['client', 'owner']);

    assert.strictEqual(target?.name, 'User');
});

group('встроенные модели Django');

test('встроенные модели попадают в индекс', () => {
    const index = buildIndex();

    assert.ok(findModelByName(index, 'Group'));
    assert.ok(findModelByName(index, 'ContentType'));
    assert.ok(findModelByName(index, 'Permission'));
});

test('своя модель вытесняет встроенную', () => {
    const index = buildIndex();
    const users = index.byLowerName.get('user') ?? [];

    assert.strictEqual(users.length, 1);
    assert.strictEqual(users[0].isBuiltin, false);
    assert.strictEqual(users[0].appName, 'accounts');
});

test('поля наследуются от встроенного AbstractUser', () => {
    const user = model(buildIndex(), 'User');

    assert.ok(fieldNames(user).includes('username'), 'нет поля username');
    assert.ok(fieldNames(user).includes('email'), 'нет поля email');
    assert.ok(fieldNames(user).includes('is_staff'), 'нет поля is_staff');
    assert.ok(fieldNames(user).includes('phone'), 'потеряно своё поле');
});

test('встроенные модели можно отключить', () => {
    const index = buildModelIndex(
        [parseFixture(SHOP), parseFixture(ACCOUNTS), parseFixture(BLOG)],
        { includeBuiltins: false }
    );

    assert.strictEqual(findModelByName(index, 'Group'), null);
});

test('у встроенной модели нет файла в проекте', () => {
    const group = model(buildIndex(), 'Group');

    assert.strictEqual(group.isBuiltin, true);
    assert.strictEqual(group.fullName, 'auth.models.Group');
});

test('связь на встроенную модель разрешается', () => {
    const index = buildIndex();
    const permission = model(index, 'Permission');
    const contentType = permission.fields.find(field => field.name === 'content_type');

    assert.strictEqual(contentType?.relatedModel, 'ContentType');
    assert.ok(fieldNames(model(index, 'ContentType')).includes('permission_set'));
});

test('встроенные группы и права пользователя повторяют related_name из django.contrib.auth', () => {
    // PermissionsMixin: related_name="user_set", related_query_name="user"; LogEntry.user is
    // ForeignKey(settings.AUTH_USER_MODEL)
    const index = buildModelIndex([sourceFile('people', 'class Account(AbstractUser):\n    pass')]);
    const group = model(index, 'Group');
    const reverse = group.fields.find(field => field.name === 'user_set');

    assert.ok(!fieldNames(group).includes('account_set'));
    assert.strictEqual(reverse?.relatedModel, 'Account');
    assert.strictEqual(reverse.queryName, 'user');
    assert.ok(fieldNames(model(index, 'Permission')).includes('user_set'));
    assert.strictEqual(resolveFieldChain(index, model(index, 'LogEntry'), ['user'])?.name, 'Account');
});

test('модель вне индекса не подменяется одноимённой моделью проекта', () => {
    // taggit.Tag lives in an unindexed third-party package, not in the catalog app
    const index = buildModelIndex([
        sourceFile('catalog', 'class Tag(models.Model):\n    title = models.CharField()'),
        sourceFile('shop', 'from taggit.models import Tag\nclass Product(models.Model):\n    tags = models.ManyToManyField("taggit.Tag")\n    tag = models.ForeignKey(Tag, on_delete=models.CASCADE)')
    ]);
    const product = model(index, 'Product');

    assert.strictEqual(resolveFieldChain(index, product, ['tags']), null);
    assert.strictEqual(resolveFieldChain(index, product, ['tag']), null);
    assert.ok(!fieldNames(model(index, 'Tag')).includes('product_set'));
});

test('импорт из пакета моделей разрешает связь и базу через __init__', () => {
    const index = buildModelIndex([
        sourceFile('catalog', 'class Tag(models.Model):\n    title = models.CharField()\nclass Base(models.Model):\n    created = models.DateTimeField()\n    class Meta:\n        abstract = True', path.join('models', 'tag.py')),
        sourceFile('archive', 'class Tag(models.Model):\n    old = models.CharField()\nclass Base(models.Model):\n    old = models.CharField()\n    class Meta:\n        abstract = True'),
        sourceFile('shop', 'from catalog.models import Base, Tag\nclass Product(Base):\n    tag = models.ForeignKey(Tag, on_delete=models.CASCADE)')
    ]);
    const product = model(index, 'Product');

    assert.strictEqual(resolveFieldChain(index, product, ['tag'])?.appName, 'catalog');
    assert.ok(fieldNames(product).includes('created'));
});

group('регрессии разрешения моделей и полей');

/** Parse an in-memory module at a representative app path */
function sourceFile(app: string, source: string, name = 'models.py'): ParsedFile {
    const filePath = path.join(FIXTURES, app, name);

    return { filePath, ...parseModule(filePath, source) };
}

test('стандартный AUTH_USER_MODEL указывает на конкретного auth.User', () => {
    const index = buildModelIndex([sourceFile('posts', [
        'class Entry(models.Model):',
        '    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="entries")'
    ].join('\n'))]);
    const target = resolveFieldChain(index, model(index, 'Entry'), ['author']);

    assert.strictEqual(target?.name, 'User');
    assert.strictEqual(target.isAbstract, false);
    assert.ok(fieldNames(target).includes('id'));
    assert.ok(fieldNames(target).includes('entries'));
});

test('конкретный пользователь находится через промежуточную абстрактную базу', () => {
    const index = buildModelIndex([sourceFile('people', [
        'class BasePerson(AbstractUser):',
        '    class Meta:',
        '        abstract = True',
        'class Person(BasePerson):',
        '    pass',
        'class Entry(models.Model):',
        '    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)'
    ].join('\n'))]);

    assert.strictEqual(resolveFieldChain(index, model(index, 'Entry'), ['author'])?.name, 'Person');
});

test('proxy и наследник пользователя не становятся AUTH_USER_MODEL при любом порядке файлов', () => {
    // settings.AUTH_USER_MODEL names the swappable model itself, not its subclasses
    const users = sourceFile('accounts', 'class User(AbstractUser):\n    pass');
    const staff = sourceFile('staff', 'from accounts.models import User\nclass StaffUser(User):\n    class Meta:\n        proxy = True\nclass Manager(User):\n    level = models.IntegerField()');
    const orders = sourceFile('orders', 'class Order(models.Model):\n    buyer = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)');

    for (const files of [[staff, users, orders], [users, staff, orders]]) {
        const index = buildModelIndex(files);
        const target = resolveFieldChain(index, model(index, 'Order'), ['buyer']);

        assert.strictEqual(target?.name, 'User');
        assert.strictEqual(target.appName, 'accounts');
    }
});

test('обратная связь сохраняет владельца при совпадающих именах моделей', () => {
    const index = buildModelIndex([
        sourceFile('catalog', 'class Label(models.Model):\n    title = models.CharField()\nclass Entry(models.Model):\n    local = models.CharField()'),
        sourceFile('journal', 'from catalog.models import Label\nclass Entry(models.Model):\n    label = models.ForeignKey(Label, on_delete=models.CASCADE, related_name="journal_entries")\n    body = models.TextField()')
    ]);
    const target = resolveFieldChain(index, model(index, 'Label'), ['journal_entries']);

    assert.strictEqual(target?.appName, 'journal');
    assert.ok(fieldNames(target).includes('body'));
});

test('квалифицированная база проекта сохраняет унаследованные поля', () => {
    const index = buildModelIndex([
        sourceFile('common', 'class Base(models.Model):\n    created = models.DateTimeField()\n    class Meta:\n        abstract = True'),
        sourceFile('journal', 'from common import models as common\nclass Entry(common.Base):\n    title = models.CharField()')
    ]);

    assert.ok(fieldNames(model(index, 'Entry')).includes('created'));
});

test('унаследованная связь разрешает alias в файле объявления', () => {
    const index = buildModelIndex([
        sourceFile('catalog', 'class Label(models.Model):\n    title = models.CharField()'),
        sourceFile('common', 'from catalog.models import Label as CatalogLabel\nclass Base(models.Model):\n    label = models.ForeignKey(CatalogLabel, on_delete=models.CASCADE, related_name="%(class)s_entries")\n    class Meta:\n        abstract = True'),
        sourceFile('journal', 'from common.models import Base\nclass Entry(Base):\n    pass')
    ]);
    const target = resolveFieldChain(index, model(index, 'Entry'), ['label']);

    assert.strictEqual(target?.appName, 'catalog');
    assert.ok(fieldNames(target).includes('entry_entries'));
});

test('строковая связь использует приложение, а Python-ссылка — импорт', () => {
    const index = buildModelIndex([
        sourceFile('catalog', 'class Label(models.Model):\n    title = models.CharField()'),
        sourceFile('journal', 'class Label(models.Model):\n    body = models.TextField()', path.join('models', 'label.py')),
        sourceFile('journal', 'from catalog.models import Label\nclass Entry(models.Model):\n    lazy = models.ForeignKey("Label", on_delete=models.CASCADE, related_name="lazy_entries")\n    eager = models.ForeignKey(Label, on_delete=models.CASCADE, related_name="eager_entries")', path.join('models', 'entry.py'))
    ]);
    const entry = model(index, 'Entry');

    assert.strictEqual(resolveFieldChain(index, entry, ['lazy'])?.appName, 'journal');
    assert.strictEqual(resolveFieldChain(index, entry, ['eager'])?.appName, 'catalog');
});

test('строковая связь абстрактной базы разрешается в приложении наследника', () => {
    const index = buildModelIndex([
        sourceFile('common', 'class Label(models.Model):\n    old = models.CharField()\nclass Base(models.Model):\n    label = models.ForeignKey("Label", on_delete=models.CASCADE, related_name="%(class)s_entries")\n    parent = models.ForeignKey("self", on_delete=models.CASCADE)\n    class Meta:\n        abstract = True'),
        sourceFile('journal', 'from common.models import Base\nclass Label(models.Model):\n    current = models.CharField()\nclass Entry(Base):\n    pass')
    ]);
    const entry = model(index, 'Entry');

    assert.strictEqual(resolveFieldChain(index, entry, ['label'])?.appName, 'journal');
    assert.strictEqual(resolveFieldChain(index, entry, ['parent'])?.key, entry.key);
});

test('строковая связь конкретного родителя разрешается в его приложении', () => {
    // Django copies fields only from abstract bases; a concrete parent keeps its own field
    const index = buildModelIndex([
        sourceFile('places', 'class Owner(models.Model):\n    name = models.CharField()\nclass Place(models.Model):\n    owner = models.ForeignKey("Owner", on_delete=models.CASCADE)\n    parent = models.ForeignKey("self", on_delete=models.CASCADE)'),
        sourceFile('restaurants', 'from places.models import Place\nclass Owner(models.Model):\n    other = models.CharField()\nclass Restaurant(Place):\n    pass\nclass PlaceProxy(Place):\n    class Meta:\n        proxy = True')
    ]);

    for (const name of ['Restaurant', 'PlaceProxy']) {
        const child = model(index, name);

        assert.strictEqual(resolveFieldChain(index, child, ['owner'])?.appName, 'places', name);
        assert.strictEqual(resolveFieldChain(index, child, ['parent'])?.name, 'Place', name);
    }
});

test('наследник конкретной модели не добавляет обратный аксессор её связи', () => {
    // The parent's field is not copied into a multi-table child, so Owner has no restaurant_set
    const index = buildModelIndex([
        sourceFile('places', 'class Owner(models.Model):\n    name = models.CharField()\nclass Place(models.Model):\n    owner = models.ForeignKey(Owner, on_delete=models.CASCADE)\nclass Restaurant(Place):\n    pass')
    ]);
    const names = fieldNames(model(index, 'Owner'));

    assert.ok(names.includes('place_set'));
    assert.ok(!names.includes('restaurant_set'));
});

test('обратная связь получает имя для lookup по правилам related_query_name', () => {
    // Django: related_query_name, else related_name, else the lowercase model name
    const index = buildModelIndex([sourceFile('journal', [
        'class Label(models.Model):',
        '    title = models.CharField()',
        'class Entry(models.Model):',
        '    label = models.ForeignKey(Label, on_delete=models.CASCADE)',
        'class Note(models.Model):',
        '    label = models.ForeignKey(Label, on_delete=models.CASCADE, related_name="notes")',
        'class Tag(models.Model):',
        '    label = models.ForeignKey(Label, on_delete=models.CASCADE, related_name="tags", related_query_name="%(class)s_tag")'
    ].join('\n'))]);
    const label = model(index, 'Label');
    const queryNames = Object.fromEntries(label.fields.filter(field => field.isReverse)
        .map(field => [field.name, field.queryName]));

    assert.deepStrictEqual(queryNames, { entry_set: 'entry', notes: 'notes', tags: 'tag_tag' });
    assert.strictEqual(walkLookupPath(index, label, ['entry', 'id'])[1].field?.name, 'id');
    assert.strictEqual(walkLookupPath(index, label, ['entry_set'])[0].field, null);
    assert.strictEqual(walkLookupPath(index, label, ['entry_set'], true)[0].field?.name, 'entry_set');
});

test('текст primary_key=True внутри строки не заменяет неявный id', () => {
    const index = buildModelIndex([sourceFile('journal', 'class Entry(models.Model):\n    title = models.CharField(max_length=100, help_text="Use primary_key=True for natural keys")')]);
    const entry = model(index, 'Entry');

    assert.ok(fieldNames(entry).includes('id'));
    assert.ok(!entry.fields.find(field => field.name === 'title')?.isPrimaryKey);
    assert.strictEqual(findModelField(entry, 'pk')?.name, 'id');
});

test('primary_key читается только из верхнеуровневого аргумента', () => {
    const classes = parsePythonFile(SHOP, 'class Entry(models.Model):\n    code = models.CharField(primary_key=True)\n    title = models.CharField(validators=[validator(primary_key=True)])');

    assert.strictEqual(classes[0].fields[0].isPrimaryKey, true);
    assert.ok(!classes[0].fields[1].isPrimaryKey);
});

test('неотступленный текст docstring не завершает тело модели', () => {
    const classes = parsePythonFile(SHOP, 'class Entry(models.Model):\n    """Entry.\nUnindented documentation.\n    """\n    title = models.CharField(max_length=100)\nclass Next(models.Model):\n    body = models.TextField()');

    assert.deepStrictEqual(classes[0].fields.map(field => field.name), ['title']);
    assert.strictEqual(classes[0].fields[0].sourceLine, 4);
    assert.strictEqual(classes[0].fields[0].sourceColumn, 4);
    assert.deepStrictEqual(classes[1].fields.map(field => field.name), ['body']);
});

group('возвраты функций');

test('return вложенной функции с многострочным заголовком не приписывается внешней', () => {
    const functions = parseFunctions([
        'def outer():',
        '    def inner(',
        '        value,',
        '    ):',
        '        return Client.objects.get(pk=value)',
        '    inner(1)',
        '    return None'
    ].join('\n'));

    assert.deepStrictEqual(functions[0].returns.map(item => item.expressions), [['None']]);
});

test('return в стиле Black читается до конца логической строки', () => {
    const functions = parseFunctions([
        'def pick(pk):',
        '    return Review.objects.get(',
        '        pk=pk',
        '    ).client',
        'def ids():',
        '    return Client.objects.filter(',
        '        name="a"',
        '    ).values_list("id", flat=True)',
        'def pair():',
        '    return Client.objects.get(',
        '        pk=1',
        '    ), 1',
        'def joined():',
        '    return Client.objects \\',
        '        .first()'
    ].join('\n'));
    const expressions = functions.map(fn => fn.returns[0].expressions.map(text =>
        text.replace(/\s+/g, '')));

    assert.deepStrictEqual(expressions[0], ['Review.objects.get(pk=pk).client']);
    assert.deepStrictEqual(expressions[1], ['Client.objects.filter(name="a").values_list("id",flat=True)']);
    assert.deepStrictEqual(expressions[2], ['Client.objects.get(pk=1)', '1']);
    assert.strictEqual(functions[2].returns[0].tuple, true);
    assert.deepStrictEqual(expressions[3], ['Client.objects.first()']);
});

test('многострочный return сохраняет отдельные позиции кортежа', () => {
    const functions = parseFunctions([
        'def get_rows(request):',
        '    query = Client.objects.all()',
        '    return (',
        '        request.GET.get("filter"),',
        '        query,',
        '    )'
    ].join('\n'));

    assert.strictEqual(functions.length, 1);
    assert.strictEqual(functions[0].name, 'get_rows');
    assert.deepStrictEqual(functions[0].returns[0].expressions,
        ['request.GET.get("filter")', 'query']);
    assert.strictEqual(functions[0].returns[0].tuple, true);
});

test('аннотация и return вложенной функции не смешиваются с внешней', () => {
    const functions = parseFunctions([
        'def get_rows(',
        '    request,',
        ') -> QuerySet[Client]:',
        '    def nested():',
        '        return Profile.objects.all()',
        '    return Client.objects.all()'
    ].join('\n'));

    assert.strictEqual(functions[0]?.annotation, 'QuerySet[Client]');
    assert.strictEqual(functions[0].returns.length, 1);
    assert.deepStrictEqual(functions[0].returns[0].expressions, ['Client.objects.all()']);
});

group('время разбора длинных строк');

/** Parsing runs on the shared extension host thread, so long lines must stay linear */
function elapsed(run: () => unknown): number {
    const startedAt = Date.now();

    run();

    return Date.now() - startedAt;
}

test('длинная серия пробелов в сигнатуре не замедляет разбор', () => {
    const source = 'def f() ->' + ' '.repeat(1500) + '\n';

    assert.ok(elapsed(() => analyzeSource(source)) < 200);
});

for (const line of ['        "' + 'x'.repeat(40000) + '",', 'with patch("' + 'x'.repeat(40000) + '"):',
    'x = 1; "' + 'x'.repeat(40000) + '"']) {
    test(`поиск присваиваний линеен на строке ${line.slice(0, 12)}…`, () => {
        const source = ['client = Client.objects.first()', line, 'client.'].join('\n');
        const syntax = analyzeSource(source);

        assert.ok(elapsed(() => collectVariableBindings(syntax, 'client', 0, 2, 7)) < 200);
    });
}
