/** Dependency-free test runner using Node assertions and sequential async tests */

let failures = 0;
let passed = 0;

/** Print a test-group label */
export function group(name: string): void {
    console.log(`\n${name}`);
}

/** Run a synchronous assertion and record its outcome without stopping the suite */
export function test(name: string, body: () => void): void {
    try {
        body();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (error) {
        failures++;
        console.log(`  ✗ ${name}`);
        console.log(`    ${error instanceof Error ? error.message : error}`);
    }
}

/** Await an asynchronous assertion and record its outcome without stopping the suite */
export async function testAsync(name: string, body: () => Promise<void>): Promise<void> {
    try {
        await body();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (error) {
        failures++;
        console.log(`  ✗ ${name}`);
        console.log(`    ${error instanceof Error ? error.message : error}`);
    }
}

/** Print accumulated results and return a process exit code */
export function summary(): number {
    console.log(`\n${passed} passed, ${failures} failed`);

    return failures > 0 ? 1 : 0;
}

/**
 * Exit with the summary once the whole suite has settled
 * Node exits with code 0 when an awaited promise never settles, so an unfinished suite fails
 */
export function finish(suite: Promise<unknown>): void {
    process.once('beforeExit', () => {
        console.log('\nThe test suite did not finish: an awaited promise never settled');
        process.exit(1);
    });

    suite.then(() => process.exit(summary()), error => {
        console.log(`\nThe test suite stopped: ${error instanceof Error ? error.stack : error}`);
        process.exit(1);
    });
}
