import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { UpstreamMCPClient } from './UpstreamMCPClient.js';
import { WorkspaceService } from './WorkspaceService.js';
import { TaskDispatchService } from './TaskDispatchService.js';
import { WorkspaceProvisionService } from './WorkspaceProvisionService.js';

export class WorkerGateway {
    constructor(config, services = {}) {
        this.config = config;
        this.upstream = new UpstreamMCPClient(config.upstreamURL, config.upstreamToken);
        this.workspaces = new WorkspaceService(config.workspaceRoot);
        this.taskDispatch = new TaskDispatchService(this.upstream, config.generalProject);
        this.provision = new WorkspaceProvisionService(config, this.workspaces, this.upstream, services.projectAdapter);
        this.server = createServer((request, response) => {
            this._handleRequest(request, response).catch((error) => {
                console.error('Worker Gateway request failed:', error.message);
                if (!response.headersSent) {
                    this._sendJSON(response, 502, { error: 'Gateway operation failed' });
                } else {
                    response.destroy(error);
                }
            });
        });
    }

    _sendJSON(response, status, body) {
        response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify(body));
    }

    _isAuthorized(request) {
        const provided = request.headers.authorization;
        const expected = `Bearer ${this.config.clientToken}`;
        if (typeof provided !== 'string' || Buffer.byteLength(provided) !== Buffer.byteLength(expected)) {
            return false;
        }

        return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
    }

    async _readPayload(request) {
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
            size += chunk.length;
            if (size > 1_048_576) {
                throw new Error('Request exceeds maximum payload size');
            }
            chunks.push(chunk);
        }
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (Array.isArray(payload) || payload === null || typeof payload !== 'object' || payload.jsonrpc !== '2.0') {
            throw new Error('Expected one JSON-RPC 2.0 request');
        }

        return payload;
    }

    _extensionTools() {
        return [
            ...this.taskDispatch.getTools(),
            this.provision.getTool(),
            {
                name: 'worker_workspace_plan',
                description: 'Inspect an approved local workspace slug without modifying files. It does not create a T3 Project.',
                inputSchema: {
                    type: 'object',
                    properties: { name: { type: 'string', description: 'Lowercase workspace slug' } },
                    required: ['name'],
                    additionalProperties: false,
                },
            },
            {
                name: 'worker_workspace_prepare',
                description: 'Create or reuse a folder under the operator-approved root. Does not register a T3 Project or start a Fleet job.',
                inputSchema: {
                    type: 'object',
                    properties: { name: { type: 'string', description: 'Lowercase workspace slug' } },
                    required: ['name'],
                    additionalProperties: false,
                },
            },
        ];
    }

    _toolResult(id, value, isError = false) {
        return {
            jsonrpc: '2.0',
            id,
            result: {
                content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
                isError,
            },
        };
    }

    _extensionResult(id, result) {
        return { jsonrpc: '2.0', id, result };
    }

    async _handleExtension(payload) {
        const { name, arguments: args } = payload.params;
        try {
            if (this.taskDispatch.handles(name)) {
                return this._extensionResult(payload.id, await this.taskDispatch.run(name, args));
            }
            if (name === 'worker_workspace_ensure') {
                const value = await this.provision.ensure(args);
                return this._extensionResult(payload.id, {
                    content: [{ type: 'text', text: JSON.stringify(value) }],
                    structuredContent: value,
                    isError: false,
                });
            }
            if (!args || typeof args !== 'object' || Array.isArray(args) ||
                Object.keys(args).length !== 1 || typeof args.name !== 'string') {
                throw new Error('Expected exactly one name argument');
            }

            const value = name === 'worker_workspace_plan'
                ? await this.workspaces.plan(args.name)
                : await this.workspaces.prepare(args.name);
            return this._toolResult(payload.id, value);
        } catch (error) {
            return this._toolResult(payload.id, error.message, true);
        }
    }

    async _handleMCP(payload, protocolVersion) {
        const extensionNames = new Set(this._extensionTools().map((tool) => tool.name));
        if (payload.method === 'tools/call' && extensionNames.has(payload.params?.name)) {
            const result = await this._handleExtension(payload);
            return { status: 200, body: JSON.stringify(result), contentType: 'application/json' };
        }

        const upstreamResponse = await this.upstream.forward(payload, protocolVersion);
        if (payload.method === 'initialize' && upstreamResponse.status === 200 &&
            upstreamResponse.contentType.includes('application/json')) {
            const message = JSON.parse(upstreamResponse.body);
            if (message.result && typeof message.result === 'object') {
                const guide = 'Follow the installed Session Router Skill for intent routing: first identify existing jobs, distinguish follow-ups from independent new work, and select a suitable authorized workspace. The gateway offers fleet_status, work_list, work_start, work_continue and optional worker_task_plan / worker_task_start helpers. If no suitable workspace exists, use worker_workspace_ensure only when the operator has enabled safe T3 provisioning; it returns a Fleet target and optional modelSelection when dispatchReady is true. A shortcut does not replace the Session Router's routing judgment. If no authorized workspace is available, report the missing capability instead of silently using an unrelated Pilot project.';
                message.result.instructions = [message.result.instructions, guide].filter(Boolean).join('\n\n');
                return { status: 200, body: JSON.stringify(message), contentType: 'application/json' };
            }
        }

        if (payload.method !== 'tools/list' || upstreamResponse.status !== 200) {
            return upstreamResponse;
        }
        if (!upstreamResponse.contentType.includes('application/json')) {
            throw new Error('Upstream tools/list must return a JSON response');
        }
        const message = JSON.parse(upstreamResponse.body);
        if (!Array.isArray(message.result?.tools)) {
            return upstreamResponse;
        }
        const occupiedNames = new Set(message.result.tools.map((tool) => tool.name));
        for (const extension of this._extensionTools()) {
            if (occupiedNames.has(extension.name)) {
                throw new Error(`Upstream tool name collides with extension: ${extension.name}`);
            }
        }
        if (!message.result.nextCursor) {
            message.result.tools.push(...this._extensionTools());
        }

        return { status: 200, body: JSON.stringify(message), contentType: 'application/json' };
    }

    async _handleRequest(request, response) {
        if (!this._isAuthorized(request)) {
            response.setHeader('www-authenticate', 'Bearer');
            this._sendJSON(response, 401, { error: 'Authentication required' });
            return;
        }

        const pathname = new URL(request.url, 'http://localhost').pathname;
        if (pathname === '/healthz' && request.method === 'GET') {
            this._sendJSON(response, 200, { healthy: true, upstreamChecked: false });
            return;
        }
        if (pathname !== '/mcp') {
            this._sendJSON(response, 404, { error: 'Not found' });
            return;
        }
        if (request.method !== 'POST') {
            response.setHeader('allow', 'POST');
            this._sendJSON(response, 405, { error: 'Method not allowed' });
            return;
        }

        let payload;
        try {
            payload = await this._readPayload(request);
        } catch (error) {
            this._sendJSON(response, 400, { error: error.message });
            return;
        }
        const result = await this._handleMCP(payload, request.headers['mcp-protocol-version']);
        response.writeHead(result.status, {
            'content-type': result.contentType,
            'cache-control': 'no-store',
        });
        response.end(result.body);
    }

    async listen() {
        await new Promise((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(this.config.listenPort, this.config.listenHost, resolve);
        });

        return this.server.address();
    }

    async close() {
        await new Promise((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
    }
}
