import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fileSystem } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import { WorkerConfig } from '../src/WorkerConfig.js';
import { WorkerGateway } from '../src/WorkerGateway.js';

const runCommand = promisify(execFile);

class DeliveryTestEnvironment {
    async start() {
        this.root = await fileSystem.mkdtemp(path.join(os.tmpdir(), 'awg-delivery-test-'));
        this.project = path.join(this.root, 'marketing-tracker');
        this.worktree = path.join(this.root, 'result-worktree');
        this.opens = [];
        await runCommand('git', ['init', '-b', 'main', this.project]);
        for (const [key, value] of [['user.name', 'Gateway Test'], ['user.email', 'test@example.invalid']]) {
            await runCommand('git', ['-C', this.project, 'config', key, value]);
        }

        await fileSystem.writeFile(path.join(this.project, 'README.md'), 'Initial project\n');
        await runCommand('git', ['-C', this.project, 'add', 'README.md']);
        await runCommand('git', ['-C', this.project, 'commit', '-m', 'Initial project']);
        await runCommand('git', ['-C', this.project, 'worktree', 'add', '-b', 'fleet/abc12345', this.worktree]);
        await fileSystem.writeFile(path.join(this.worktree, 'roas-tracker.html'), '<h1>Marketing tool</h1>');
        await fileSystem.writeFile(path.join(this.project, '.awg-provision.json'), JSON.stringify({
            workspace_name: 'marketing-tracker', host_id: 'my-pc',
            project_id: 'registered-project-1', project_title: '行銷工具',
        }));

        this.config = WorkerConfig.fromEnvironment({
            AWG_CLIENT_TOKEN: 'test-inbound-token-abcdefghijklmnopqrst',
            AWG_UPSTREAM_TOKEN: 'test-upstream-token-abcdefghijklmnopqrs',
            AWG_LISTEN_PORT: '0',
            AWG_WORKSPACE_ROOT: this.root,
            AWG_PROVISION_HOST: 'my-pc',
        });
        this.gateway = new WorkerGateway(this.config, {
            openFolder: async (folder) => this.opens.push(folder),
        });
        this.job = {
            jobId: 'abc12345', host: 'my-pc', projectId: 'registered-project-1',
            state: 'idle', waitingOnDelegatedWork: false,
            branch: 'fleet/abc12345', title: '行銷工具 [job:abc12345]',
        };
        this.gateway.deliveries.upstream = {
            callTool: async (name, args) => {
                assert.equal(name, 'work_status');
                assert.equal(args.jobId, 'abc12345');
                return { structuredContent: { job: this.job } };
            },
        };
        await this.gateway.listen();
        this.address = 'http://127.0.0.1:' + this.gateway.server.address().port;
    }

    async requestLink(jobId = 'abc12345') {
        const response = await fetch(this.address + '/mcp', {
            method: 'POST',
            headers: { authorization: 'Bearer ' + this.config.clientToken, 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: {
                name: 'worker_delivery_link', arguments: { jobId },
            } }),
        });
        return (await response.json()).result;
    }

    async close() {
        await this.gateway.close();
        await fileSystem.rm(this.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
}

const environment = new DeliveryTestEnvironment();
before(async () => environment.start());
after(async () => environment.close());

test('a completed marketing tool gives a one-click local Explorer link, not a job/worktree instruction', async () => {
    const result = await environment.requestLink();
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.label, '查看成果資料夾');
    assert.ok(result.structuredContent.files.includes('roas-tracker.html'));
    assert.match(result.structuredContent.url, /^http:\/\/127\.0\.0\.1:\d+\/open-delivery\/[A-Za-z0-9_-]{32}$/);

    const opened = await fetch(result.structuredContent.url);
    assert.equal(opened.status, 200);
    assert.deepEqual(environment.opens, [await fileSystem.realpath(environment.worktree)]);
    assert.equal((await fetch(result.structuredContent.url)).status, 410,
        'A folder-opening capability link is single-use; it cannot become a general unauthenticated MCP credential.');
});

test('local folder links reject nonmanaged projects, busy jobs and forged or unknown tickets', async () => {
    const countBefore = environment.opens.length;
    environment.job.projectId = 'unrelated-project';
    const forbidden = await environment.requestLink();
    assert.equal(forbidden.isError, true);
    environment.job.projectId = 'registered-project-1';

    environment.job.waitingOnDelegatedWork = true;
    const waiting = await environment.requestLink();
    assert.equal(waiting.isError, true);
    environment.job.waitingOnDelegatedWork = false;

    const guessed = await fetch(environment.address + '/open-delivery/' + 'A'.repeat(32));
    assert.equal(guessed.status, 410);
    const privateMCP = await fetch(environment.address + '/mcp', { method: 'POST' });
    assert.equal(privateMCP.status, 401);
    assert.equal(environment.opens.length, countBefore);
});

test('an unrelated directory on the same disk must not be accepted as the output workspace', async () => {
    environment.job.branch = 'fleet/not-this-job';
    const response = await environment.requestLink();
    assert.equal(response.isError, true);
    environment.job.branch = 'fleet/abc12345';
});
