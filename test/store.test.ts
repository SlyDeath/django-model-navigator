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

    group('cache updates');

    await testAsync('a new models file is cached', async () => {
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

        assert.ok(labels.includes('title'), `missing field title: ${labels.join(', ')}`);
    });

    await testAsync('saving a file updates only that file', async () => {
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

        assert.ok(labels.includes('summary'), `missing new field: ${labels.join(', ')}`);

        // Verify that a partial update preserves models from other files
        const other = completions(['client = Client.objects.first()', 'print(client.)'], 'client.');

        assert.ok(other.includes('name'), 'models from other files were lost');
    });

    await testAsync('deleting a file removes its model from the cache', async () => {
        fs.rmSync(modelsFile);

        stub.setWorkspaceFiles(stub.workspaceFiles.filter(file => file !== modelsFile));
        stub.emitters.remove.fire(stub.Uri.file(modelsFile));

        await wait(DEBOUNCE_WAIT_MS);

        const labels = completions(['draft = Draft.objects.first()', 'print(draft.)'], 'draft.');

        assert.deepStrictEqual(labels, [], 'model is still cached');
    });

    await testAsync('changing settings rescans the workspace', async () => {
        stub.configValues['hoverMaxFields'] = 5;
        stub.emitters.config.fire({ affectsConfiguration: () => true });

        await wait(DEBOUNCE_WAIT_MS);

        const labels = completions(['client = Client.objects.first()', 'print(client.)'], 'client.');

        assert.ok(labels.includes('name'), 'cache was not restored after the rescan');
    });

    await testAsync('panel shows scanning and refreshes tree on model add/delete', async () => {
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
            assert.ok(changes > 0, 'tree was not notified about the new index');
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

    await testAsync('a new model resets the negative cache of an unchanged document', async () => {
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

        assert.ok(labels().includes('title'), 'negative cache survived the index update');
    });

    await testAsync('an extra glob reindexes a new file on create and save', async () => {
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
                'new file matched by the glob was not indexed');

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

    await testAsync('overlapping saves of different files keep both updates', async () => {
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
            assert.ok(release, 'reading the first file did not start');
            stub.emitters.save.fire(stub.TextDocument.fromFile(otherFile));
            await wait(DEBOUNCE_WAIT_MS);
            release();
            stub.workspace.fs.readFile = originalRead;
            await wait(DEBOUNCE_WAIT_MS);

            assert.ok(completions(['row = Alpha.objects.first()', 'row.'], 'row.').includes('new_alpha'),
                'update of the first file was lost');
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

    await testAsync('deactivation discards the result of an unfinished scan', async () => {
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
            assert.strictEqual(stub.registered.trees.size, 0, 'trees were not unregistered');
            release(Buffer.from('class LateEntry(models.Model):\n    title = models.CharField()'));
            await scan;

            assert.deepStrictEqual(completions(['row = LateEntry.objects.first()', 'row.'], 'row.'), []);
        } finally {
            release(Buffer.alloc(0));
            stub.workspace.fs.readFile = originalRead;
        }
    });
}
