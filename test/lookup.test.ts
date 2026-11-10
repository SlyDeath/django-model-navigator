/** Test lookup-path cursor context and identifier-chain parsing without VS Code */

import * as assert from 'assert';

import {
    getLookupContext,
    readCallArguments,
    readChainForward,
    stripQuerysetTokens
} from '../src/lookup';
import { group, test } from './harness';

/** Read the cursor position marked with | in a source sample */
function parse(code: string) {
    const lines = code.split('\n');
    const line = lines.findIndex(text => text.includes('|'));

    assert.ok(line >= 0, 'в коде нет маркера курсора |');

    const character = lines[line].indexOf('|');

    lines[line] = lines[line].replace('|', '');

    return getLookupContext(index => lines[index] ?? '', line, character);
}

group('getLookupContext');

test('имя kwarg внутри filter распознаётся', () => {
    const context = parse('Review.objects.filter(client__name|=1)');

    assert.ok(context);
    assert.deepStrictEqual(context.segments, ['client', 'name']);
    assert.strictEqual(context.index, 1);
    assert.strictEqual(context.calls[0].callee, 'filter');
    assert.deepStrictEqual(context.calls[0].receiver, ['Review', 'objects']);
    assert.strictEqual(context.inString, false);
});

test('курсор на первом сегменте пути', () => {
    const context = parse('Review.objects.filter(cli|ent__name=1)');

    assert.strictEqual(context?.index, 0);
    assert.deepStrictEqual(context?.segments, ['client', 'name']);
});

test('пустой сегмент после двойного подчёркивания', () => {
    const context = parse('Review.objects.filter(client__|)');

    assert.strictEqual(context?.index, 1);
    assert.deepStrictEqual(context?.segments, ['client', '']);
});

test('начало сегмента указывает на его первый символ', () => {
    const code = 'Review.objects.filter(client__na|me=1)';
    const context = parse(code);

    assert.strictEqual(context?.segmentStart, code.indexOf('client__') + 'client__'.length);
});

test('строковый аргумент order_by с минусом', () => {
    const context = parse('Review.objects.order_by("-client__nam|e")');

    assert.ok(context?.inString);
    assert.deepStrictEqual(context?.segments, ['client', 'name']);
    assert.strictEqual(context?.index, 1);
});

test('многострочный вызов', () => {
    const context = parse(
        [
            'Review.objects.filter(',
            '    text="a",',
            '    client__nam|e="b",',
            ')'
        ].join('\n')
    );

    assert.deepStrictEqual(context?.segments, ['client', 'name']);
    assert.strictEqual(context?.calls[0].callee, 'filter');
});

test('цепочка после закрытого вызова не теряет модель', () => {
    const context = parse('Review.objects.filter(text="a").exclude(client__nam|e="b")');

    assert.strictEqual(context?.calls[0].callee, 'exclude');
    assert.deepStrictEqual(context?.calls[0].receiver, ['Review', 'objects', 'filter']);
});

test('Q внутри filter отдаёт оба вызова', () => {
    const context = parse('Review.objects.filter(Q(client__nam|e="b"))');

    assert.strictEqual(context?.calls[0].callee, 'Q');
    assert.strictEqual(context?.calls[1].callee, 'filter');
});

test('значение аргумента не считается lookup-путём', () => {
    assert.strictEqual(parse('Review.objects.filter(text=client.nam|e)'), null);
});

test('вне скобок контекста нет', () => {
    assert.strictEqual(parse('client.nam|e'), null);
});

test('комментарий не открывает вызов', () => {
    assert.strictEqual(parse('x = 1  # filter(client__nam|e)'), null);
});

group('stripQuerysetTokens');

test('служебные имена отбрасываются с конца', () => {
    assert.deepStrictEqual(
        stripQuerysetTokens(['Review', 'objects', 'filter', 'exclude']),
        ['Review']
    );
    assert.deepStrictEqual(stripQuerysetTokens(['client', 'review_set']), ['client', 'review_set']);
});

group('readChainForward');

test('цепочка читается до первого постороннего символа', () => {
    assert.deepStrictEqual(readChainForward('site.employees.all()'), ['site', 'employees', 'all']);
    assert.deepStrictEqual(readChainForward('staff:\n    print(x)'), ['staff']);
});

test('аргументы вызова и индексы пропускаются', () => {
    assert.deepStrictEqual(
        readChainForward('Site.objects.filter(name="a, b").first()'),
        ['Site', 'objects', 'filter', 'first']
    );
    assert.deepStrictEqual(readChainForward('rows[0].client'), ['rows', 'client']);
});

test('ведущие скобки и пробелы не мешают', () => {
    assert.deepStrictEqual(readChainForward('  ( Site.objects.all()'), ['Site', 'objects', 'all']);
});

group('readCallArguments');

test('аргументы вызова по имени', () => {
    assert.strictEqual(readCallArguments('sorted(sites, key=f)'), 'sites, key=f');
});

test('у вызова метода цепочки аргументы не берутся', () => {
    assert.strictEqual(readCallArguments('site.employees.all()'), null);
});
