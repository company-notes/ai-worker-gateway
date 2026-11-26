import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { WorkerConfig } from '../src/WorkerConfig.js';
import { WorkerGateway } from '../src/WorkerGateway.js';

const commonKey = 'one-shared-mcp-token-across-all-bots-0123456789';
let root;
let gateway;
let fleet;
let address;
let forwarded;
let delivered;
let nextJobId;

async function rpc(name, args = {}) {
    const res = await fetch(address + '/mcp', {
        method: 'POST',
        headers: {
            authorization: 'Bearer ' + commonKey,
            'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
            params: { name, arguments: args } }),
    });
    return { status: res.status, result: (await res.json()).result };
}

before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'awg-shared-mcp-test-'));
    forwarded = [];
    delivered = [];
    nextJobId = 0;
    fleet = createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        forwarded.push(message);
        let result;
        if (message.method === 'tools/call' && message.params.name === 'work_start') {
            result = { content: [{ type: 'text', text: 'started' }],
                structuredContent: { job: {
                    jobId: 'sharedjob' + (++nextJobId), state: 'queued',
                }, created: true } };
        } else if (message.method === 'tools/call' && message.params.name === 'work_feed') {
            result = { content: [{ type: 'text', text: 'events' }],
                structuredContent: { events: [], nextCursor: '0', hasMore: false } };
        } else if (message.method === 'tools/call' && message.params.name === 'fleet_status') {
            result = { content: [{ type: 'text', text: 'fleet' }], structuredContent: {
                hosts: [{ id: 'my-pc', defaultProject: 'authorized-scratch', reachable: true }],
                projects: [{ alias: 'authorized-scratch', host: 'my-pc',
                    workspaceMode: 'scratch', allowWorkStart: true }],
            } };
        } else {
            result = { content: [{ type: 'text', text: 'okay' }] };
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
    await new Promise((resolve) => fleet.listen(0, '127.0.0.1', resolve));
    gateway = new WorkerGateway(WorkerConfig.fromEnvironment({
        AWG_CLIENT_TOKEN: commonKey,
        AWG_UPSTREAM_TOKEN: 'original-fleet-private-key-0123456789',
        AWG_NOTIFICATION_STATE_DIR: root,
        AWG_NOTIFICATION_STORAGE_KEY: 'long-lived-encryption-key-for-routes-0123456789',
        AWG_UPSTREAM_MCP_URL: 'http://127.0.0.1:' + fleet.address().port + '/mcp',
        AWG_LISTEN_PORT: '0',
    }), {
        webhookSender: { deliver: async (_webhook, event) => { delivered.push(event); } },
    });
    await gateway.listen();
    address = 'http://127.0.0.1:' + gateway.server.address().port;
});

after(async () => {
    await gateway.close();
    await new Promise((resolve) => fleet.close(resolve));
    await rm(root, { recursive: true, force: true });
});

test('webhook setup pairs to an opaque route handle, without issuing a different MCP credential', async () => {
    const setup = await rpc('worker_notification_setup');
    assert.equal(setup.result.isError, false);
    const url = setup.result.structuredContent.url;
    const setupId = setup.result.structuredContent.setupId;
    assert.ok(setupId);
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/notifications\/setup\/[A-Za-z0-9_-]{32}$/);
    const sent = await fetch(url, {
        method: 'POST', headers: {
            origin: address, 'content-type': 'application/x-www-form-urlencoded',
        }, body: new URLSearchParams({
            name: 'Sage', url: 'https://sage.example.invalid/notifications',
            header: 'Authorization', secret: 'sage-private-webhook-secret',
        }),
    });
    assert.equal(sent.status, 200);
    assert.doesNotMatch(await sent.text(), /single MCP key|專屬 MCP 金鑰|sage-private-webhook-secret/);

    const paired = await rpc('worker_notification_pairing_status', { setupId });
    assert.equal(paired.result.structuredContent.paired, true);
    const routeId = paired.result.structuredContent.notificationRouteId;
    assert.match(routeId, /^[a-f0-9]{64}$/);
    assert.equal((await rpc('worker_notification_status', { notificationRouteId: routeId }))
        .result.structuredContent.enabled, true);
    const encrypted = await readFile(path.join(root, 'assistant-webhooks.enc.json'), 'utf8');
    assert.doesNotMatch(encrypted, /sage-private-webhook-secret|notifications\.example|Sage|[a-f0-9]{64}/);
    globalThis.testRoute = routeId;
});

test('two assistants use one MCP connection but dispatch to different notification destinations', async () => {
    const setup = await rpc('worker_notification_setup');
    const sent = await fetch(setup.result.structuredContent.url, {
        method: 'POST', headers: {
            origin: address, 'content-type': 'application/x-www-form-urlencoded',
        }, body: new URLSearchParams({
            name: 'Noodle', url: 'https://noodle.example.invalid/hook',
            header: 'Authorization', secret: 'noodle-webhook-secret',
        }),
    });
    assert.equal(sent.status, 200);
    const paired = await rpc('worker_notification_pairing_status', {
        setupId: setup.result.structuredContent.setupId,
    });
    const noodleRoute = paired.result.structuredContent.notificationRouteId;
    assert.notEqual(noodleRoute, globalThis.testRoute);

    for (const route of [globalThis.testRoute, noodleRoute]) {
        const started = await rpc('work_start', {
            task: 'Produce the report', requestId: 'shared-' + route.slice(0, 8),
            notificationRouteId: route,
        });
        assert.equal(started.result.isError, undefined);
    }
    const calls = forwarded.filter((p) => p.params?.name === 'work_start');
    assert.equal(calls.length, 2);
    assert.ok(calls.every((p) => p.params.arguments.notificationRouteId === undefined),
        'Route handle is wrapper-local metadata and must never reach the strict upstream Fleet schema.');
    const jobs = gateway.notifications.store.data.jobs;
    assert.notEqual(jobs.sharedjob1, jobs.sharedjob2);
    assert.equal(jobs.sharedjob1, gateway.notifications.resolveRoute(globalThis.testRoute));
    assert.equal(jobs.sharedjob2, gateway.notifications.resolveRoute(noodleRoute));

    const bad = await rpc('work_start', {
        task: 'Unexpected work', requestId: 'badroute1',
        notificationRouteId: '0'.repeat(64),
    });
    assert.equal(bad.result.isError, true);
    assert.equal(forwarded.filter((p) => p.params?.name === 'work_start').length, 2,
        'An unknown or forged notification route must be rejected BEFORE launching any T3 job.');

    const noRoute = await rpc('work_start', {
        task: 'No notifications', requestId: 'norequest',
    });
    assert.equal(noRoute.result.isError, undefined);
    assert.equal(jobs.sharedjob3, undefined,
        'A shared MCP connection does not imply a default assistant or notification route.');
});

test('a route cannot reassign an existing job created for another assistant', async () => {
    await assert.rejects(gateway.notifications.store.trackJob(
        gateway.notifications.resolveRoute(globalThis.testRoute), 'sharedjob2',
    ), /different assistant/);
});

test('wrapper worker_task_start also accepts the same private route and strips metadata from Fleet', async () => {
    const result = await rpc('worker_task_start', {
        task: 'Make another report', requestId: 'shared-helper-route',
        notificationRouteId: globalThis.testRoute,
    });
    assert.notEqual(result.result.isError, true);
    assert.equal(gateway.notifications.store.data.jobs.sharedjob4,
        gateway.notifications.resolveRoute(globalThis.testRoute));
    const calls = forwarded.filter((p) => p.params?.name === 'work_start');
    const last = calls.at(-1);
    assert.equal(last.params.arguments.notificationRouteId, undefined);
    assert.equal(last.params.arguments.task.startsWith('Make another report'), true);
    assert.deepEqual(last.params.arguments.target, { host: 'my-pc' });
});
