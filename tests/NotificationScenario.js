import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkerConfig } from '../src/WorkerConfig.js';
import { WorkerGateway } from '../src/WorkerGateway.js';

/** Real Gateway and HTTP webhook receiver with an isolated, controllable Fleet substitute. */
export class NotificationScenario {
    static clientToken = 'one-mcp-key-for-many-bots-abcdefghijklmnopqrstuvwxyz';
    static upstreamToken = 'original-fleet-key-abcdefghijklmnopqrstuvwxyz';

    constructor() {
        this.callbacks = [];
        this.jobs = new Map();
        this.events = [];
        this.dispatches = [];
    }

    async _readJSON(request) {
        const chunks = [];
        for await (const chunk of request) {
            chunks.push(chunk);
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }

    async _listen(server) {
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        return 'http://127.0.0.1:' + server.address().port;
    }

    async _close(server) {
        if (server?.listening) {
            await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    }

    _toolResult(data) {
        return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
    }

    _fleetResult(input) {
        if (input.method === 'initialize') {
            return { protocolVersion: '2025-06-18', serverInfo: { name: 'test-fleet', version: '1' }, capabilities: { tools: {} } };
        }

        if (input.method === 'tools/list') {
            return { tools: ['work_start', 'work_continue', 'work_status', 'work_feed', 'work_list'].map((name) => ({
                name, description: name, inputSchema: { type: 'object', properties: {
                    task: { type: 'string' }, message: { type: 'string' }, requestId: { type: 'string' }, jobId: { type: 'string' },
                } },
            })) };
        }

        const { name, arguments: args } = input.params;
        if (name === 'work_feed') {
            return this._toolResult({ events: this.events.filter((event) => Number(event.cursor) > Number(args.cursor)),
                nextCursor: String(this.events.length), hasMore: false });
        }

        if (name === 'work_list') {
            return this._toolResult({ jobs: [...this.jobs.values()] });
        }

        if (name === 'work_start') {
            assert.equal(args.notificationRouteId, undefined, 'Private route must be removed before Fleet dispatch.');
            const job = { jobId: 'routedjob' + (this.jobs.size + 1), state: 'queued', title: args.task };
            this.jobs.set(job.jobId, job);
            this.dispatches.push({ name, args });

            return this._toolResult({ job, created: true });
        }

        const job = this.jobs.get(args.jobId);
        assert.ok(job, 'The work must refer to an existing Job.');

        if (name === 'work_continue') {
            job.state = 'queued';
            this.dispatches.push({ name, args });

            return this._toolResult({ job, replayed: false });
        }

        assert.equal(name, 'work_status');

        return this._toolResult({ ...job, recentEvents: this.events.filter((event) => event.jobId === job.jobId) });
    }

    async start() {
        this.folder = await mkdtemp(path.join(os.tmpdir(), 'awg-form-route-test-'));
        this.receiver = createServer(async (request, response) => {
            const event = await this._readJSON(request);

            if (this.receiverAuthorization && request.headers.authorization !== this.receiverAuthorization) {
                response.writeHead(401);
                response.end();
                return;
            }

            this.callbacks.push({ authorization: request.headers.authorization, event });
            response.writeHead(204);
            response.end();
        });
        this.webhookURL = await this._listen(this.receiver) + '/callback';

        this.fleet = createServer(async (request, response) => {
            assert.equal(request.headers.authorization, 'Bearer ' + NotificationScenario.upstreamToken);
            const input = await this._readJSON(request);

            if (input.method === 'notifications/initialized') {
                response.writeHead(202);
                response.end();
                return;
            }

            const result = this._fleetResult(input);
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }));
        });
        this.upstreamURL = await this._listen(this.fleet) + '/mcp';
        await this._startGateway();
    }

    async restartGateway() {
        await this.gateway.close();
        await this._startGateway();
    }

    async _startGateway() {
        this.gateway = new WorkerGateway(WorkerConfig.fromEnvironment({
            AWG_CLIENT_TOKEN: NotificationScenario.clientToken,
            AWG_UPSTREAM_TOKEN: NotificationScenario.upstreamToken,
            AWG_NOTIFICATION_STORAGE_KEY: 'stable-notification-key-abcdefghijklmnopqrstuvwxyz',
            AWG_NOTIFICATION_STATE_DIR: this.folder,
            AWG_UPSTREAM_MCP_URL: this.upstreamURL,
            AWG_LISTEN_PORT: '0',
        }));
        await this.gateway.listen();
        this.address = 'http://127.0.0.1:' + this.gateway.server.address().port;
    }

    async rpc(name, args = {}, token = NotificationScenario.clientToken) {
        const response = await fetch(this.address + '/mcp', {
            method: 'POST',
            headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
            }),
        });

        return { status: response.status, body: await response.json() };
    }

    async finish(jobID) {
        const job = this.jobs.get(jobID);
        assert.ok(job, 'Only an existing Job can finish.');
        job.state = 'idle';

        this.events.push({ cursor: String(this.events.length + 1), jobId: jobID,
            type: 'state_changed', toState: 'idle', at: new Date().toISOString() });
        await this.gateway.notifications.poll();
    }

    async close() {
        if (this.gateway) {
            await this.gateway.close();
        }

        await this._close(this.receiver);
        await this._close(this.fleet);

        if (this.folder) {
            await rm(this.folder, { recursive: true, force: true });
        }
    }
}
