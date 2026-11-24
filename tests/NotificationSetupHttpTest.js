import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { WorkerConfig } from '../src/WorkerConfig.js';
import { WorkerGateway } from '../src/WorkerGateway.js';

const clientToken = 'single-public-mcp-token-abcdef123456789012';
const internalKey = 'private-stable-storage-key-abcdefghijklmnopqrstuvwxyz';

let stateDir;
let upstream;
let gateway;
let address;
let webhookTests = [];

async function call(toolName, args = {}, token = clientToken) {
    const response = await fetch(address + '/mcp', {
        method: 'POST',
        headers: {
            authorization: 'Bearer ' + token,
            'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
            name: toolName, arguments: args,
        } }),
    });
    return { status: response.status, body: await response.json() };
}

before(async () => {
    stateDir = await mkdtemp(path.join(os.tmpdir(), 'awg-form-test-'));
    upstream = createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) {
            chunks.push(chunk);
        }
        const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const result = rpc.method === 'tools/call' && rpc.params?.name === 'work_feed'
            ? { content: [{ type: 'text', text: 'feed' }],
                structuredContent: { events: [], nextCursor: '0', hasMore: false } }
            : rpc.method === 'tools/call' && rpc.params?.name === 'work_start'
                ? { content: [{ type: 'text', text: 'started' }],
                    structuredContent: { job: { jobId: 'newjob123', state: 'queued' }, created: true } }
                : { content: [{ type: 'text', text: 'okay' }] };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const config = WorkerConfig.fromEnvironment({
        AWG_CLIENT_TOKEN: clientToken,
        AWG_UPSTREAM_TOKEN: 'upstream-internal-token-abcdefghijklmnopqrstuvwxyz',
        AWG_NOTIFICATION_STORAGE_KEY: internalKey,
        AWG_NOTIFICATION_STATE_DIR: stateDir,
        AWG_UPSTREAM_MCP_URL: 'http://127.0.0.1:' + upstream.address().port + '/mcp',
        AWG_LISTEN_PORT: '0',
    });
    gateway = new WorkerGateway(config, {
        webhookSender: {
            async deliver(hook, event) {
                webhookTests.push({ hook, event });
            },
        },
    });
    await gateway.listen();
    address = 'http://127.0.0.1:' + gateway.server.address().port;
});

after(async () => {
    await gateway.close();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(stateDir, { recursive: true, force: true });
});

test('unconfigured bot offers one local setup link and accepts only same-origin browser POST', async () => {
    const state = await call('worker_notification_status');
    assert.equal(state.body.result.structuredContent.preference, 'unset');
    assert.equal(state.body.result.structuredContent.enabled, false);

    const setup = await call('worker_notification_setup');
    const pending = await call('worker_notification_status');
    assert.equal(pending.body.result.structuredContent.preference, 'pending',
        'An unanswered setup form must not cause the assistant to ask for notification consent every time.');
    const url = setup.body.result.structuredContent.url;
    assert.ok(url.startsWith(address + '/notifications/setup/'));
    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Webhook 網址/);

    const form = new URLSearchParams({
        mode: 'current', name: 'Sage',
        url: 'https://notifications.example.invalid/hook', header: 'Authorization',
        secret: 'secret-should-not-appear-in-chat',
    });
    const crossOrigin = await fetch(url, {
        method: 'POST', headers: {
            origin: 'https://evil.example',
            'content-type': 'application/x-www-form-urlencoded',
        }, body: form,
    });
    assert.equal(crossOrigin.status, 403);

    const save = await fetch(url, {
        method: 'POST', headers: {
            origin: address, 'content-type': 'application/x-www-form-urlencoded',
        }, body: form,
    });
    assert.equal(save.status, 200);
    const html = await save.text();
    assert.match(html, /通知已啟用/);
    assert.doesNotMatch(html, /secret-should-not-appear-in-chat/);
    assert.equal(webhookTests.at(-1).event.event, 'work.webhook_test');

    const current = await call('worker_notification_status');
    assert.equal(current.body.result.structuredContent.enabled, true);
    assert.doesNotMatch(JSON.stringify(current.body), /secret-should-not-appear-in-chat|notifications\.example\.invalid/);
    assert.equal((await fetch(url)).status, 400, 'A completed setup link cannot be reused');
});

test('dedicated client keys let independent assistants share the same MCP endpoint without crossing webhooks', async () => {
    const setup = await call('worker_notification_setup');
    const url = setup.body.result.structuredContent.url;
    const request = await fetch(url, {
        method: 'POST', headers: {
            origin: address, 'content-type': 'application/x-www-form-urlencoded',
        }, body: new URLSearchParams({
            mode: 'new', name: 'Noodle', url: 'https://other.example.invalid/receiver',
            header: 'X-Webhook-Key', secret: 'other-assistant-secret',
        }),
    });
    assert.equal(request.status, 200);
    const html = await request.text();
    const newToken = html.match(/<code>([a-f0-9]{64})<\/code>/)?.[1];
    assert.ok(newToken);
    assert.equal((await call('worker_notification_status', {}, newToken)).body.result.structuredContent.assistant, 'Noodle');
    assert.equal((await call('worker_notification_status', {}, 'wrong-token')).status, 401);

    const rpc = await fetch(address + '/mcp', {
        method: 'POST', headers: {
            authorization: 'Bearer ' + newToken, 'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'tools/call', params: {
            name: 'work_start', arguments: { task: 'Make a report', requestId: 'test-newjob-1' },
        } }),
    });
    assert.equal(rpc.status, 200);
    assert.equal(gateway.notifications.store.data.jobs.newjob123,
        gateway.notifications.identityFor(newToken),
        'The client identity is derived from the MCP bearer, not a spoofable name in work_start');
});

test('declining automatic updates persists the choice without requiring a webhook', async () => {
    const result = await call('worker_notification_decline');
    assert.equal(result.body.result.structuredContent.preference, 'off');
    const again = await call('worker_notification_status');
    assert.equal(again.body.result.structuredContent.preference, 'off');
    assert.equal(again.body.result.structuredContent.enabled, false);
});
