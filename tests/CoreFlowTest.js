import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { lstat, mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
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
        this.scratchEnabled = false;
        this.provisionedProjects = [];
        this.provisioningCalls = [];
        this.hideProvisionedProjects = false;
        this.upstream = createServer(async (request, response) => {
            const chunks = [];
            for await (const chunk of request) {
                chunks.push(chunk);
            }
            const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            this.calls.push({ authorization: request.headers.authorization, payload });

            const status = {
                hosts: [{ id: 'my-pc', defaultProject: this.scratchEnabled ? 'general-scratch' : null, reachable: true,
                    discovery: { enabled: true, allowWorkStart: true } }],
                projects: [
                    { alias: 'pilot', description: 'Original Fleet pilot: not for general work', host: 'my-pc', workspaceMode: 'worktree', allowWorkStart: true },
                    ...(this.scratchEnabled
                        ? [{ alias: 'general-scratch', description: 'Dedicated scratch for unassigned tasks', host: 'my-pc', workspaceMode: 'scratch', allowWorkStart: true }]
                        : []),
                ],
            };
            const projectsCatalog = {
                hosts: [{ host: 'my-pc', available: true, discovery: true, projects: this.hideProvisionedProjects ? [] : this.provisionedProjects.map((project) => ({
                    projectId: project.projectId, name: project.title,
                    launch: { allowed: true, alias: null, defaultModelSource: null },
                })) }],
            };
            const result = payload.method === 'tools/list'
                ? { tools: ['work_start', 'work_status', 'work_continue'].map((name) => ({ name, inputSchema: { type: 'object' } })) }
                : payload.method === 'tools/call' && payload.params.name === 'fleet_status'
                    ? { content: [{ type: 'text', text: JSON.stringify(status) }], structuredContent: status }
                    : payload.method === 'tools/call' && payload.params.name === 'fleet_projects'
                        ? { content: [{ type: 'text', text: JSON.stringify(projectsCatalog) }], structuredContent: projectsCatalog }
                    : payload.method === 'tools/call'
                        ? {
                            content: [{ type: 'text', text: payload.params.name === 'work_start' ? 'job-123' : payload.params.name === 'work_status' ? 'running:job-123' : 'continued:job-123' }],
                            structuredContent: payload.params.name === 'work_start'
                                ? { job: { jobId: 'job-123', state: 'queued', project: payload.params.arguments.project ?? 'general-scratch' }, created: true }
                                : undefined,
                        }
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
            AWG_PROVISION_HOST: 'my-pc',
            AWG_PROVISION_MODEL_SELECTION: JSON.stringify({ instanceId: 'approved-model-instance', model: 'approved-model' }),
        });
        this.gateway = new WorkerGateway(config, {
            projectAdapter: {
                register: async (workspacePath, title) => {
                    const project = { workspacePath, title, projectId: 't3-registered-' + this.provisionedProjects.length };
                    this.provisioningCalls.push(project);
                    this.provisionedProjects.push(project);
                    return project.projectId;
                },
            },
        });
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
    assert.match(init.body.result.instructions, /installed Session Router Skill/,
        'A new assistant should learn task delegation from MCP initialize, without private chat context');

    const tools = await environment.client.request('tools/list');
    assert.equal(tools.status, 200, 'MCP tool listing should succeed');
    assert.deepEqual(tools.body.result.tools.map((tool) => tool.name), [
        'work_start', 'work_status', 'work_continue',
        'worker_task_plan', 'worker_task_start', 'worker_workspace_ensure',
        'worker_workspace_plan', 'worker_workspace_prepare',
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

    const targetPath = path.join(environment.root, 'real-folder');
    const linkedPath = path.join(environment.root, 'linked-folder');
    await mkdir(targetPath);
    // Windows directory junctions do not require the symlink privilege.
    await symlink(targetPath, linkedPath, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal((await lstat(linkedPath)).isSymbolicLink(), true,
        'Test fixture must be an actual directory link, not a regular folder');

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

test('new assistant with no history gets a clear setup blocker instead of misrouting marketing work to pilot', async () => {
    const beforeCalls = environment.calls.filter((call) =>
        call.payload.method === 'tools/call' && call.payload.params.name === 'work_start').length;
    const planned = await environment.client.request('tools/call', {
        name: 'worker_task_plan', arguments: { task: '幫我製作一套行銷成效追蹤工具' },
    });
    const plan = planned.body.result.structuredContent;
    assert.equal(plan.ready, false, 'Without a designated general workspace the task must not be dispatched');
    assert.match(plan.reason, /general-purpose destination/, 'Operator should see the missing one-time general workspace setup');

    const attempt = await environment.client.request('tools/call', {
        name: 'worker_task_start',
        arguments: { task: '幫我製作一套行銷成效追蹤工具', requestId: 'marketing-no-route-1' },
    });
    assert.equal(attempt.body.result.isError, true, 'Unsafe new work must be blocked before forwarding');
    const afterCalls = environment.calls.filter((call) =>
        call.payload.method === 'tools/call' && call.payload.params.name === 'work_start').length;
    assert.equal(afterCalls, beforeCalls, 'The unrelated pilot job must never receive the marketing request');
});

test('fresh assistant delegates an unrelated marketing task to configured scratch and receives a durable new job', async () => {
    environment.scratchEnabled = true;
    try {
        const task = '我要建立一個行銷成效分析工具，包含資料匯入、摘要和圖表';
        const plan = await environment.client.request('tools/call', {
            name: 'worker_task_plan', arguments: { task },
        });
        assert.equal(plan.body.result.structuredContent.ready, true,
            'Agent with no conversation history should discover one authorized default destination');
        assert.deepEqual(plan.body.result.structuredContent.destination, { target: { host: 'my-pc' } },
            'Generic task must use operator configured scratch, not the unrelated pilot');

        const started = await environment.client.request('tools/call', {
            name: 'worker_task_start',
            arguments: { task, title: '行銷分析工具', requestId: 'marketing-scratch-1' },
        });
        assert.notEqual(started.body.result.isError, true, 'A permitted new task must not fail in the Gateway adapter');
        assert.equal(started.body.result.structuredContent.job.jobId, 'job-123',
            'New high-level tool must return the actual upstream Fleet Job ID');
        const last = environment.calls.filter((call) =>
            call.payload.method === 'tools/call' && call.payload.params.name === 'work_start').at(-1);
        assert.deepEqual(last.payload.params.arguments, {
            target: { host: 'my-pc' }, task, title: '行銷分析工具', requestId: 'marketing-scratch-1',
        }, 'High-level tool must forward the complete task through official work_start without guessing a project');

        const status = await environment.client.request('tools/call', {
            name: 'work_status', arguments: { jobId: 'job-123' },
        });
        assert.equal(status.body.result.content[0].text, 'running:job-123',
            'Assistant should be able to inspect the same job via the existing upstream interface');
    } finally {
        environment.scratchEnabled = false;
    }
});

test('operator-selected general project routes arbitrary tasks without needing scratch or chat history', async () => {
    environment.gateway.taskDispatch.generalProject = 'pilot';
    try {
        const started = await environment.client.request('tools/call', {
            name: 'worker_task_start',
            arguments: { task: 'Test an intentionally selected operator project', requestId: 'selected-pilot-1' },
        });
        assert.notEqual(started.body.result.isError, true, 'A permitted new task must not fail in the Gateway adapter');
        assert.equal(started.body.result.structuredContent.job.jobId, 'job-123',
            'Configured general project should be usable without explicit project choice in each agent turn');
        const last = environment.calls.filter((call) =>
            call.payload.method === 'tools/call' && call.payload.params.name === 'work_start').at(-1);
        assert.equal(last.payload.params.arguments.project, 'pilot',
            'Operator-selected alias must be forwarded, not silently converted to scratch');
    } finally {
        environment.gateway.taskDispatch.generalProject = null;
    }
});

test('new assistant provisions an isolated marketing workspace, starts a new job, then continues that job', async () => {
    const task = '替全新產品製作行銷成效追蹤工具，包含廣告費、轉換率、ROAS 與使用說明';
    const toolList = await environment.client.request('tools/list');
    assert.ok(toolList.body.result.tools.some((tool) => tool.name === 'worker_workspace_ensure'),
        'A no-history assistant must discover the provisioning capability through MCP');

    const created = await environment.client.request('tools/call', {
        name: 'worker_workspace_ensure',
        arguments: { name: 'marketing-tracker', title: 'Marketing Tracker', requestId: 'marketing-provision-1' },
    });
    assert.equal(created.body.result.isError, false, 'Provisioning must succeed with an authorized local test host');
    const provisioned = created.body.result.structuredContent;
    assert.equal(provisioned.dispatchReady, true, 'Real project registration and Fleet launch permission are required');
    assert.deepEqual(provisioned.target, { host: 'my-pc', projectId: 't3-registered-0' });
    assert.deepEqual(provisioned.modelSelection, { instanceId: 'approved-model-instance', model: 'approved-model' });

    const started = await environment.client.request('tools/call', {
        name: 'work_start',
        arguments: {
            target: provisioned.target, modelSelection: provisioned.modelSelection, task,
            requestId: 'marketing-work-1',
        },
    });
    assert.equal(started.body.result.structuredContent.job.jobId, 'job-123');
    const dispatched = environment.calls.filter((call) =>
        call.payload.method === 'tools/call' && call.payload.params.name === 'work_start').at(-1);
    assert.equal(dispatched.payload.params.arguments.target.projectId, 't3-registered-0',
        'The marketing task must never silently go to the unrelated Pilot alias');

    const status = await environment.client.request('tools/call', {
        name: 'work_status', arguments: { jobId: 'job-123' },
    });
    assert.equal(status.body.result.content[0].text, 'running:job-123');

    const continued = await environment.client.request('tools/call', {
        name: 'work_continue', arguments: { jobId: 'job-123', message: '再加 CSV 匯出', requestId: 'marketing-followup-1' },
    });
    assert.equal(continued.body.result.content[0].text, 'continued:job-123');

    const repeated = await environment.client.request('tools/call', {
        name: 'worker_workspace_ensure',
        arguments: { name: 'marketing-tracker', title: 'Marketing Tracker', requestId: 'marketing-provision-1' },
    });
    assert.equal(repeated.body.result.structuredContent.target.projectId, 't3-registered-0');
    assert.equal(environment.provisioningCalls.length, 1, 'A retry must not register the project twice');
});

test('unauthorized or unverified provisioning cannot dispatch a new project', async () => {
    const outside = await environment.client.request('tools/call', {
        name: 'worker_workspace_ensure',
        arguments: { name: '../outside', requestId: 'denied-outside' },
    });
    assert.equal(outside.body.result.isError, true, 'Traversal must be refused before filesystem or T3 actions');

    environment.hideProvisionedProjects = true;
    try {
        const result = await environment.client.request('tools/call', {
            name: 'worker_workspace_ensure',
            arguments: { name: 'restricted-marketing', requestId: 'restricted-new-work' },
        });
        assert.equal(result.body.result.isError, true,
            'If a Fleet token restricts access to Pilot, a freshly registered project must not claim dispatch readiness');
        const last = environment.calls.filter((call) =>
            call.payload.method === 'tools/call' && call.payload.params.name === 'work_start').at(-1);
        assert.notEqual(last?.payload.params.arguments?.target?.projectId, 't3-registered-1',
            'No unverified target may reach work_start');
    } finally {
        environment.hideProvisionedProjects = false;
    }
});
