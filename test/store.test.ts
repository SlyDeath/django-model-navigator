/** Test cache updates from file and configuration events using isolated temporary files */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { group, testAsync } from './harness';
import { extensionModule, subscriptions } from './providers.test';
import * as stub from './vscode-stub';

/** Allow the debounce timer to fire before checking published results */
const DEBOUNCE_WAIT_MS = 700;

function wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function completions(code: string[], needle: string): string[] {
    const document = new stub.TextDocument(path.join(os.tmpdir(), 'views.py'), code.join('\n'));
    const line = code.findIndex(text => text.includes(needle));
    const position = new stub.Position(line, code[line].indexOf(needle) + needle.length);

    const items = stub.registered.completion[0].provideCompletionItems(document, position);

    return (items ?? []).map((item: stub.CompletionItem) => item.label);
}

/** Run store tests sequentially because they share extension state and workspace files */
export async function run(): Promise<void> {
    const temporary = path.join(__dirname, '..', '..', 'tmp');

    fs.mkdirSync(temporary, { recursive: true });

    const root = fs.mkdtempSync(path.join(temporary, 'dmn-store-'));
    const appDir = path.join(root, 'temp_app');
    const modelsFile = path.join(appDir, 'models.py');

    fs.mkdirSync(appDir, { recursive: true });

    group('обновление кэша');

    await testAsync('новый файл моделей попадает в кэш', async () => {
        fs.writeFileSync(
            modelsFile,
            [
                'from django.db import models',
                '',
                '',
                'class Draft(models.Model):',
                '    title = models.CharField(max_length=10)'
            ].join('\n')
        );

        stub.setWorkspaceFiles([...stub.workspaceFiles, modelsFile]);
        stub.emitters.create.fire(stub.Uri.file(modelsFile));

        await wait(DEBOUNCE_WAIT_MS);

        const labels = completions(['draft = Draft.objects.first()', 'print(draft.)'], 'draft.');

        assert.ok(labels.includes('title'), `нет поля title: ${labels.join(', ')}`);
    });

    await testAsync('сохранение файла обновляет только его', async () => {
        fs.writeFileSync(
            modelsFile,
            [
                'from django.db import models',
                '',
                '',
                'class Draft(models.Model):',
                '    title = models.CharField(max_length=10)',
                '    summary = models.TextField()'
            ].join('\n')
        );

        stub.emitters.save.fire(stub.TextDocument.fromFile(modelsFile));

        await wait(DEBOUNCE_WAIT_MS);

        const labels = completions(['draft = Draft.objects.first()', 'print(draft.)'], 'draft.');

        assert.ok(labels.includes('summary'), `нет нового поля: ${labels.join(', ')}`);

        // Verify that a partial update preserves models from other files
        const other = completions(['client = Client.objects.first()', 'print(client.)'], 'client.');

        assert.ok(other.includes('name'), 'потеряны модели из других файлов');
    });

    await testAsync('удаление файла убирает модель из кэша', async () => {
        fs.rmSync(modelsFile);

        stub.setWorkspaceFiles(stub.workspaceFiles.filter(file => file !== modelsFile));
        stub.emitters.remove.fire(stub.Uri.file(modelsFile));

        await wait(DEBOUNCE_WAIT_MS);

        const labels = completions(['draft = Draft.objects.first()', 'print(draft.)'], 'draft.');

        assert.deepStrictEqual(labels, [], 'модель осталась в кэше');
    });

    await testAsync('изменение настроек пересканирует workspace', async () => {
        stub.configValues['hoverMaxFields'] = 5;
        stub.emitters.config.fire({ affectsConfiguration: () => true });

        await wait(DEBOUNCE_WAIT_MS);

        const labels = completions(['client = Client.objects.first()', 'print(client.)'], 'client.');

        assert.ok(labels.includes('name'), 'кэш не восстановился после пересканирования');
    });

    await testAsync('панель показывает сканирование и обновляет дерево после создания и удаления модели', async () => {
        const tree = stub.registered.trees.get('djangoModelNavigator.models');
        const overview = stub.registered.trees.get('djangoModelNavigator.overview');

        assert.ok(tree && overview);
        const previousFiles = [...stub.workspaceFiles];
        const originalRead = stub.workspace.fs.readFile;
        let release: (() => void) | undefined;
        let started: () => void = () => undefined;
        const reading = new Promise<void>(resolve => { started = resolve; });
        let changes = 0;
        const listener = tree.onDidChangeTreeData(() => changes++);
        const phase = () => overview.getChildren().map(node => overview.getTreeItem(node))
            .find(item => item.label === 'Index')?.description;

        fs.writeFileSync(modelsFile, 'class PaneEntry(models.Model):\n    title = models.CharField()');
        stub.setWorkspaceFiles([...previousFiles, modelsFile]);
        stub.workspace.fs.readFile = uri => {
            if (uri.fsPath !== modelsFile) return originalRead(uri);

            const bytes = fs.readFileSync(uri.fsPath);

            return new Promise<Buffer>(resolve => {
                release = () => resolve(bytes);
                started();
            });
        };
        const scan = stub.commands.executeCommand('djangoModelNavigator.updateCache');

        try {
            await reading;
            assert.strictEqual(phase(), 'Scanning...');
            assert.ok(release);
            release();
            stub.workspace.fs.readFile = originalRead;
            await scan;
            assert.strictEqual(phase(), 'Ready');
            assert.ok(changes > 0, 'дерево не уведомлено о новом индексе');
            const app = tree.getChildren().find(node => tree.getTreeItem(node).label === 'temp_app');

            assert.ok(app);
            assert.ok(tree.getChildren(app).some(node => tree.getTreeItem(node).label === 'PaneEntry'));
            fs.rmSync(modelsFile);
            stub.setWorkspaceFiles(previousFiles);
            stub.emitters.remove.fire(stub.Uri.file(modelsFile));
            await wait(DEBOUNCE_WAIT_MS);
            assert.ok(!tree.getChildren().some(node => tree.getTreeItem(node).label === 'temp_app'));
        } finally {
            release?.();
            listener.dispose();
            stub.workspace.fs.readFile = originalRead;
            stub.setWorkspaceFiles(previousFiles);
            await stub.commands.executeCommand('djangoModelNavigator.updateCache');
        }
    });

    await testAsync('добавление модели сбрасывает отрицательный кеш неизменённого документа', async () => {
        const document = new stub.TextDocument(path.join(root, 'views.py'),
            'entry = FreshEntry.objects.first()\nentry.');
        const labels = () => {
            const items: stub.CompletionItem[] = stub.registered.completion[0]
                .provideCompletionItems(document, new stub.Position(1, 6)) ?? [];

            return items.map(item => item.label);
        };

        assert.deepStrictEqual(labels(), []);
        fs.writeFileSync(modelsFile, 'class FreshEntry(models.Model):\n    title = models.CharField()');
        stub.setWorkspaceFiles([...stub.workspaceFiles, modelsFile]);
        await stub.commands.executeCommand('djangoModelNavigator.updateCache');

        assert.ok(labels().includes('title'), 'отрицательный кеш пережил обновление индекса');
    });

    await testAsync('дополнительный glob обновляет индекс при создании и сохранении нового файла', async () => {
        const extraFile = path.join(appDir, 'order_models.py');
        const previousFiles = [...stub.workspaceFiles];

        stub.configValues['additionalModelPaths'] = ['**/*_models.py'];
        stub.emitters.config.fire({ affectsConfiguration: () => true });
        await wait(DEBOUNCE_WAIT_MS);

        try {
            fs.writeFileSync(extraFile, 'class Order(models.Model):\n    number = models.CharField()');
            stub.setWorkspaceFiles([...previousFiles, extraFile]);
            stub.emitters.create.fire(stub.Uri.file(extraFile));
            await wait(DEBOUNCE_WAIT_MS);
            assert.ok(completions(['row = Order.objects.first()', 'row.'], 'row.').includes('number'),
                'новый файл по glob не проиндексирован');

            fs.writeFileSync(extraFile, 'class Order(models.Model):\n    changed = models.CharField()');
            stub.emitters.save.fire(stub.TextDocument.fromFile(extraFile));
            await wait(DEBOUNCE_WAIT_MS);
            assert.ok(completions(['row = Order.objects.first()', 'row.'], 'row.').includes('changed'));
        } finally {
            delete stub.configValues['additionalModelPaths'];
            stub.setWorkspaceFiles(previousFiles);
            await stub.commands.executeCommand('djangoModelNavigator.updateCache');
        }
    });

    await testAsync('перекрывающиеся сохранения разных файлов сохраняют оба обновления', async () => {
        const otherFile = path.join(root, 'other', 'models.py');
        const previousFiles = [...stub.workspaceFiles];
        const originalRead = stub.workspace.fs.readFile;
        let release: (() => void) | undefined;

        fs.mkdirSync(path.dirname(otherFile), { recursive: true });
        fs.writeFileSync(modelsFile, 'class Alpha(models.Model):\n    old_alpha = models.CharField()');
        fs.writeFileSync(otherFile, 'class Beta(models.Model):\n    old_beta = models.CharField()');
        stub.setWorkspaceFiles([...new Set([...previousFiles, modelsFile, otherFile])]);
        await stub.commands.executeCommand('djangoModelNavigator.updateCache');

        try {
            fs.writeFileSync(modelsFile, 'class Alpha(models.Model):\n    new_alpha = models.CharField()');
            fs.writeFileSync(otherFile, 'class Beta(models.Model):\n    new_beta = models.CharField()');
            stub.workspace.fs.readFile = uri => {
                if (uri.fsPath !== modelsFile) return originalRead(uri);

                const bytes = fs.readFileSync(uri.fsPath);

                return new Promise<Buffer>(resolve => { release = () => resolve(bytes); });
            };
            stub.emitters.save.fire(stub.TextDocument.fromFile(modelsFile));
            await wait(DEBOUNCE_WAIT_MS);
            assert.ok(release, 'чтение первого файла не началось');
            stub.emitters.save.fire(stub.TextDocument.fromFile(otherFile));
            await wait(DEBOUNCE_WAIT_MS);
            release();
            stub.workspace.fs.readFile = originalRead;
            await wait(DEBOUNCE_WAIT_MS);

            assert.ok(completions(['row = Alpha.objects.first()', 'row.'], 'row.').includes('new_alpha'),
                'обновление первого файла потеряно');
            assert.ok(completions(['row = Beta.objects.first()', 'row.'], 'row.').includes('new_beta'));
        } finally {
            release?.();
            stub.workspace.fs.readFile = originalRead;
            stub.setWorkspaceFiles(previousFiles);
            await stub.commands.executeCommand('djangoModelNavigator.updateCache');
        }
    });

    fs.rmSync(root, { recursive: true, force: true });

    group('deactivate');

    await testAsync('деактивация отбрасывает результат незавершённого сканирования', async () => {
        const originalRead = stub.workspace.fs.readFile;
        let release: (bytes: Buffer) => void = () => undefined;
        let started: () => void = () => undefined;
        const reading = new Promise<void>(resolve => { started = resolve; });

        stub.setWorkspaceFiles([path.join(root, 'late', 'models.py')]);
        stub.workspace.fs.readFile = () => new Promise<Buffer>(resolve => {
            release = resolve;
            started();
        });

        const scan = stub.commands.executeCommand('djangoModelNavigator.updateCache');

        try {
            await reading;
            subscriptions.forEach(item => item.dispose());
            extensionModule.deactivate();
            assert.strictEqual(stub.registered.trees.size, 0, 'деревья не сняты с регистрации');
            release(Buffer.from('class LateEntry(models.Model):\n    title = models.CharField()'));
            await scan;

            assert.deepStrictEqual(completions(['row = LateEntry.objects.first()', 'row.'], 'row.'), []);
        } finally {
            release(Buffer.alloc(0));
            stub.workspace.fs.readFile = originalRead;
        }
    });
}
