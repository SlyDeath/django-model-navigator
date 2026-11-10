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

    assert.ok(line >= 0, 'the code has no | cursor marker');

    const character = lines[line].indexOf('|');

    lines[line] = lines[line].replace('|', '');

    return getLookupContext(index => lines[index] ?? '', line, character);
}

group('getLookupContext');

test('a kwarg name inside filter is recognized', () => {
    const context = parse('Review.objects.filter(client__name|=1)');

    assert.ok(context);
    assert.deepStrictEqual(context.segments, ['client', 'name']);
    assert.strictEqual(context.index, 1);
    assert.strictEqual(context.calls[0].callee, 'filter');
    assert.deepStrictEqual(context.calls[0].receiver, ['Review', 'objects']);
    assert.strictEqual(context.inString, false);
});

test('cursor on the first path segment', () => {
    const context = parse('Review.objects.filter(cli|ent__name=1)');

    assert.strictEqual(context?.index, 0);
    assert.deepStrictEqual(context?.segments, ['client', 'name']);
});

test('an empty segment after a double underscore', () => {
    const context = parse('Review.objects.filter(client__|)');

    assert.strictEqual(context?.index, 1);
    assert.deepStrictEqual(context?.segments, ['client', '']);
});

test('the segment start points to its first character', () => {
    const code = 'Review.objects.filter(client__na|me=1)';
    const context = parse(code);

    assert.strictEqual(context?.segmentStart, code.indexOf('client__') + 'client__'.length);
});

test('an order_by string argument with a minus', () => {
    const context = parse('Review.objects.order_by("-client__nam|e")');

    assert.ok(context?.inString);
    assert.deepStrictEqual(context?.segments, ['client', 'name']);
    assert.strictEqual(context?.index, 1);
});

test('a multiline call', () => {
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

test('a chain after a closed call keeps the model', () => {
    const context = parse('Review.objects.filter(text="a").exclude(client__nam|e="b")');

    assert.strictEqual(context?.calls[0].callee, 'exclude');
    assert.deepStrictEqual(context?.calls[0].receiver, ['Review', 'objects', 'filter']);
});

test('Q inside filter yields both calls', () => {
    const context = parse('Review.objects.filter(Q(client__nam|e="b"))');

    assert.strictEqual(context?.calls[0].callee, 'Q');
    assert.strictEqual(context?.calls[1].callee, 'filter');
});

test('an argument value is not treated as a lookup path', () => {
    assert.strictEqual(parse('Review.objects.filter(text=client.nam|e)'), null);
});

test('there is no context outside parentheses', () => {
    assert.strictEqual(parse('client.nam|e'), null);
});

test('a comment does not open a call', () => {
    assert.strictEqual(parse('x = 1  # filter(client__nam|e)'), null);
});

group('stripQuerysetTokens');

test('service names are dropped from the end', () => {
    assert.deepStrictEqual(
        stripQuerysetTokens(['Review', 'objects', 'filter', 'exclude']),
        ['Review']
    );
    assert.deepStrictEqual(stripQuerysetTokens(['client', 'review_set']), ['client', 'review_set']);
});

group('readChainForward');

test('the chain is read up to the first unrelated character', () => {
    assert.deepStrictEqual(readChainForward('site.employees.all()'), ['site', 'employees', 'all']);
    assert.deepStrictEqual(readChainForward('staff:\n    print(x)'), ['staff']);
});

test('call arguments and indexes are skipped', () => {
    assert.deepStrictEqual(
        readChainForward('Site.objects.filter(name="a, b").first()'),
        ['Site', 'objects', 'filter', 'first']
    );
    assert.deepStrictEqual(readChainForward('rows[0].client'), ['rows', 'client']);
});

test('leading parentheses and spaces do not interfere', () => {
    assert.deepStrictEqual(readChainForward('  ( Site.objects.all()'), ['Site', 'objects', 'all']);
});

group('readCallArguments');

test('call arguments by name', () => {
    assert.strictEqual(readCallArguments('sorted(sites, key=f)'), 'sites, key=f');
});

test('arguments are not taken from a chained method call', () => {
    assert.strictEqual(readCallArguments('site.employees.all()'), null);
});
