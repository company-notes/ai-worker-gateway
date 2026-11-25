import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { WorkerConfig } from '../src/WorkerConfig.js';
import { UpstreamMCPClient } from '../src/UpstreamMCPClient.js';

const selection = {
    instanceId: 'terra-provider',
    model: 'terra-model',
    options: { reasoningEffort: 'medium', disableFastMode: false },
};

function configEnv(extra = {}) {
    return {
        AWG_CLIENT_TOKEN: 'client-token-012345678901234567890123',
        AWG_UPSTREAM_TOKEN: 'server-token-012345678901234567890123',
        AWG_DEFAULT_MODEL_SELECTION: JSON.stringify(selection),
        AWG_PROVISION_HOST: 'my-pc',
        AWG_WORKSPACE_ROOT: '/tmp/authorized-worker-root',
        ...extra,
    };
}

test('the Gateway loads the installed T3 model default and all option values', () => {
    const config = WorkerConfig.fromEnvironment(configEnv());
    assert.deepEqual(config.defaultModelSelection, selection);
    assert.throws(() => WorkerConfig.fromEnvironment(configEnv({
        AWG_DEFAULT_MODEL_SELECTION: JSON.stringify({ instanceId: '', model: 'terra' }),
    })), /instanceId/);
});

test('only a new managed target without an explicit choice gets the local Gateway default', async () => {
    const forwarded = [];
    const upstream = createServer(async (request, response) => {
        const parts = [];
        for await (const part of request) parts.push(part);
        const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
        forwarded.push(body);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {
            content: [{ type: 'text', text: 'okay' }],
        } }));
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    try {
        const client = new UpstreamMCPClient(
            'http://127.0.0.1:' + upstream.address().port + '/mcp',
            'private-upstream-token',
            { defaultModelSelection: selection, defaultHost: 'my-pc' },
        );

        async function send(name, args) {
            await client.callTool(name, args);
            return forwarded.at(-1).params.arguments;
        }

        const first = await send('work_start', {
            target: { host: 'my-pc', projectId: 't3-project-1' },
            task: 'Build a chart', requestId: 't3-default-test',
        });
        assert.deepEqual(first.modelSelection, selection);
        assert.match(first.task, /commit/i);

        const explicit = { instanceId: 'user-chosen', model: 'different-model' };
        const chosen = await send('work_start', {
            target: { host: 'my-pc', projectId: 't3-project-1' },
            task: 'Use the user-selected model', requestId: 'explicit-override',
            modelSelection: explicit,
        });
        assert.deepEqual(chosen.modelSelection, explicit);

        const otherHost = await send('work_start', {
            target: { host: 'unrelated-host' }, task: 'Other machine',
        });
        assert.equal(otherHost.modelSelection, undefined);

        const alias = await send('work_start', {
            project: 'configured-alias', task: 'Respect Fleet project/host default',
        });
        assert.equal(alias.modelSelection, undefined,
            'Configured Fleet aliases can disable discovery, so preserve their own model policy.');

        const continued = await send('work_continue', { jobId: 'knownjob', message: 'Continue' });
        assert.equal(continued.modelSelection, undefined);
    } finally {
        await new Promise((resolve) => upstream.close(resolve));
    }
});
