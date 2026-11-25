import { inspectT3Default } from '../../src/T3DefaultModel.js';

// Read-only: never export or print any other T3 settings, credentials or local paths.
try {
    const result = await inspectT3Default();
    process.stdout.write(JSON.stringify(result) + '\n');
} catch {
    process.stdout.write(JSON.stringify({
        status: 'unavailable',
        detail: 'Unable to read T3 Desktop model preferences.',
    }) + '\n');
}
