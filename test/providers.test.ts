/** Test editor providers through the VS Code stub: completions, definitions and hovers */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import { group, test, testAsync } from './harness';
import * as stub from './vscode-stub';

// Replace vscode before loading the extension so all providers share this stub
const Module = require('module');
const originalLoad = Module._load;

Module._load = function (request: string, ...rest: unknown[]): unknown {
    if (request === 'vscode') return stub;
    if (request === 'fs/promises') return stub.localFiles;

    return originalLoad.call(this, request, ...rest);
};

const extension = require('../src/extension');

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');
const SHOP = path.join(FIXTURES, 'shop', 'models.py');
const ACCOUNTS = path.join(FIXTURES, 'accounts', 'models', 'user.py');
const BLOG = path.join(FIXTURES, 'blog', 'models.py');

const UTILS = path.join(FIXTURES, 'shop', 'utils.py');

stub.setWorkspaceFiles([SHOP, ACCOUNTS, BLOG, UTILS]);

export const subscriptions: { dispose(): unknown }[] = [];

extension.activate({ subscriptions });

/** Share the loaded extension with the sequential store tests */
export const extensionModule = extension;

const ready = stub.commands.executeCommand('djangoModelNavigator.updateCache');

function doc(lines: string[]): stub.TextDocument {
    return new stub.TextDocument(path.join(FIXTURES, 'shop', 'views.py'), lines.join('\n'));
}

/** Return the position after the first occurrence of a marker */
function cursorAfter(lines: string[], needle: string): stub.Position {
    const line = lines.findIndex(text => text.includes(needle));

    assert.ok(line >= 0, `"${needle}" not found in the document`);

    return new stub.Position(line, lines[line].indexOf(needle) + needle.length);
}

function completionsFor(lines: string[], needle: string): string[] {
    const items = stub.registered.completion[0].provideCompletionItems(
        doc(lines),
        cursorAfter(lines, needle)
    );

    return (items ?? []).map((item: stub.CompletionItem) => item.label);
}

function definitionsFor(lines: string[], needle: string): stub.Location[] {
    const result = stub.registered.definition[0].provideDefinition(
        doc(lines),
        cursorAfter(lines, needle)
    );

    if (!result) return [];

    return Array.isArray(result) ? result : [result];
}

function referencesFor(lines: string[], needle: string): stub.Location[] {
    return (
        stub.registered.references[0].provideReferences(doc(lines), cursorAfter(lines, needle), {
            includeDeclaration: true
        }) ?? []
    );
}

function lineOf(location: stub.Location): string {
    return stub.TextDocument.fromFile(location.uri.fsPath)
        .lineAt(location.range.start.line)
        .text;
}

function hoverFor(lines: string[], needle: string): string | null {
    const result = stub.registered.hover[0].provideHover(doc(lines), cursorAfter(lines, needle));

    return result ? result.contents.value : null;
}

/** Run provider assertions only after the initial index is ready */
export const done = ready.then(async () => {
    group('autocomplete');

    test('сразу после точки предлагаются поля модели', () => {
        const lines = ['client = Client.objects.first()', 'print(client.)'];
        const labels = completionsFor(lines, 'client.');

        assert.ok(labels.includes('name'), `нет поля name: ${labels.join(', ')}`);
        assert.ok(labels.includes('created_at'), 'нет унаследованного поля');
        assert.ok(labels.includes('review_set'), 'нет обратной связи');
    });

    test('после начала имени поля предложения те же', () => {
        const lines = ['client = Client.objects.first()', 'print(client.na)'];

        assert.ok(completionsFor(lines, 'client.na').includes('name'));
    });

    test('цепочка связей продолжается', () => {
        const lines = ['review = Review.objects.first()', 'print(review.client.)'];
        const labels = completionsFor(lines, 'review.client.');

        assert.ok(labels.includes('name'));
        assert.ok(!labels.includes('text'), 'предложены поля Review вместо Client');
    });

    test('свои поля сортируются выше обратных связей', () => {
        const lines = ['client = Client.objects.first()', 'print(client.)'];

        const items: stub.CompletionItem[] = stub.registered.completion[0].provideCompletionItems(
            doc(lines),
            cursorAfter(lines, 'client.')
        );

        const own = items.find(item => item.label === 'name');
        const reverse = items.find(item => item.label === 'review_set');

        assert.ok(own?.sortText && reverse?.sortText);
        assert.ok(own.sortText < reverse.sortText);
    });

    test('в корне выражения автокомплит не вмешивается', () => {
        const lines = ['client = Client.objects.first()', 'print(clie)'];

        assert.deepStrictEqual(completionsFor(lines, 'clie'), []);
    });

    test('аннотация типа тоже определяет модель', () => {
        const lines = ['def handle(review: Review):', '    print(review.)'];

        assert.ok(completionsFor(lines, 'review.').includes('text'));
    });

    test('for-цикл определяет модель', () => {
        const lines = ['for review in Review.objects.all():', '    print(review.)'];

        assert.ok(completionsFor(lines, 'review.').includes('text'));
    });

    await testAsync('self внутри модели определяет модель', async () => {
        const document = stub.TextDocument.fromFile(SHOP);
        const lines = document.getText().split('\n');
        const line = lines.findIndex(text => text.includes('return self.name'));

        const items = await stub.registered.completion[0].provideCompletionItems(
            document,
            new stub.Position(line, lines[line].indexOf('self.') + 'self.'.length)
        );

        const labels = (items ?? []).map((item: stub.CompletionItem) => item.label);

        assert.ok(labels.includes('name'), `нет поля name: ${labels.join(', ')}`);
    });

    group('переменные из связей');

    test('переменная из обратной связи другой переменной', () => {
        const lines = [
            'client = Client.objects.first()',
            'staff = client.employees.all()',
            'for item in staff:',
            '    print(item.)'
        ];

        const labels = completionsFor(lines, 'item.');

        assert.ok(labels.includes('rate'), `нет поля rate: ${labels.join(', ')}`);
    });

    test('цепочка через несколько переменных и sorted', () => {
        const lines = [
            'query = Client.objects.filter(name="x")',
            'rows = query.order_by("name").all()',
            'rows = sorted(rows, key=lambda entry: entry.name)',
            'for row in rows:',
            '    staff = row.employees.all()',
            '    for item in staff:',
            '        print(item.profile.)'
        ];

        const labels = completionsFor(lines, 'item.profile.');

        assert.ok(labels.includes('email'), `нет поля email: ${labels.join(', ')}`);
    });

    test('переход к определению сквозь цепочку переменных', () => {
        const lines = [
            'client = Client.objects.first()',
            'staff = client.employees.all()',
            'for item in staff:',
            '    print(item.rate)'
        ];

        const locations = definitionsFor(lines, 'item.rate');

        assert.strictEqual(locations.length, 1);
        assert.ok(lineOf(locations[0]).includes('rate = models.DecimalField'));
    });

    test('get_object_or_404 определяет модель', () => {
        const lines = ['obj = get_object_or_404(Client, pk=1)', 'print(obj.)'];

        assert.ok(completionsFor(lines, 'obj.').includes('name'));
    });

    test('with ... as определяет модель', () => {
        const lines = ['with Client.objects.first() as entry:', '    print(entry.)'];

        assert.ok(completionsFor(lines, 'entry.').includes('name'));
    });

    test('lookup-путь от переменной из цепочки', () => {
        const lines = [
            'client = Client.objects.first()',
            'staff = client.employees.all()',
            'print(staff.filter(profile__))'
        ];

        assert.ok(completionsFor(lines, 'profile__').includes('email'));
    });

    test('взаимные присваивания не зацикливают разбор', () => {
        const lines = ['first = second', 'second = first', 'print(first.)'];

        assert.deepStrictEqual(completionsFor(lines, 'first.'), []);
    });

    test('присваивание атрибуту не считается присваиванием переменной', () => {
        const lines = ['self.entry = Client.objects.first()', 'print(entry.)'];

        assert.deepStrictEqual(completionsFor(lines, 'entry.'), []);
    });

    test('переход по импортированному псевдониму ведёт к исходной модели', () => {
        const locations = definitionsFor([
            'from shop.models import Client as ShopClient',
            'entry = ShopClient.objects.first()'
        ], 'entry = ShopClient');

        assert.strictEqual(locations.length, 1);
        assert.strictEqual(locations[0].uri.fsPath, SHOP);
        assert.ok(lineOf(locations[0]).includes('class Client('));
    });

    test('вложенное присваивание важнее совпадения имени с моделью', () => {
        const labels = completionsFor([
            'client = Profile.objects.first()',
            'item = client',
            'print(item.)'
        ], 'item.');

        assert.ok(labels.includes('email'));
        assert.ok(!labels.includes('name'));
    });

    test('переприсваивание источника не меняет ранее полученный queryset', () => {
        const labels = completionsFor([
            'query = Client.objects.all()',
            'items = query',
            'query = Profile.objects.all()',
            'for item in items:',
            '    print(item.)'
        ], 'item.');

        assert.ok(labels.includes('name'));
        assert.ok(!labels.includes('email'));
    });

    group('результаты функций');

    test('аннотация параметра со значением по умолчанию в многострочной сигнатуре', () => {
        const lines = ['def view(', '    client: Client | None = None,', '):', '    client.'];
        const body = ['def view(', '    client: Client | None = None,', '):',
            '    client = Profile.objects.first()', '    client.'];

        assert.ok(completionsFor(lines, '    client.').includes('name'));
        // An assignment in the body still wins over the parameter annotation
        assert.ok(completionsFor(body, '    client.').includes('email'));
    });

    test('многострочный return с хвостом цепочки не подменяет модель', () => {
        const lines = ['def pick(pk):', '    return Review.objects.get(', '        pk=pk',
            '    ).client', 'row = pick(1)', 'row.text'];
        const shaped = ['def ids():', '    return Client.objects.filter(', '        name="a"',
            '    ).values_list("id", flat=True)', 'row = ids()', 'row.name'];

        // The result is a Client, never the Review that starts the chain
        assert.strictEqual(hoverFor(lines, 'row.text'), null);
        assert.strictEqual(hoverFor(shaped, 'row.name'), null);
    });

    test('модель результата локальной функции выводится из return', () => {
        const labels = completionsFor([
            'def get_entry():',
            '    return Profile.objects.first()',
            'item = get_entry()',
            'item.'
        ], 'item.');

        assert.ok(labels.includes('email'));
    });

    test('аннотация возврата используется для локальной функции', () => {
        const labels = completionsFor([
            'def get_entry() -> Profile:',
            '    return external_service()',
            'item = get_entry()',
            'item.'
        ], 'item.');

        assert.ok(labels.includes('email'));
    });

    test('разные модели в return не дают ложного определения', () => {
        const labels = completionsFor([
            'def get_entry(flag):',
            '    if flag:',
            '        return Client.objects.first()',
            '    return Profile.objects.first()',
            'item = get_entry(flag)',
            'item.'
        ], 'item.');

        assert.deepStrictEqual(labels, []);
    });

    test('рекурсивный вызов функции не зацикливает определение модели', () => {
        const labels = completionsFor([
            'def get_entry():',
            '    return get_entry()',
            'item = get_entry()',
            'item.'
        ], 'item.');

        assert.deepStrictEqual(labels, []);
    });

    await testAsync('локальный helper читает native fs без файлового API редактора', async () => {
        stub.emitters.save.fire(doc(['pass']));
        const originalLocal = stub.localFiles.readFile;
        const originalApi = stub.workspace.fs.readFile;
        let localReads = 0;
        let apiReads = 0;
        stub.localFiles.readFile = async file => { localReads++;

            return fs.readFileSync(file); };
        stub.workspace.fs.readFile = uri => { apiReads++;

            return originalApi(uri); };
        const lines = ['from shop.utils import get_clients_query',
            '_, _, _, _, _, _, _, _, _, _, _, _, _, rows = get_clients_query(request)', 'rows.name'];

        try {
            const hover: stub.Hover = await stub.registered.hover[0]
                .provideHover(doc(lines), cursorAfter(lines, 'rows.name'));

            assert.ok(hover?.contents.value.includes('Client.name'));
            assert.strictEqual(localReads, 1, 'нет локального быстрого пути');
            assert.strictEqual(apiReads, 0, 'локальный helper читался через API VS Code');
        } finally {
            stub.localFiles.readFile = originalLocal;
            stub.workspace.fs.readFile = originalApi;
        }
    });

    await testAsync('ошибка native-чтения пробует API редактора один раз', async () => {
        stub.emitters.save.fire(doc(['pass']));
        const originalLocal = stub.localFiles.readFile;
        const originalApi = stub.workspace.fs.readFile;
        let localReads = 0;
        let apiReads = 0;
        stub.localFiles.readFile = () => {
            localReads++;

            return Promise.reject(new Error('Local read unavailable'));
        };
        stub.workspace.fs.readFile = uri => { apiReads++;

            return originalApi(uri); };
        const lines = ['from shop.utils import get_clients_query',
            '_, _, _, _, _, _, _, _, _, _, _, _, _, rows = get_clients_query(request)', 'rows.name'];

        try {
            const hover: stub.Hover = await stub.registered.hover[0]
                .provideHover(doc(lines), cursorAfter(lines, 'rows.name'));

            assert.ok(hover?.contents.value.includes('Client.name'));
            assert.strictEqual(localReads, 1);
            assert.strictEqual(apiReads, 1);
        } finally {
            stub.localFiles.readFile = originalLocal;
            stub.workspace.fs.readFile = originalApi;
        }
    });

    await testAsync('Remote читает helper через API редактора', async () => {
        stub.emitters.save.fire(doc(['pass']));
        const previousRemote = stub.env.remoteName;
        const originalLocal = stub.localFiles.readFile;
        const originalApi = stub.workspace.fs.readFile;
        let localReads = 0;
        let apiReads = 0;
        stub.env.remoteName = 'ssh-remote';
        stub.localFiles.readFile = async file => { localReads++;

            return fs.readFileSync(file); };
        stub.workspace.fs.readFile = uri => { apiReads++;

            return originalApi(uri); };
        const lines = ['from shop.utils import get_clients_query',
            '_, _, _, _, _, _, _, _, _, _, _, _, _, rows = get_clients_query(request)', 'rows.name'];

        try {
            const hover: stub.Hover = await stub.registered.hover[0]
                .provideHover(doc(lines), cursorAfter(lines, 'rows.name'));

            assert.ok(hover?.contents.value.includes('Client.name'));
            assert.strictEqual(localReads, 0);
            assert.strictEqual(apiReads, 1);
        } finally {
            stub.env.remoteName = previousRemote;
            stub.localFiles.readFile = originalLocal;
            stub.workspace.fs.readFile = originalApi;
        }
    });

    await testAsync('виртуальный helper сохраняет URI файлового провайдера', async () => {
        const originalFind = stub.workspace.findFiles;
        const originalRead = stub.workspace.fs.readFile;
        const schemes: string[] = [];
        const otherFile = new stub.TextDocument(UTILS,
            'from accounts.models.user import Profile\n' + fs.readFileSync(UTILS, 'utf8')
                .replace('        query,', '        Profile.objects.all(),'));
        stub.workspace.textDocuments.push(otherFile);
        stub.workspace.findFiles = async (include, exclude) =>
            (await originalFind(include, exclude)).map(uri => include === '**/*.py' && uri.fsPath === UTILS
                ? uri.with({ scheme: 'memfs' }) : uri);
        stub.workspace.fs.readFile = uri => {
            if (uri.fsPath === UTILS) schemes.push(uri.scheme);

            return originalRead(uri);
        };
        const lines = ['from shop.utils import get_clients_query',
            '_, _, _, _, _, _, _, _, _, _, _, _, _, rows = get_clients_query(request)', 'rows.name'];

        try {
            await stub.commands.executeCommand('djangoModelNavigator.updateCache');
            schemes.length = 0;
            const hover: stub.Hover = await stub.registered.hover[0]
                .provideHover(new stub.TextDocument(path.join(FIXTURES, 'shop', 'views.py'),
                    lines.join('\n'), doc(lines).uri.with({ scheme: 'memfs' })),
                cursorAfter(lines, 'rows.name'));

            assert.ok(hover?.contents.value.includes('Client.name'));
            assert.deepStrictEqual(schemes, ['memfs'], 'URI helper был заменён на file:');
        } finally {
            stub.workspace.textDocuments = stub.workspace.textDocuments
                .filter(document => document !== otherFile);
            stub.workspace.findFiles = originalFind;
            stub.workspace.fs.readFile = originalRead;
            await stub.commands.executeCommand('djangoModelNavigator.updateCache');
        }
    });

    await testAsync('одноимённые helper-пути разных файловых систем не смешивают кеш', async () => {
        const originalFind = stub.workspace.findFiles;
        const originalRead = stub.workspace.fs.readFile;
        stub.workspace.findFiles = async (include, exclude) =>
            (await originalFind(include, exclude)).flatMap(uri =>
                include === '**/*.py' && uri.fsPath === UTILS
                    ? [uri, uri.with({ scheme: 'memfs' })] : [uri]);
        stub.workspace.fs.readFile = uri => uri.scheme === 'memfs'
            ? Promise.resolve(Buffer.from('from accounts.models.user import Profile\n' +
                fs.readFileSync(UTILS, 'utf8').replace('        query,', '        Profile.objects.all(),')))
            : originalRead(uri);
        const lines = ['from shop.utils import get_clients_query',
            '_, _, _, _, _, _, _, _, _, _, _, _, _, rows = get_clients_query(request)', 'rows.'];
        const local = doc(lines);
        const virtual = new stub.TextDocument(local.uri.fsPath, lines.join('\n'),
            local.uri.with({ scheme: 'memfs' }));
        const labels = async (document: stub.TextDocument) => {
            const items: stub.CompletionItem[] = await stub.registered.completion[0]
                .provideCompletionItems(document, cursorAfter(lines, 'rows.')) ?? [];

            return items.map(item => item.label);
        };

        try {
            await stub.commands.executeCommand('djangoModelNavigator.updateCache');
            assert.ok((await labels(local)).includes('name'));
            const other = await labels(virtual);

            assert.ok(other.includes('email'));
            assert.ok(!other.includes('name'));
            assert.ok((await labels(local)).includes('name'));
        } finally {
            stub.workspace.findFiles = originalFind;
            stub.workspace.fs.readFile = originalRead;
            await stub.commands.executeCommand('djangoModelNavigator.updateCache');
        }
    });

    await testAsync('debug-лог показывает время готовности нашего hover', async () => {
        const previous = stub.configValues.debug;
        const changed = { affectsConfiguration: (section: string) =>
            section === 'djangoModelNavigator' || section === 'djangoModelNavigator.debug' };
        stub.configValues.debug = true;
        stub.emitters.config.fire(changed);
        stub.outputLines.length = 0;

        try {
            const lines = ['row = Client.objects.first()', 'row.name'];
            const hover: stub.Hover = await stub.registered.hover[0]
                .provideHover(doc(lines), cursorAfter(lines, 'row.name'));

            assert.ok(hover?.contents.value.includes('Client.name'));
            assert.ok(stub.outputLines.some(line => /Hover ready in \d+ ms/.test(line)),
                'нет времени готовности ответа Django Model Navigator');
            assert.ok(stub.outputLines.some(line =>
                /Hover stages: search=.+ read=.+ parse=.+ resolve=.+ wait=/.test(line)),
            'нет разбивки времени hover по этапам');
            stub.outputLines.length = 0;
            stub.emitters.save.fire(doc(['pass']));
            const imported = ['from shop.utils import get_clients_query',
                '_, _, _, _, _, _, _, _, _, _, _, _, _, rows = get_clients_query(request)', 'rows.name'];
            const edited = doc(imported);
            const pending = stub.registered.hover[0].provideHover(edited,
                cursorAfter(imported, 'rows.name'));
            edited.replaceText(imported.join('\n') + '\n');
            assert.strictEqual(await pending, undefined);
            assert.ok(!stub.outputLines.some(line => line.includes('Hover ready')),
                'отменённый hover записал позднюю готовность');
        } finally {
            if (previous === undefined) delete stub.configValues.debug;
            else stub.configValues.debug = previous;
            stub.emitters.config.fire(changed);
        }
    });

    await testAsync('helper открытый во время чтения использует актуальные несохранённые правки', async () => {
        stub.emitters.save.fire(doc(['pass']));
        const originalRead = stub.workspace.fs.readFile;
        let release: ((value: Buffer) => void) | undefined;
        let started: () => void = () => undefined;
        const reading = new Promise<void>(resolve => { started = resolve; });
        stub.workspace.fs.readFile = uri => uri.fsPath === UTILS
            ? new Promise<Buffer>(resolve => { release = resolve; started(); }) : originalRead(uri);
        const lines = ['from shop.utils import get_clients_query',
            '_, _, _, _, _, _, _, _, _, _, _, _, _, rows = get_clients_query(request)', 'rows.email'];
        const document = doc(lines);
        const edited = new stub.TextDocument(UTILS,
            'from accounts.models.user import Profile\n' + fs.readFileSync(UTILS, 'utf8')
                .replace('        query,', '        Profile.objects.all(),'));
        const pending = stub.registered.hover[0].provideHover(document,
            cursorAfter(lines, 'rows.email'));

        try {
            await reading;
            stub.workspace.textDocuments.push(edited);
            stub.emitters.change.fire({ document: edited });
            release?.(fs.readFileSync(UTILS));
            const hover: stub.Hover = await pending;

            assert.ok(hover?.contents.value.includes('Profile.email'),
                'позднее чтение с диска перекрыло открытый helper');
        } finally {
            release?.(Buffer.alloc(0));
            stub.workspace.fs.readFile = originalRead;
            stub.workspace.textDocuments = stub.workspace.textDocuments
                .filter(item => item !== edited);
            stub.emitters.save.fire(doc(['pass']));
        }
    });

    await testAsync('первое наведение читает helper без открытия Python-документа', async () => {
        stub.emitters.save.fire(doc(['pass']));
        const originalOpen = stub.workspace.openTextDocument;
        const originalRead = stub.workspace.fs.readFile;
        const originalFind = stub.workspace.findFiles;
        let searches = 0;
        stub.workspace.findFiles = (...args) => {
            searches++;

            return originalFind(...args);
        };
        let opened = 0;
        let read = 0;
        stub.workspace.openTextDocument = uri => {
            opened++;

            return originalOpen(uri);
        };
        stub.workspace.fs.readFile = uri => {
            if (uri.fsPath === UTILS) read++;

            return originalRead(uri);
        };
        const lines = ['from shop.utils import get_clients_query',
            '_, _, _, _, _, _, _, _, _, _, _, _, _, rows = get_clients_query(request)', 'rows.name'];
        const document = doc(lines);
        const position = cursorAfter(lines, 'rows.name');

        try {
            const hover: stub.Hover = await stub.registered.hover[0]
                .provideHover(document, position);

            assert.ok(hover?.contents.value.includes('Client.name'));
            assert.strictEqual(opened, 0,
                'первый hover открывает helper для языковых расширений');
            assert.strictEqual(read, 1);
            assert.strictEqual(searches, 0, 'первый hover запускает поиск по workspace');
            await stub.registered.hover[0].provideHover(document, position);
            assert.strictEqual(read, 1, 'повторный hover заново читает helper');
        } finally {
            stub.workspace.openTextDocument = originalOpen;
            stub.workspace.fs.readFile = originalRead;
            stub.workspace.findFiles = originalFind;
        }
    });

    await testAsync('неоднозначный импорт helper не берёт уже загруженный одноимённый модуль', async () => {
        const files = [...stub.workspaceFiles];
        const shopHelper = new stub.TextDocument(path.join(FIXTURES, 'shop', 'pick.py'),
            'def latest():\n    return Client.objects.first()');
        const rootHelper = new stub.TextDocument(path.join(FIXTURES, 'pick.py'),
            'def latest():\n    return Profile.objects.first()');
        const exact = ['from shop.pick import latest', 'row = latest()', 'row.name'];
        const ambiguous = ['from pick import latest', 'row = latest()', 'row.name'];

        stub.setWorkspaceFiles([...files, shopHelper.uri.fsPath, rootHelper.uri.fsPath]);
        stub.workspace.textDocuments.push(shopHelper, rootHelper);
        stub.emitters.create.fire(shopHelper.uri);

        try {
            const loaded: stub.Hover = await stub.registered.hover[0]
                .provideHover(doc(exact), cursorAfter(exact, 'row.name'));

            assert.ok(loaded?.contents.value.includes('Client.name'));
            const guessed = await stub.registered.hover[0]
                .provideHover(doc(ambiguous), cursorAfter(ambiguous, 'row.name'));

            assert.strictEqual(guessed, null, 'неоднозначный модуль разрешён по загруженному helper');
        } finally {
            stub.setWorkspaceFiles(files);
            stub.workspace.textDocuments = stub.workspace.textDocuments
                .filter(item => item !== shopHelper && item !== rootHelper);
            stub.emitters.remove.fire(shopHelper.uri);
        }
    });

    await testAsync('новый helper находится после инвалидирования списка путей', async () => {
        const files = [...stub.workspaceFiles];
        const helper = new stub.TextDocument(path.join(FIXTURES, 'shop', 'fresh_helpers.py'),
            'def get_entry():\n    return Profile.objects.first()');
        const lines = ['from shop.fresh_helpers import get_entry', 'row = get_entry()', 'row.email'];

        stub.setWorkspaceFiles([...files, helper.uri.fsPath]);
        stub.workspace.textDocuments.push(helper);
        stub.emitters.create.fire(helper.uri);

        try {
            const hover: stub.Hover = await stub.registered.hover[0]
                .provideHover(doc(lines), cursorAfter(lines, 'row.email'));

            assert.ok(hover?.contents.value.includes('Profile.email'));
            stub.setWorkspaceFiles(files);
            stub.workspace.textDocuments = stub.workspace.textDocuments
                .filter(item => item !== helper);
            stub.emitters.remove.fire(helper.uri);
            const missing = await stub.registered.hover[0]
                .provideHover(doc(lines), cursorAfter(lines, 'row.email'));

            assert.strictEqual(missing, null, 'удалённый helper остался в кеше');
        } finally {
            stub.setWorkspaceFiles(files);
            stub.workspace.textDocuments = stub.workspace.textDocuments
                .filter(item => item !== helper);
            await stub.commands.executeCommand('djangoModelNavigator.updateCache');
        }
    });

    await testAsync('ошибка списка Python-путей сохраняет поиск импорта по запросу', async () => {
        const originalFind = stub.workspace.findFiles;
        stub.workspace.findFiles = (include, exclude) => include === '**/*.py'
            ? Promise.reject(new Error('Source catalog unavailable')) : originalFind(include, exclude);
        const lines = ['from shop.utils import get_clients_query',
            '_, _, _, _, _, _, _, _, _, _, _, _, _, rows = get_clients_query(request)', 'rows.name'];

        try {
            await stub.commands.executeCommand('djangoModelNavigator.updateCache');
            const hover: stub.Hover = await stub.registered.hover[0]
                .provideHover(doc(lines), cursorAfter(lines, 'rows.name'));

            assert.ok(hover?.contents.value.includes('Client.name'));
        } finally {
            stub.workspace.findFiles = originalFind;
            await stub.commands.executeCommand('djangoModelNavigator.updateCache');
        }
    });

    await testAsync('изменение helper на диске обновляет снимок без открытия документа', async () => {
        stub.emitters.save.fire(doc(['pass']));
        const originalRead = stub.workspace.fs.readFile;
        let changed = false;
        stub.workspace.fs.readFile = uri => {
            if (uri.fsPath === UTILS && changed) {
                return Promise.resolve(Buffer.from('from accounts.models.user import Profile\n' +
                    fs.readFileSync(UTILS, 'utf8').replace('        query,',
                        '        Profile.objects.all(),')));
            }

            return originalRead(uri);
        };
        const lines = ['from shop.utils import get_clients_query',
            '_, _, _, _, _, _, _, _, _, _, _, _, _, rows = get_clients_query(request)', 'rows.'];
        const document = doc(lines);
        const labels = async () => {
            const items: stub.CompletionItem[] = await stub.registered.completion[0]
                .provideCompletionItems(document, cursorAfter(lines, 'rows.')) ?? [];

            return items.map(item => item.label);
        };

        try {
            assert.ok((await labels()).includes('name'));
            changed = true;
            stub.emitters.fileChange.fire(stub.Uri.file(UTILS));
            const updated = await labels();

            assert.ok(updated.includes('email'), 'снимок helper остался прежним');
            assert.ok(!updated.includes('name'));
        } finally {
            stub.workspace.fs.readFile = originalRead;
            stub.emitters.save.fire(doc(['pass']));
        }
    });

    await testAsync('импортированная функция сохраняет модель последнего элемента кортежа', async () => {
        const lines = [
            'from shop.utils import get_clients_query',
            '(',
            '    domain, city, client, services, positioning, site_type, template,',
            '    status, adv_stage, problematic, tech, production_stage, chargeable,',
            '    query,',
            ') = get_clients_query(request)',
            'sites = query.order_by("name").all()',
            'sites = sorted(sites, key=lambda row: row.name)',
            'for site in sites:',
            '    staff = site.employees.all()',
            '    for item in staff:',
            '        item.profile.'
        ];
        const document = doc(lines);
        const items: stub.CompletionItem[] = await stub.registered.completion[0]
            .provideCompletionItems(document, cursorAfter(lines, 'item.profile.')) ?? [];

        assert.ok(items.some(item => item.label === 'email'), 'потеряна модель из return импортированной функции');
    });

    await testAsync('распаковка импортированной функции поддерживает псевдоним и пропущенные значения', async () => {
        const lines = [
            'from shop.utils import get_clients_query as load_rows',
            '_, _, _, _, _, _, _, _, _, _, _, _, _, rows = load_rows(request)',
            'rows.'
        ];
        const items: stub.CompletionItem[] = await stub.registered.completion[0]
            .provideCompletionItems(doc(lines), cursorAfter(lines, 'rows.')) ?? [];

        assert.ok(items.some(item => item.label === 'name'));
    });

    await testAsync('строковый элемент возвращаемого кортежа не считается моделью', async () => {
        const lines = [
            'from shop.utils import get_clients_query',
            'domain, _, _, _, _, _, _, _, _, _, _, _, _, rows = get_clients_query(request)',
            'domain.'
        ];
        const items = await stub.registered.completion[0]
            .provideCompletionItems(doc(lines), cursorAfter(lines, 'domain.'));

        assert.deepStrictEqual(items ?? [], []);
    });

    await testAsync('определение и hover продолжают цепочку из импортированной функции', async () => {
        const lines = [
            'from .utils import get_clients_query',
            '_, _, _, _, _, _, _, _, _, _, _, _, _, rows = get_clients_query(request)',
            'for row in rows:',
            '    row.owner.phone'
        ];
        const document = doc(lines);
        const position = cursorAfter(lines, 'row.owner.phone');
        const definition = await stub.registered.definition[0]
            .provideDefinition(document, position);
        const locations: stub.Location[] = Array.isArray(definition) ? definition : [definition];
        const hover: stub.Hover = await stub.registered.hover[0].provideHover(document, position);

        assert.strictEqual(locations.length, 1);
        assert.strictEqual(locations[0]?.uri.fsPath, ACCOUNTS);
        assert.ok(lineOf(locations[0]).includes('phone ='));
        assert.ok(hover?.contents.value.includes('User.phone'));
    });

    await testAsync('повторный ввод не повторяет поиск неизменившегося импорта', async () => {
        const originalFind = stub.workspace.findFiles;
        let searches = 0;

        stub.workspace.findFiles = (include, exclude) => {
            searches++;

            return originalFind(include, exclude);
        };

        try {
            const lines = [
                'from shop.utils import get_clients_query',
                '_, _, _, _, _, _, _, _, _, _, _, _, _, rows = get_clients_query(request)',
                'rows.'
            ];

            await stub.registered.completion[0].provideCompletionItems(doc(lines), cursorAfter(lines, 'rows.'));
            const beforeTyping = searches;
            const typed = [...lines.slice(0, -1), 'rows.na'];

            await stub.registered.completion[0].provideCompletionItems(doc(typed), cursorAfter(typed, 'rows.na'));
            assert.strictEqual(searches, beforeTyping, 'повторный ввод заново сканирует импортированный модуль');
        } finally {
            stub.workspace.findFiles = originalFind;
        }
    });

    await testAsync('правка импортированной функции обновляет тип в неизменённом вызывающем документе', async () => {
        const lines = [
            'from shop.utils import get_clients_query',
            '_, _, _, _, _, _, _, _, _, _, _, _, _, rows = get_clients_query(request)',
            'rows.'
        ];
        const document = doc(lines);
        const labels = async () => {
            const items: stub.CompletionItem[] = await stub.registered.completion[0]
                .provideCompletionItems(document, cursorAfter(lines, 'rows.')) ?? [];

            return items.map(item => item.label);
        };

        assert.ok((await labels()).includes('name'));
        const edited = new stub.TextDocument(UTILS,
            'from accounts.models.user import Profile\n' + fs.readFileSync(UTILS, 'utf8')
                .replace('        query,', '        Profile.objects.all(),'));

        stub.workspace.textDocuments.push(edited);
        stub.emitters.change.fire({ document: edited });

        try {
            assert.ok((await labels()).includes('email'), 'тип результата остался закешированным');
        } finally {
            stub.workspace.textDocuments = stub.workspace.textDocuments
                .filter(item => item !== edited);
            stub.emitters.change.fire({ document: edited });
        }
    });

    test('неизвестное значение не становится моделью из-за совпадения имени', () => {
        const labels = completionsFor([
            'def get_rows(request):',
            '    client = request.GET.get("client")',
            '    return client, Client.objects.all()',
            'client, query = get_rows(request)',
            'client.'
        ], 'client.');

        assert.deepStrictEqual(labels, []);
    });

    test('одна функция сохраняет разные типы переданных queryset', () => {
        const lines = [
            'def filter_rows(query):',
            '    return query.filter(id__gt=0)',
            'clients = filter_rows(Client.objects.all())',
            'profiles = filter_rows(Profile.objects.all())',
            'profiles.'
        ];

        assert.ok(completionsFor(lines, 'profiles.').includes('email'));
        assert.ok(completionsFor([...lines.slice(0, -1), 'clients.'], 'clients.').includes('name'));
    });

    await testAsync('повторные провайдеры не перечитывают неизменённый документ целиком', async () => {
        const lines = [
            'from shop.utils import get_clients_query',
            '_, _, _, _, _, _, _, _, _, _, _, _, _, rows = get_clients_query(request)',
            'rows.name'
        ];
        const document = doc(lines);
        const getText = document.getText.bind(document);
        let fullReads = 0;

        document.getText = range => {
            if (!range) fullReads++;

            return getText(range);
        };
        const position = cursorAfter(lines, 'rows.');

        await stub.registered.completion[0].provideCompletionItems(document, position);
        fullReads = 0;
        const items: stub.CompletionItem[] = await stub.registered.completion[0]
            .provideCompletionItems(document, position) ?? [];
        const fieldPosition = cursorAfter(lines, 'rows.name');
        const hover: stub.Hover = await stub.registered.hover[0]
            .provideHover(document, fieldPosition);
        const definition = await stub.registered.definition[0]
            .provideDefinition(document, fieldPosition);

        assert.ok(items.some(item => item.label === 'name'));
        assert.ok(hover?.contents.value.includes('Client.name'));
        assert.ok(definition);
        assert.strictEqual(fullReads, 0, 'неизменённый документ повторно читается целиком');
    });

    await testAsync('новая версия того же документа обновляет распознанные функции и переменные', async () => {
        const document = doc([
            'def get_entry():',
            '    return Client.objects.first()',
            'entry = get_entry()',
            'entry.'
        ]);
        const position = new stub.Position(3, 6);
        const labels = async () => {
            const items: stub.CompletionItem[] = await stub.registered.completion[0]
                .provideCompletionItems(document, position) ?? [];

            return items.map(item => item.label);
        };

        assert.ok((await labels()).includes('name'));
        document.replaceText([
            'def get_entry():',
            '    return Profile.objects.first()',
            'entry = get_entry()',
            'entry.'
        ].join('\n'));
        const updated = await labels();

        assert.ok(updated.includes('email'));
        assert.ok(!updated.includes('name'));
    });

    await testAsync('кеш различает присваивания одной переменной на одной строке', async () => {
        const code = 'entry = Client.objects.first(); entry.name; entry = Profile.objects.first(); entry.email';
        const document = doc([code]);
        const first: stub.Hover = await stub.registered.hover[0].provideHover(document,
            new stub.Position(0, code.indexOf('entry.name') + 'entry.name'.length));
        const second: stub.Hover = await stub.registered.hover[0].provideHover(document,
            new stub.Position(0, code.indexOf('entry.email') + 'entry.email'.length));

        assert.ok(first?.contents.value.includes('Client.name'));
        assert.ok(second?.contents.value.includes('Profile.email'));
    });

    group('lookup-пути');

    test('внутри filter предлагаются поля модели', () => {
        const lines = ['Review.objects.filter()'];
        const labels = completionsFor(lines, 'Review.objects.filter(');

        assert.ok(labels.includes('text'), `нет поля text: ${labels.join(', ')}`);
        assert.ok(labels.includes('client'));
        assert.ok(labels.includes('id'), 'нет неявного поля id');
    });

    test('после связи предлагаются поля связанной модели', () => {
        const lines = ['Review.objects.filter(client__)'];
        const labels = completionsFor(lines, 'client__');

        assert.ok(labels.includes('name'), `нет поля name: ${labels.join(', ')}`);
        assert.ok(!labels.includes('text'), 'предложены поля Review вместо Client');
        assert.ok(labels.includes('isnull'), 'нет lookup для связи');
    });

    test('обратная связь в filter называется по имени модели, а в prefetch_related — по аксессору', () => {
        // filter(review_set__...) raises FieldError in Django; prefetch_related uses accessors
        const filter = ['Client.objects.filter(review__text="x")'];
        const wrong = ['Client.objects.filter(review_set__text="x")'];
        const prefetch = ['Client.objects.prefetch_related("review_set")'];

        assert.ok(completionsFor(['Client.objects.filter()'], 'filter(').includes('review'));
        assert.ok(!completionsFor(['Client.objects.filter()'], 'filter(').includes('review_set'));
        assert.ok(hoverFor(filter, 'review__te')?.includes('Review.text'));
        assert.strictEqual(definitionsFor(filter, 'review__te').length, 1);
        assert.strictEqual(hoverFor(wrong, 'review_set__te'), null);
        assert.ok(completionsFor(prefetch, 'prefetch_related("rev').includes('review_set'));
        assert.ok(hoverFor(prefetch, 'prefetch_related("rev')?.includes('review_set'));
    });

    test('после обычного поля предлагаются lookup-ы', () => {
        const labels = completionsFor(['Review.objects.filter(text__)'], 'text__');

        assert.ok(labels.includes('icontains'));
        assert.ok(labels.includes('isnull'));
    });

    test('подставляется только текущий сегмент пути', () => {
        const lines = ['Review.objects.filter(client__na)'];

        const items: stub.CompletionItem[] = stub.registered.completion[0].provideCompletionItems(
            doc(lines),
            cursorAfter(lines, 'client__na')
        );

        const item = items.find(entry => entry.label === 'name');

        assert.ok(item?.range, 'у элемента нет диапазона замены');
        assert.strictEqual(item.range.start.character, lines[0].indexOf('client__') + 8);
    });

    test('в строке select_related предлагаются связи', () => {
        const labels = completionsFor(['Review.objects.select_related("")'], 'select_related("');

        assert.ok(labels.includes('client'));
    });

    test('переход по сегменту пути ведёт к полю', () => {
        const lines = ['Review.objects.filter(client__name="x")'];
        const locations = definitionsFor(lines, 'client__name');

        assert.strictEqual(locations.length, 1);

        const target = stub.TextDocument.fromFile(locations[0].uri.fsPath)
            .lineAt(locations[0].range.start.line)
            .text;

        assert.ok(target.includes('name = CharField'), `попали в строку: ${target}`);
    });

    test('переход работает и внутри строки order_by', () => {
        const lines = ['Review.objects.order_by("-client__name")'];
        const locations = definitionsFor(lines, '-client__name');

        assert.strictEqual(locations.length, 1);
        assert.ok(
            stub.TextDocument.fromFile(locations[0].uri.fsPath)
                .lineAt(locations[0].range.start.line)
                .text.includes('name = CharField')
        );
    });

    test('подсказка по сегменту пути показывает владельца поля', () => {
        const value = hoverFor(['Review.objects.filter(client__name="x")'], 'client__name');

        assert.ok(value?.includes('Client.name'), `подсказка: ${value}`);
    });

    test('pk разрешается в первичный ключ', () => {
        const lines = ['Review.objects.filter(pk=1)'];

        assert.ok(hoverFor(lines, 'pk')?.includes('AutoField'));
    });

    test('lookup-путь от переменной', () => {
        const lines = ['client = Client.objects.first()', 'client.review_set.filter(profile__)'];
        const labels = completionsFor(lines, 'profile__');

        assert.ok(labels.includes('email'), `нет поля email: ${labels.join(', ')}`);
    });

    group('выбор одноимённой модели');

    test('без импорта берётся модель своего приложения', () => {
        const document = new stub.TextDocument(
            path.join(FIXTURES, 'blog', 'views.py'),
            ['tag = Tag.objects.first()', 'print(tag.)'].join('\n')
        );

        const items = stub.registered.completion[0].provideCompletionItems(
            document,
            new stub.Position(1, 'print(tag.'.length)
        );

        const labels = (items ?? []).map((item: stub.CompletionItem) => item.label);

        assert.ok(labels.includes('title'), `ожидались поля blog.Tag: ${labels.join(', ')}`);
        assert.ok(!labels.includes('slug'), 'взята модель shop.Tag');
    });

    test('импорт указывает на модель другого приложения', () => {
        const document = new stub.TextDocument(
            path.join(FIXTURES, 'blog', 'views.py'),
            [
                'from shop.models import Tag',
                '',
                'tag = Tag.objects.first()',
                'print(tag.)'
            ].join('\n')
        );

        const items = stub.registered.completion[0].provideCompletionItems(
            document,
            new stub.Position(3, 'print(tag.'.length)
        );

        const labels = (items ?? []).map((item: stub.CompletionItem) => item.label);

        assert.ok(labels.includes('slug'), `ожидались поля shop.Tag: ${labels.join(', ')}`);
        assert.ok(!labels.includes('title'), 'взята модель blog.Tag');
    });

    test('у встроенной модели переход к определению не предлагается', () => {
        assert.deepStrictEqual(definitionsFor(['print(Group)'], 'Group'), []);
    });

    group('go to definition');

    test('поле связанной модели ведёт в файл этой модели', () => {
        const lines = ['review = Review.objects.first()', 'print(review.profile.email)'];
        const locations = definitionsFor(lines, 'review.profile.email');

        assert.strictEqual(locations.length, 1);
        assert.strictEqual(locations[0].uri.fsPath, ACCOUNTS);

        const target = stub.TextDocument.fromFile(ACCOUNTS)
            .lineAt(locations[0].range.start.line)
            .text;

        assert.ok(target.includes('email = models.EmailField'), `попали в строку: ${target}`);
        assert.strictEqual(locations[0].range.start.character, target.indexOf('email'));
    });

    test('имя модели ведёт к объявлению класса', () => {
        const lines = ['client = Client.objects.first()'];
        const locations = definitionsFor(lines, 'Client');

        assert.ok(locations.length >= 1);
        assert.strictEqual(locations[0].uri.fsPath, SHOP);

        const target = stub.TextDocument.fromFile(SHOP)
            .lineAt(locations[0].range.start.line)
            .text;

        assert.ok(target.startsWith('class Client('), `попали в строку: ${target}`);
    });

    test('обратная связь ведёт и к полю, и к модели', () => {
        const lines = ['client = Client.objects.first()', 'print(client.review_set)'];
        const locations = definitionsFor(lines, 'client.review_set');

        assert.ok(locations.length >= 2, 'ожидались поле и модель');

        const targets = locations.map(location =>
            stub.TextDocument.fromFile(location.uri.fsPath).lineAt(location.range.start.line).text
        );

        assert.ok(targets.some(text => text.includes('client = models.ForeignKey')));
        assert.ok(targets.some(text => text.startsWith('class Review(')));
    });

    test('варианты перехода не дублируются', () => {
        const lines = ['print(Client)'];
        const locations = definitionsFor(lines, 'Client');

        const keys = locations.map(
            location => `${location.uri.fsPath}:${location.range.start.line}`
        );

        assert.strictEqual(new Set(keys).size, keys.length);
    });

    group('hover');

    test('подсказка поля показывает тип и ссылку на объявление', () => {
        const lines = ['review = Review.objects.first()', 'print(review.text)'];
        const value = hoverFor(lines, 'review.text');

        assert.ok(value?.includes('Review.text'));
        assert.ok(value?.includes('TextField'));
        assert.ok(value?.includes('models.py:'));
    });

    test('подсказка связи показывает поля связанной модели', () => {
        const lines = ['review = Review.objects.first()', 'print(review.client)'];
        const value = hoverFor(lines, 'review.client');

        assert.ok(value?.includes("ForeignKey('Client')"));
        assert.ok(value?.includes('class Client(models.Model)'));
    });

    test('подсказка обратной связи показывает источник', () => {
        const lines = ['client = Client.objects.first()', 'print(client.review_set)'];
        const value = hoverFor(lines, 'client.review_set');

        assert.ok(value?.includes('Reverse relation of'));
        assert.ok(value?.includes('Review.client'));
    });

    test('подсказка унаследованного поля сообщает источник', () => {
        const lines = ['client = Client.objects.first()', 'print(client.created_at)'];
        const value = hoverFor(lines, 'client.created_at');

        assert.ok(value?.includes('Inherited from'));
        assert.ok(value?.includes('TimeStampedModel'));
    });

    test('подсказка модели показывает её полное имя', () => {
        const lines = ['print(Client)'];
        const value = hoverFor(lines, 'Client');

        assert.ok(value?.includes('shop.models.Client'));
    });

    test('у неизвестного слова подсказки нет', () => {
        assert.strictEqual(hoverFor(['print(unknown_thing)'], 'unknown_thing'), null);
    });

    group('find all references');

    test('ссылки на модель включают объявление и поля-связи', () => {
        const locations = referencesFor(['print(Client)'], 'Client');
        const targets = locations.map(lineOf);

        assert.ok(targets.some(text => text.startsWith('class Client(')), 'нет объявления');
        assert.ok(
            targets.some(text => text.includes('client = models.ForeignKey(Client')),
            'нет связи из Review'
        );
        assert.ok(
            targets.some(text => text.includes('client = models.ForeignKey(ShopClient')),
            'нет связи из Post'
        );
    });

    test('ссылки на абстрактную модель включают наследников', () => {
        const targets = referencesFor(['print(TimeStampedModel)'], 'TimeStampedModel').map(lineOf);

        assert.ok(targets.some(text => text.startsWith('class Client(TimeStampedModel)')));
        assert.ok(targets.some(text => text.startsWith('class Review(TimeStampedModel)')));
    });

    test('ссылки не дублируются', () => {
        const locations = referencesFor(['print(Client)'], 'Client');

        const keys = locations.map(
            location => `${location.uri.fsPath}:${location.range.start.line}`
        );

        assert.strictEqual(new Set(keys).size, keys.length);
    });

    test('у поля-связи ссылки ведут к связанной модели', () => {
        const lines = ['review = Review.objects.first()', 'print(review.client)'];
        const targets = referencesFor(lines, 'review.client').map(lineOf);

        assert.ok(targets.some(text => text.startsWith('class Client(')));
    });

    group('точность определений полей');

    test('неизвестный владелец не получает одноимённые поля из всего индекса', () => {
        const targets = definitionsFor(['unknown_object.name'], 'unknown_object.name');

        assert.deepStrictEqual(targets, []);
    });

    test('поле tag не добавляет объявления одноимённых моделей Tag', () => {
        const targets = definitionsFor(['entry = Post.objects.first()', 'entry.tag'], 'entry.tag');

        assert.strictEqual(targets.length, 1);
        assert.strictEqual(targets[0].uri.fsPath, BLOG);
        assert.ok(lineOf(targets[0]).includes('tag = models.ForeignKey'));
    });

    await testAsync('посторонние вызовы не расходуют лимит загрузки функции, определяющей модель', async () => {
        const noise = path.join(FIXTURES, 'shop', 'unrelated.py');
        const files = [...stub.workspaceFiles];
        const originalOpen = stub.workspace.openTextDocument;
        const opened: string[] = [];
        const unrelated = new stub.TextDocument(noise, [
            ...Array.from({ length: 40 }, (_, index) => `from absent_${index} import call_${index}`),
            'def unrelated():',
            ...Array.from({ length: 40 }, (_, index) => `    call_${index}()`)
        ].join('\n'));
        const lines = [
            'from shop.utils import get_clients_query',
            'from shop.unrelated import unrelated',
            '_, _, _, _, _, _, _, _, _, _, _, _, _, rows = get_clients_query(request)',
            'unrelated()',
            'for row in rows:',
            '    row.name'
        ];
        const document = new stub.TextDocument(path.join(FIXTURES, 'shop', 'noisy_views.py'),
            lines.join('\n'));

        stub.setWorkspaceFiles([...files, noise]);
        stub.workspace.openTextDocument = uri => {
            opened.push(uri.fsPath);

            return uri.fsPath === noise ? Promise.resolve(unrelated) : originalOpen(uri);
        };

        try {
            const items: stub.CompletionItem[] = await stub.registered.completion[0]
                .provideCompletionItems(document, cursorAfter(lines, 'row.')) ?? [];

            assert.ok(items.some(item => item.label === 'name'), 'потеряна модель из get_clients_query');
            assert.ok(!opened.includes(noise), 'загружен посторонний модуль unrelated');
            const definition = await stub.registered.definition[0]
                .provideDefinition(document, cursorAfter(lines, 'row.name'));
            const targets: stub.Location[] = Array.isArray(definition) ? definition : [definition];

            assert.strictEqual(targets.length, 1);
            assert.strictEqual(targets[0]?.uri.fsPath, SHOP);
        } finally {
            stub.setWorkspaceFiles(files);
            stub.workspace.openTextDocument = originalOpen;
        }
    });

    group('регрессии точности модели');

    test('hover и references неизвестного атрибута не ищут модель по имени поля', () => {
        const lines = ['unknown_object.client'];

        assert.strictEqual(hoverFor(lines, 'unknown_object.client'), null);
        assert.deepStrictEqual(referencesFor(lines, 'unknown_object.client'), []);
    });

    test('неизвестный binding затеняет одноимённую модель во всех провайдерах', () => {
        const lines = ['client = request.GET.get("client")', 'print(client)'];

        assert.strictEqual(hoverFor(lines, 'print(client'), null);
        assert.deepStrictEqual(definitionsFor(lines, 'print(client'), []);
        assert.deepStrictEqual(referencesFor(lines, 'print(client'), []);
    });

    test('references поля использует модель его связи до совпадения имени класса', () => {
        const targets = referencesFor(['entry = Post.objects.first()', 'entry.tag'], 'entry.tag');

        assert.ok(targets.some(target => target.uri.fsPath === BLOG && lineOf(target).includes('class Tag')));
        assert.ok(!targets.some(target => target.uri.fsPath === SHOP && lineOf(target).includes('class Tag')));
    });

    test('несуществующий lookup не становится одноимённой моделью', () => {
        const lines = ['Client.objects.order_by("tag")'];

        assert.deepStrictEqual(definitionsFor(lines, 'order_by("tag'), []);
        assert.strictEqual(hoverFor(lines, 'order_by("tag'), null);
        assert.deepStrictEqual(referencesFor(lines, 'order_by("tag'), []);
    });

    for (const noise of [
        '# for row in Profile.objects.all():',
        'snippet = """\nrow = Profile.objects.first()\n"""',
        'snippet = "for row in Profile.objects.all():"'
    ]) {
        test(`неисполняемый текст не меняет binding: ${noise.split('\n')[0]}`, () => {
            const lines = ['row = Client.objects.first()', ...noise.split('\n'), 'row.name'];

            assert.ok(completionsFor(lines, 'row.').includes('name'));
            assert.ok(!completionsFor(lines, 'row.').includes('email'));
            assert.ok(hoverFor(lines, 'row.name')?.includes('Client.name'));
        });
    }

    test('параметр функции не получает binding из соседней функции', () => {
        const lines = ['def first():', '    row = Client.objects.first()',
            'def second(row):', '    row.name'];

        assert.deepStrictEqual(completionsFor(lines, 'row.name'), []);
        assert.strictEqual(hoverFor(lines, 'row.name'), null);
        assert.deepStrictEqual(definitionsFor(lines, 'row.name'), []);
    });

    test('присваивание вложенной функции не меняет результат внешней', () => {
        const lines = ['def get_entry():', '    row = Client.objects.first()',
            '    def nested():', '        row = Profile.objects.first()',
            '    return row', 'item = get_entry()', 'item.name'];

        assert.ok(completionsFor(lines, 'item.').includes('name'));
        assert.ok(!completionsFor(lines, 'item.').includes('email'));
        assert.ok(hoverFor(lines, 'item.name')?.includes('Client.name'));
    });

    test('неизвестный внутренний queryset не заимствует модель внешнего', () => {
        const lines = ['Client.objects.filter(pk__in=unknown_rows.filter(name="x"))'];

        assert.deepStrictEqual(completionsFor(lines, 'unknown_rows.filter(name'), []);
        assert.strictEqual(hoverFor(lines, 'unknown_rows.filter(name'), null);
        assert.deepStrictEqual(definitionsFor(lines, 'unknown_rows.filter(name'), []);
        assert.deepStrictEqual(referencesFor(lines, 'unknown_rows.filter(name'), []);
    });

    for (const shortcut of ['get_object_or_404', 'get_list_or_404']) {
        test(`${shortcut} использует binding queryset вместо совпадения имени модели`, () => {
            const lines = ['client = Profile.objects.all()',
                `row = ${shortcut}(client, pk=1)`, 'row.email'];

            assert.ok(completionsFor(lines, 'row.').includes('email'));
            assert.ok(!completionsFor(lines, 'row.').includes('name'));
            assert.ok(hoverFor(lines, 'row.email')?.includes('Profile.email'));
        });
    }

    test('неразрешённый явный импорт не подменяется моделью текущего приложения', () => {
        const lines = ['from unindexed.models import Client',
            'row = Client.objects.first()', 'row.name'];

        assert.deepStrictEqual(completionsFor(lines, 'row.'), []);
        assert.strictEqual(hoverFor(lines, 'row.name'), null);
        assert.deepStrictEqual(definitionsFor(lines, 'row.name'), []);
    });

    test('модель из пакета моделей находится через реэкспорт его __init__', () => {
        // Django requires package models to be imported in models/__init__.py
        const lines = ['from accounts.models import Profile',
            'row = Profile.objects.first()', 'row.email'];

        assert.ok(completionsFor(lines, 'row.').includes('email'));
        assert.ok(hoverFor(lines, 'row.email')?.includes('Profile.email'));
        assert.strictEqual(definitionsFor(lines, 'row.email').length, 1);
        assert.strictEqual(definitionsFor(lines, 'from accounts.models import Prof').length, 1);
    });

    test('относительный импорт из пакета моделей своего приложения', () => {
        const lines = ['from .models import Profile', 'row = Profile.objects.first()', 'row.email'];
        const document = new stub.TextDocument(path.join(FIXTURES, 'accounts', 'views.py'),
            lines.join('\n'));
        const hover = stub.registered.hover[0].provideHover(document, cursorAfter(lines, 'row.email'));

        assert.ok(hover?.contents.value.includes('Profile.email'));
    });

    test('импорт из пакета без такой модели не подменяется моделью по имени', () => {
        const lines = ['from accounts.models import Client',
            'row = Client.objects.first()', 'row.name'];

        assert.strictEqual(hoverFor(lines, 'row.name'), null);
    });

    for (const expression of ['values("name").first()', 'values_list("name", flat=True).first()',
        'aggregate(total=Count("id"))', 'update(name="x")', 'get_or_create(name="x")']) {
        test(`результат ${expression} не считается экземпляром модели`, () => {
            const lines = [`row = Client.objects.${expression}`, 'row.name'];

            assert.deepStrictEqual(completionsFor(lines, 'row.'), []);
            assert.strictEqual(hoverFor(lines, 'row.name'), null);
            assert.deepStrictEqual(definitionsFor(lines, 'row.name'), []);
        });
    }

    test('аннотация с двумя моделями не выбирает первую', () => {
        const lines = ['def choose() -> Client | Profile:',
            '    return Profile.objects.first()', 'row = choose()', 'row.name'];

        assert.deepStrictEqual(completionsFor(lines, 'row.'), []);
        assert.strictEqual(hoverFor(lines, 'row.name'), null);
        assert.deepStrictEqual(definitionsFor(lines, 'row.name'), []);
    });

    test('Q внутри queryset сохраняет внешний контекст поля', () => {
        const lines = ['Client.objects.filter(Q(name="x"))'];

        assert.ok(completionsFor(lines, 'Q(name').includes('name'));
        assert.ok(hoverFor(lines, 'Q(name')?.includes('Client.name'));
        assert.strictEqual(definitionsFor(lines, 'Q(name').length, 1);
    });

    for (const [line, needle] of [
        ['Client.objects.filter(models.Q(name="x"))', 'Q(name'],
        ['Client.objects.filter(name=models.F("name"))', 'F("name'],
        ['Client.objects.filter(django.db.models.Q(name="x"))', 'Q(name'],
        ['Client.objects.annotate(total=models.Count("name"))', 'Count("name']
    ]) {
        test(`${line} сохраняет queryset при префиксе модуля`, () => {
            const lines = ['from django.db import models', line];

            assert.ok(hoverFor(lines, needle)?.includes('Client.name'));
            assert.strictEqual(definitionsFor(lines, needle).length, 1);
        });
    }

    test('values-queryset в переменной сохраняет модель для следующих lookup', () => {
        const lines = ['qs = Client.objects.values("name")', 'qs = qs.values("name")',
            'qs.filter(name__icontains="x")', 'row = qs.first()', 'row.name'];

        assert.ok(hoverFor(lines, 'qs.filter(name')?.includes('Client.name'));
        assert.ok(completionsFor(lines, 'qs.filter(na').includes('name'));
        // The dictionary rows of a values queryset are still not model instances
        assert.strictEqual(hoverFor(lines, 'row.name'), null);
    });

    test('имена полей внутри values сохраняют модель исходного queryset', () => {
        const lines = ['Client.objects.values("name")'];

        assert.ok(completionsFor(lines, 'values("na').includes('name'));
        assert.ok(hoverFor(lines, 'values("name')?.includes('Client.name'));
    });

    test('индекс результата get_or_create выбирает объект или флаг', () => {
        const lines = ['row = Client.objects.get_or_create(name="x")[0]',
            'flag = Client.objects.update_or_create(name="x")[1]', 'first = Client.objects.all()[0]',
            'row.name', 'flag.', 'first.name'];

        assert.ok(hoverFor(lines, 'row.name')?.includes('Client.name'));
        assert.deepStrictEqual(completionsFor(lines, 'flag.'), []);
        assert.ok(hoverFor(lines, 'first.name')?.includes('Client.name'));
    });

    test('распаковка get_or_create различает объект и флаг создания', () => {
        const lines = ['row, created = Client.objects.get_or_create(name="x")', 'row.name', 'created.'];

        assert.ok(completionsFor(lines, 'row.').includes('name'));
        assert.deepStrictEqual(completionsFor(lines, 'created.'), []);
    });

    test('Optional и строковая аннотация сохраняют единственную модель', () => {
        for (const annotation of ['Optional[Client]', 'Client | None', '"Client"']) {
            const lines = [`def choose() -> ${annotation}:`, '    return Client.objects.first()',
                'row = choose()', 'row.name'];

            assert.ok(hoverFor(lines, 'row.name')?.includes('Client.name'), annotation);
        }
    });

    test('канонический импорт встроенной модели сохраняет псевдоним', () => {
        const lines = ['from django.contrib.auth.models import Group as DjangoGroup',
            'row = DjangoGroup.objects.first()', 'row.name'];

        assert.ok(hoverFor(lines, 'row.name')?.includes('Group.name'));
    });

    group('боковая панель');

    test('манифест объявляет иконку, две панели и кнопки обновления и лога', () => {
        const root = path.join(FIXTURES, '..', '..');
        const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        const containers: { id: string; icon: string }[] =
            manifest.contributes.viewsContainers?.activitybar ?? [];
        const container = containers.find(item => item.id === 'djangoModelNavigator');

        assert.ok(container, 'нет контейнера Django Model Navigator');
        assert.ok(fs.existsSync(path.join(root, container.icon)));
        const views: { id: string }[] = manifest.contributes.views?.djangoModelNavigator ?? [];

        assert.ok(views.some(view => view.id === 'djangoModelNavigator.overview'));
        assert.ok(views.some(view => view.id === 'djangoModelNavigator.models'));
        const buttons: { command: string }[] = manifest.contributes.menus?.['view/title'] ?? [];

        assert.ok(buttons.some(button => button.command === 'djangoModelNavigator.updateCache'));
        assert.ok(buttons.some(button => button.command === 'djangoModelNavigator.showLog'));
    });

    test('дерево разделяет приложения и сохраняет поля и исходные позиции', () => {
        const tree = stub.registered.trees.get('djangoModelNavigator.models');

        assert.ok(tree, 'дерево моделей не зарегистрировано');
        const apps = tree.getChildren();
        const shop = apps.find(node => tree.getTreeItem(node).label === 'shop');

        assert.ok(shop);
        const client = tree.getChildren(shop).find(node => tree.getTreeItem(node).label === 'Client');

        assert.ok(client);
        const modelItem = tree.getTreeItem(client);

        assert.strictEqual(modelItem.command?.command, 'vscode.open');
        assert.strictEqual((modelItem.command.arguments?.[0] as stub.Uri).fsPath, SHOP);
        const fields = tree.getChildren(client);
        const name = fields.find(node => tree.getTreeItem(node).label === 'name');

        assert.ok(name);
        const item = tree.getTreeItem(name);
        const options = item.command?.arguments?.[1] as { selection: stub.Range };

        assert.strictEqual(item.command?.command, 'vscode.open');
        assert.ok(stub.TextDocument.fromFile(SHOP).lineAt(options.selection.start.line).text
            .includes('name = CharField'));
        const implicit = fields.find(node => tree.getTreeItem(node).label === 'id');

        assert.ok(implicit);
        assert.ok(tree.getTreeItem(implicit).description?.includes('implicit'));
    });

    test('одноимённые модели разных приложений имеют разные идентификаторы', () => {
        const tree = stub.registered.trees.get('djangoModelNavigator.models');

        assert.ok(tree);
        const apps = tree.getChildren();
        const ids = ['shop', 'blog'].map(app => {
            const parent = apps.find(node => tree.getTreeItem(node).label === app);
            const tag = tree.getChildren(parent).find(node => tree.getTreeItem(node).label === 'Tag');

            assert.ok(tag);

            return tree.getTreeItem(tag).id;
        });

        assert.ok(ids[0] && ids[1]);
        assert.notStrictEqual(ids[0], ids[1]);
    });

    test('overview показывает состояние, числа моделей и длительность сканирования', () => {
        const overview = stub.registered.trees.get('djangoModelNavigator.overview');

        assert.ok(overview, 'overview не зарегистрирован');
        const rows = overview.getChildren().map(node => overview.getTreeItem(node));

        assert.strictEqual(rows.find(row => row.label === 'Index')?.description, 'Ready');
        assert.strictEqual(rows.find(row => row.label === 'Project models')?.description, '10');
        assert.ok(Number(rows.find(row => row.label === 'Built-in models')?.description) > 0);
        assert.ok(rows.find(row => row.label === 'Last scan')?.description?.endsWith(' ms'));
        assert.notStrictEqual(rows.find(row => row.label === 'Last update')?.description, 'Not yet');
    });

    test('иконки overview используют единый цвет темы без акцента класса', () => {
        const overview = stub.registered.trees.get('djangoModelNavigator.overview');

        assert.ok(overview);
        const rows = overview.getChildren().map(node => overview.getTreeItem(node));

        for (const row of rows) {
            assert.ok(row.iconPath instanceof stub.ThemeIcon);
            assert.strictEqual(row.iconPath.color?.id, 'icon.foreground', String(row.label));
        }
    });

    test('раскрытие панели читает индекс без поиска и перечитывания файлов', () => {
        const tree = stub.registered.trees.get('djangoModelNavigator.models');
        const overview = stub.registered.trees.get('djangoModelNavigator.overview');

        assert.ok(tree && overview);
        const findFiles = stub.workspace.findFiles;
        const readFile = stub.workspace.fs.readFile;
        let searches = 0;
        let reads = 0;

        stub.workspace.findFiles = (...args) => {
            searches++;

            return findFiles(...args);
        };
        stub.workspace.fs.readFile = uri => {
            reads++;

            return readFile(uri);
        };

        try {
            for (let repeat = 0; repeat < 20; repeat++) {
                for (const app of tree.getChildren()) {
                    for (const model of tree.getChildren(app)) {
                        tree.getTreeItem(model);
                        tree.getChildren(model).forEach(field => tree.getTreeItem(field));
                    }
                }
                overview.getChildren();
            }

            assert.strictEqual(searches, 0);
            assert.strictEqual(reads, 0);
        } finally {
            stub.workspace.findFiles = findFiles;
            stub.workspace.fs.readFile = readFile;
        }
    });

    group('code lens');

    test('над каждой моделью файла появляется лендза', () => {
        const document = stub.TextDocument.fromFile(SHOP);
        const lenses: stub.CodeLens[] = stub.registered.codeLens[0].provideCodeLenses(document);

        const titles = lenses.map(lens => lens.command?.title ?? '');

        assert.strictEqual(lenses.length, 5, `лендз: ${titles.join(' | ')}`);
        assert.ok(titles.every(title => title.includes('field(s)')));

        const clientLens = lenses.find(
            lens => document.lineAt(lens.range.start.line).text.startsWith('class Client(')
        );

        assert.ok(clientLens?.command, 'нет лендзы над моделью Client');
        assert.ok(clientLens.command.title.includes('usage(s)'));
        assert.strictEqual(clientLens.command.command, 'djangoModelNavigator.showReferences');
    });

    test('переключение enableCodeLens сразу обновляет лендзы', () => {
        const previous = stub.configValues.enableCodeLens;
        const changed = { affectsConfiguration: (section: string) =>
            section === 'djangoModelNavigator' || section === 'djangoModelNavigator.enableCodeLens' };
        let refreshed = 0;
        const subscription = stub.registered.codeLens[0].onDidChangeCodeLenses(() => refreshed++);

        try {
            stub.configValues.enableCodeLens = false;
            stub.emitters.config.fire(changed);

            assert.strictEqual(refreshed, 1, 'VS Code не узнал об отключении лендз');
            assert.deepStrictEqual(stub.registered.codeLens[0]
                .provideCodeLenses(stub.TextDocument.fromFile(SHOP)), []);
        } finally {
            subscription.dispose();
            if (previous === undefined) delete stub.configValues.enableCodeLens;
            else stub.configValues.enableCodeLens = previous;
            stub.emitters.config.fire(changed);
        }
    });

    test('в файле без моделей лендз нет', () => {
        const lenses = stub.registered.codeLens[0].provideCodeLenses(
            doc(['print("no models here")'])
        );

        assert.deepStrictEqual(lenses, []);
    });
});

