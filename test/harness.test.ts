/** Check that the runner cannot report success for a suite that never finished */

import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { group, test } from './harness';

group('тестовый раннер');

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

test('набор, не дошедший до конца, завершается с ошибкой', () => {
    // An awaited promise that never settles empties the event loop without a summary
    assert.notStrictEqual(exitCodeFor('new Promise(() => undefined)'), 0);
});

test('завершённый набор без ошибок выходит с кодом 0', () => {
    assert.strictEqual(exitCodeFor('Promise.resolve()'), 0);
});

test('отклонённый набор завершается с ошибкой', () => {
    assert.notStrictEqual(exitCodeFor('Promise.reject(new Error("broken"))'), 0);
});
