/** Check that the runner cannot report success for a suite that never finished */

import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { group, test } from './harness';

group('test runner');

/** Run a suite promise through the harness in a separate Node process */
function exitCodeFor(suite: string): number | null {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmn-harness-'));
    const script = path.join(dir, 'suite.js');

    try {
        fs.writeFileSync(script, `const { finish } = require(${JSON.stringify(
            path.join(__dirname, 'harness.js'))});\nfinish(${suite});\n`);

        return spawnSync(process.execPath, [script], { encoding: 'utf8' }).status;
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test('a suite that never finishes exits with an error', () => {
    // An awaited promise that never settles empties the event loop without a summary
    assert.notStrictEqual(exitCodeFor('new Promise(() => undefined)'), 0);
});

test('a finished suite without failures exits with code 0', () => {
    assert.strictEqual(exitCodeFor('Promise.resolve()'), 0);
});

test('a rejected suite exits with an error', () => {
    assert.notStrictEqual(exitCodeFor('Promise.reject(new Error("broken"))'), 0);
});
