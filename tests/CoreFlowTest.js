import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { WorkerConfig } from '../src/WorkerConfig.js';
import { WorkerGateway } from '../src/WorkerGateway.js';

class MCPTestClient {
    constructor(url, token) {
        this.url = url;
        this.token = token;
    }

    async request(method, params = {}, token = this.token) {
        const response = await fetch(this.url, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 42, method, params }),
        });
        return { status: response.status, body: await response.json() };
    }
}

class GatewayTestEnvironment {
    async start() {
        this.root = await mkdtemp(path.join(os.tmpdir(), 'awg-test-'));
        this.calls = [];
        this.upstream = createServer(async (request, response) => {
            const chunks = [];
            for await (const chunk of request) {
                chunks.push(chunk);
            }
            const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            this.calls.push({ authorization: request.headers.authorization, payload });

            const result = payload.method === 'tools/list'
                ? { tools: ['work_start', 'work_status', 'work_continue'].map((name) => ({ name, inputSchema: { type: 'object' } })) }
                : payload.method === 'tools/call'
                    ? { content: [{ type: 'text', text: payload.params.name === 'work_start' ? 'job-123' : payload.params.name === 'work_status' ? 'running:job-123' : 'continued:job-123' }] }
                    : { protocolVersion: '2025-06-18', serverInfo: { name: 'unmodified-upstream' }, capabilities: { tools: {} } };
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result }));
        });
        await new Promise((resolve) => this.upstream.listen(0, '127.0.0.1', resolve));
        const upstreamPort = this.upstream.address().port;
        const config = WorkerConfig.fromEnvironment({
            AWG_CLIENT_TOKEN: 'local-test-token-012345678901234567890',
            AWG_UPSTREAM_TOKEN: 'upstream-test-token-012345678901234567',
            AWG_UPSTREAM_MCP_URL: `http://127.0.0.1:${upstreamPort}/mcp`,
            AWG_LISTEN_PORT: '0',
            AWG_WORKSPACE_ROOT: this.root,
        });
        this.gateway = new WorkerGateway(config);
        const address = await this.gateway.listen();
        this.client = new MCPTestClient(`http://127.0.0.1:${address.port}/mcp`, config.clientToken);
    }

    async close() {
        await this.gateway.close();
        await new Promise((resolve) => this.upstream.close(resolve));
        await rm(this.root, { recursive: true, force: true });
    }
}

const environment = new GatewayTestEnvironment();
before(async () => environment.start());
after(async () => environment.close());

test('assistant discovers upstream tools and extensions, starts an upstream job, and prepares a local workspace', async () => {
    const init = await environment.client.request('initialize', { protocolVersion: '2025-06-18' });
    assert.equal(init.body.result.serverInfo.name, 'unmodified-upstream', 'Upstream handshake should be preserved');

    const tools = await environment.client.request('tools/list');
    assert.equal(tools.status, 200, 'MCP tool listing should succeed');
    assert.deepEqual(tools.body.result.tools.map((tool) => tool.name), [
        'work_start', 'work_status', 'work_continue', 'worker_workspace_plan', 'worker_workspace_prepare',
    ], 'Agent should see upstream and local tools through one endpoint');

    const start = await environment.client.request('tools/call', { name: 'work_start', arguments: { task: 'Create a report' } });
    assert.equal(start.body.result.content[0].text, 'job-123', 'Upstream job result should pass through untouched');

    const status = await environment.client.request('tools/call', { name: 'work_status', arguments: { jobId: 'job-123' } });
    assert.equal(status.body.result.content[0].text, 'running:job-123', 'Job status must stay tied to its upstream ID');

    const followUp = await environment.client.request('tools/call', { name: 'work_continue', arguments: { jobId: 'job-123', task: 'Add CSV export' } });
    assert.equal(followUp.body.result.content[0].text, 'continued:job-123', 'Continue must reuse the same upstream job');

    const plan = await environment.client.request('tools/call', { name: 'worker_workspace_plan', arguments: { name: 'marketing-demo' } });
    const planned = JSON.parse(plan.body.result.content[0].text);
    assert.equal(planned.exists, false, 'Workspace should not exist before preparation');
    assert.equal(planned.dispatchReady, false, 'Preparing a folder alone must never claim T3 dispatch readiness');

    const prepared = await environment.client.request('tools/call', { name: 'worker_workspace_prepare', arguments: { name: 'marketing-demo' } });
    assert.equal(JSON.parse(prepared.body.result.content[0].text).created, true, 'Workspace must be created under approved root');

    const repeated = await environment.client.request('tools/call', { name: 'worker_workspace_prepare', arguments: { name: 'marketing-demo' } });
    assert.equal(JSON.parse(repeated.body.result.content[0].text).created, false, 'Repeated preparation should reuse the folder');
    assert.ok(environment.calls.every((call) => call.authorization === 'Bearer upstream-test-token-012345678901234567'),
        'Upstream must only receive its own credential');
    assert.equal(environment.calls.filter((call) => call.payload.method === 'tools/call').length, 3,
        'Local workspace operations must not call the T3 job engine');
});

test('unauthorized assistant cannot list tools or prepare a workspace', async () => {
    const countBefore = environment.calls.length;
    const response = await environment.client.request('tools/call', {
        name: 'worker_workspace_prepare', arguments: { name: 'forbidden' },
    }, 'wrong-token');
    assert.equal(response.status, 401, 'Invalid client credentials should be rejected before any action');
    assert.equal(environment.calls.length, countBefore, 'Unauthorized request must not reach upstream');
});

test('workspace names cannot escape the approved root or replace symlinked paths', async () => {
    const outside = await environment.client.request('tools/call', {
        name: 'worker_workspace_prepare', arguments: { name: '../escape' },
    });
    assert.equal(outside.body.result.isError, true, 'Path traversal must be denied');

    await mkdir(path.join(environment.root, 'real-folder'));
    await symlink(path.join(environment.root, 'real-folder'), path.join(environment.root, 'linked-folder'));
    const linked = await environment.client.request('tools/call', {
        name: 'worker_workspace_prepare', arguments: { name: 'linked-folder' },
    });
    assert.equal(linked.body.result.isError, true, 'Symlinked workspace must be refused');
});

test('configuration rejects public listeners and insecure remote upstream endpoints', () => {
    const base = {
        AWG_CLIENT_TOKEN: 'client-test-token-abcdefghijklmnopqrstuvwxyz',
        AWG_UPSTREAM_TOKEN: 'server-test-token-abcdefghijklmnopqrstuvwxyz',
    };
    assert.throws(() => WorkerConfig.fromEnvironment({ ...base, AWG_LISTEN_HOST: '0.0.0.0' }), /loopback/,
        'Gateway must not accidentally expose its static-token pilot interface to the public Internet');
    assert.throws(() => WorkerConfig.fromEnvironment({ ...base, AWG_UPSTREAM_MCP_URL: 'http://example.com/mcp' }), /HTTPS/,
        'Remote upstream connection must require encryption');
});

test('two simultaneous requests prepare a workspace once and both reuse the same folder', async () => {
    const requests = await Promise.all([
        environment.client.request('tools/call', {
            name: 'worker_workspace_prepare', arguments: { name: 'concurrent-setup' },
        }),
        environment.client.request('tools/call', {
            name: 'worker_workspace_prepare', arguments: { name: 'concurrent-setup' },
        }),
    ]);
    const createdFlags = requests.map((response) => JSON.parse(response.body.result.content[0].text).created);
    assert.deepEqual(createdFlags.sort(), [false, true], 'Only the request that actually created the folder should say created');
});
