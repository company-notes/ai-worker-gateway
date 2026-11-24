import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { WorkerConfig } from '../src/WorkerConfig.js';
import { WorkerGateway } from '../src/WorkerGateway.js';

const sharedMcpKey = 'one-mcp-key-for-many-bots-abcdefghijklmnopqrstuvwxyz';
let folder;
let fleet;
let gateway;
let address;
let testsSent;

async function rpc(name, args = {}, key = sharedMcpKey) {
    const response = await fetch(address + '/mcp', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
        }),
    });
    return { status: response.status, body: await response.json() };
}

before(async () => {
    folder = await mkdtemp(path.join(os.tmpdir(), 'awg-form-route-test-'));
    testsSent = [];
    fleet = createServer(async (req, res) => {
        const chunks = [];
        for await (const part of req) chunks.push(part);
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        let result;
        if (input.method === 'tools/call' && input.params?.name === 'work_feed') {
            result = { content: [{ type: 'text', text: 'feed' }],
                structuredContent: { events: [], nextCursor: '0', hasMore: false } };
        } else if (input.method === 'tools/call' && input.params?.name === 'work_start') {
            result = { content: [{ type: 'text', text: 'started' }],
                structuredContent: { job: { jobId: 'routedjob11', state: 'queued' } } };
        } else {
            result = { content: [{ type: 'text', text: 'okay' }] };
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }));
    });
    await new Promise((resolve) => fleet.listen(0, '127.0.0.1', resolve));

    gateway = new WorkerGateway(WorkerConfig.fromEnvironment({
        AWG_CLIENT_TOKEN: sharedMcpKey,
        AWG_UPSTREAM_TOKEN: 'original-fleet-key-abcdefghijklmnopqrstuvwxyz',
        AWG_NOTIFICATION_STORAGE_KEY: 'stable-notification-key-abcdefghijklmnopqrstuvwxyz',
        AWG_NOTIFICATION_STATE_DIR: folder,
        AWG_UPSTREAM_MCP_URL: 'http://127.0.0.1:' + fleet.address().port + '/mcp',
        AWG_LISTEN_PORT: '0',
    }), { webhookSender: { deliver: async (_settings, event) => { testsSent.push(event); } } });
    await gateway.listen();
    address = 'http://127.0.0.1:' + gateway.server.address().port;
});

after(async () => {
    await gateway.close();
    await new Promise((resolve) => fleet.close(resolve));
    await rm(folder, { recursive: true, force: true });
});

test('the shared MCP bearer authorizes tools, but does not identify a bot or reveal a webhook', async () => {
    const result = await rpc('worker_notification_status');
    assert.equal(result.status, 200);
    assert.equal(result.body.result.structuredContent.preference, 'unset');
    assert.equal((await rpc('worker_notification_status', {}, 'wrong-key')).status, 401);
});

test('pairing form is local-only, same-origin and does not leak receiver secret to MCP', async () => {
    const setup = await rpc('worker_notification_setup');
    const { setupId, url } = setup.body.result.structuredContent;
    assert.ok(url.startsWith(address));
    assert.equal((await fetch(url)).status, 200);

    const form = new URLSearchParams({
        name: 'Sage', url: 'https://example.invalid/callback',
        header: 'Authorization', secret: 'secret-only-in-local-form',
    });
    const attack = await fetch(url, {
        method: 'POST',
        headers: { origin: 'https://attacker.example', 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
    });
    assert.equal(attack.status, 403);

    const legitimate = await fetch(url, {
        method: 'POST',
        headers: { origin: address, 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
    });
    assert.equal(legitimate.status, 200);
    assert.doesNotMatch(await legitimate.text(), /secret-only-in-local-form|[a-f0-9]{64}/);

    const paired = await rpc('worker_notification_pairing_status', { setupId });
    const route = paired.body.result.structuredContent.notificationRouteId;
    assert.match(route, /^[a-f0-9]{64}$/);
    assert.equal((await rpc('worker_notification_status', {
        notificationRouteId: route,
    })).body.result.structuredContent.enabled, true);
    assert.equal((await fetch(url)).status, 200, 'Pairing GET may display a safe confirmation page.');
    assert.equal(testsSent.filter((x) => x.event === 'work.webhook_test').length, 1);

    const started = await rpc('work_start', {
        task: 'Make an analysis', requestId: 'paired-start',
        notificationRouteId: route,
    });
    assert.equal(started.body.result.isError, undefined);
    assert.ok(gateway.notifications.store.data.jobs.routedjob11,
        'A shared MCP connection must use the route handle provided in the dispatch, not a shared bearer identity.');
    const forged = await rpc('worker_notification_status', { notificationRouteId: '0'.repeat(64) });
    assert.equal(forged.body.result.isError, true);
});

test('decline stores an off-route without any webhook; bogus route is refused before work dispatch', async () => {
    const declined = await rpc('worker_notification_decline');
    assert.equal(declined.body.result.structuredContent.preference, 'off');
    const route = declined.body.result.structuredContent.notificationRouteId;
    assert.equal((await rpc('worker_notification_status', {
        notificationRouteId: route,
    })).body.result.structuredContent.preference, 'off');
    const rejected = await rpc('work_start', {
        task: 'Should not bind', requestId: 'off-route-test',
        notificationRouteId: route,
    });
    assert.equal(rejected.body.result.isError, true);
});
