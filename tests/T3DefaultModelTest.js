import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { inspectT3Default, normalizeT3ModelSelection } from '../src/T3DefaultModel.js';

test('official T3 New threads default can be copied with its model and exact reasoning options', () => {
    const selection = normalizeT3ModelSelection({
        instanceId: 'provider-terra',
        model: 'terra-model',
        options: [
            { id: 'reasoningEffort', value: 'medium' },
            { id: 'approvalRequired', value: false },
        ],
    });
    assert.deepEqual(selection, {
        instanceId: 'provider-terra',
        model: 'terra-model',
        options: { reasoningEffort: 'medium', approvalRequired: false },
    });
});

test('T3 legacy option dictionary stays supported without inventing model IDs', () => {
    const selection = normalizeT3ModelSelection({
        instanceId: 'claudeAgent',
        model: 'claude-sonnet-5-5',
        options: { effort: 'high' },
    });
    assert.deepEqual(selection.options, { effort: 'high' });
});

test('no model, invalid fields and duplicate option keys cannot silently choose a different model', () => {
    assert.equal(normalizeT3ModelSelection(null), null);
    assert.throws(() => normalizeT3ModelSelection({ model: 'terra' }), /instanceId/);
    assert.throws(() => normalizeT3ModelSelection({
        instanceId: 'a', model: 'b', options: [
            { id: 'reasoning', value: 'low' }, { id: 'reasoning', value: 'high' },
        ],
    }), /duplicate/);
    assert.throws(() => normalizeT3ModelSelection({
        instanceId: 'a', model: 'b', options: [{ id: 'effort', value: 100 }],
    }), /options/);
});

test('installer reads only the T3 settings field from the real userdata layout, never secrets', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'awg-t3-default-'));
    const script = new URL('../scripts/windows/Read-T3DefaultModel.mjs', import.meta.url);
    try {
        assert.deepEqual((await inspectT3Default({ t3Home: home })).status, 'missing');
        await mkdir(path.join(home, 'userdata'));
        await writeFile(path.join(home, 'userdata', 'settings.json'), JSON.stringify({
            defaultModelSelection: {
                instanceId: 'terra-provider', model: 'terra-1',
                options: [{ id: 'effort', value: 'medium' }],
            },
            secretProviders: { privateToken: 'DONT-DISCLOSE-THIS' },
        }));
        const parsed = JSON.parse(execFileSync(process.execPath, [fileURLToPath(script)], {
            env: { ...process.env, T3CODE_HOME: home },
            encoding: 'utf8',
        }));
        assert.equal(parsed.status, 'found');
        assert.deepEqual(parsed.selection, {
            instanceId: 'terra-provider', model: 'terra-1', options: { effort: 'medium' },
        });
        assert.doesNotMatch(JSON.stringify(parsed), /privateToken|DONT-DISCLOSE-THIS/);

        const persisted = JSON.parse(await readFile(path.join(home, 'userdata', 'settings.json'), 'utf8'));
        assert.equal(persisted.secretProviders.privateToken, 'DONT-DISCLOSE-THIS',
            'Installer must never modify T3 Desktop settings.');
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test('T3 settings file without an explicit New threads default yields no pin', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'awg-t3-default-empty-'));
    try {
        await mkdir(path.join(home, 'userdata'));
        await writeFile(path.join(home, 'userdata', 'settings.json'), JSON.stringify({
            defaultModelSelection: null,
        }));
        const result = await inspectT3Default({ t3Home: home });
        assert.equal(result.status, 'unset');
        assert.equal(result.selection, undefined);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});
