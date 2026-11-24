import { createServer } from 'node:http';
import { UpstreamMCPClient } from './UpstreamMCPClient.js';
import { WorkspaceService } from './WorkspaceService.js';
import { TaskDispatchService } from './TaskDispatchService.js';
import { WorkspaceProvisionService } from './WorkspaceProvisionService.js';
import { DeliveryService } from './DeliveryService.js';
import { JobNotificationService } from './JobNotificationService.js';

export class WorkerGateway {
    constructor(config, services = {}) {
        this.config = config;
        this.upstream = new UpstreamMCPClient(config.upstreamURL, config.upstreamToken);
        this.workspaces = new WorkspaceService(config.workspaceRoot);
        this.taskDispatch = new TaskDispatchService(this.upstream, config.generalProject);
        this.provision = new WorkspaceProvisionService(config, this.workspaces, this.upstream, services.projectAdapter);
        this.deliveries = new DeliveryService(config, this.upstream, { openFolder: services.openFolder });
        this.notifications = new JobNotificationService(config, this.upstream, { sender: services.webhookSender });
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

    _authenticatedAssistant(request) {
        const authorization = request.headers.authorization;
        if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
            return null;
        }

        const token = authorization.slice(7);
        return this.notifications.identityFor(token);
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
            this.deliveries.getTool(),
            ...this.notifications.getTools(),
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

    async _handleExtension(payload, assistantId) {
        const { name, arguments: args } = payload.params;
        try {
            if (this.taskDispatch.handles(name)) {
                const result = await this.taskDispatch.run(name, args);
                if (name === 'worker_task_start' && this.notifications.store.active) {
                    await this.notifications.trackJob(assistantId, result);
                }
                return this._extensionResult(payload.id, result);
            }
            if (name === 'worker_notification_status' || name === 'worker_notification_setup' ||
                name === 'worker_notification_decline') {
                if (!args || typeof args !== 'object' || Array.isArray(args) ||
                    Object.keys(args).length !== 0) {
                    throw new Error('Notification settings do not accept tool arguments.');
                }
                const value = name === 'worker_notification_status'
                    ? this.notifications.status(assistantId)
                    : name === 'worker_notification_setup'
                        ? this.notifications.setup(assistantId, this.server.address().port)
                        : await this.notifications.decline(assistantId);
                return this._extensionResult(payload.id, {
                    content: [{ type: 'text', text: JSON.stringify(value) }],
                    structuredContent: value, isError: false,
                });
            }
            if (name === 'worker_delivery_link') {
                const value = await this.deliveries.linkFor(args, this.server.address().port);
                return this._extensionResult(payload.id, {
                    content: [{ type: 'text', text: JSON.stringify(value) }],
                    structuredContent: value,
                    isError: false,
                });
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

    async _handleMCP(payload, protocolVersion, assistantId) {
        const extensionNames = new Set(this._extensionTools().map((tool) => tool.name));
        if (payload.method === 'tools/call' && extensionNames.has(payload.params?.name)) {
            const result = await this._handleExtension(payload, assistantId);
            return { status: 200, body: JSON.stringify(result), contentType: 'application/json' };
        }

        const upstreamResponse = await this.upstream.forward(payload, protocolVersion);
        if (payload.method === 'tools/call' && payload.params?.name === 'work_start' &&
            this.notifications.store.active && upstreamResponse.status === 200 &&
            upstreamResponse.contentType.includes('application/json')) {
            const result = JSON.parse(upstreamResponse.body)?.result;
            if (result?.isError !== true) {
                await this.notifications.trackJob(assistantId, result);
            }
        }
        if (payload.method === 'initialize' && upstreamResponse.status === 200 &&
            upstreamResponse.contentType.includes('application/json')) {
            const message = JSON.parse(upstreamResponse.body);
            if (message.result && typeof message.result === 'object') {
                const guide = 'Follow the installed Session Router Skill for intent routing: first identify existing jobs, distinguish follow-ups from independent new work, and select a suitable authorized workspace. The gateway offers fleet_status, work_list, work_start, work_continue and optional worker_task_plan / worker_task_start helpers. If no suitable workspace exists, use worker_workspace_ensure only when the operator has enabled safe T3 provisioning; it returns a Fleet target and optional modelSelection when dispatchReady is true. A shortcut does not replace the Session Router routing policy. If no authorized workspace is available, report the missing capability instead of silently using an unrelated Pilot project.';
                message.result.instructions = [
                    message.result.instructions,
                    guide,
                    'User-facing delivery rule: hide job IDs, branches, worktrees and commit details unless asked. The Worker should commit each verified meaningful stage automatically. When work_status says idle, inspect the output and offer worker_delivery_link. For notifications, first call worker_notification_status. If preference is unset, ask the user once whether they want automatic updates; if yes, call worker_notification_setup and show the local setup link. The user enters the destination webhook URL and key directly in the local Gateway form. Once configured, the Gateway sends task-change events to that assistant webhook; if declined, record that choice and do not send alerts. Do not claim a webhook is configured until the user completes setup. This works with any assistant that provides a webhook receiver, not only OpenMausBot.',
                ].filter(Boolean).join('\n\n');
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

    async _openDeliveryLink(request, response, pathname) {
        const port = this.server.address().port;
        const host = '127.0.0.1:' + port;
        const remote = request.socket.remoteAddress;
        if (request.headers.host !== host ||
            !['127.0.0.1', '::ffff:127.0.0.1'].includes(remote) ||
            request.headers.origin) {
            this._sendJSON(response, 403, { error: 'This link can only be opened locally.' });
            return;
        }

        response.setHeader('referrer-policy', 'no-referrer');
        response.setHeader('content-security-policy', "default-src 'none'; sandbox");
        response.setHeader('x-content-type-options', 'nosniff');
        try {
            await this.deliveries.openTicket(pathname.slice('/open-delivery/'.length));
            response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            response.end('<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>成果資料夾</title><p>已在這台電腦開啟成果資料夾，可以關閉此頁。</p></html>');
        } catch {
            this._sendJSON(response, 410, { error: 'This link is unavailable. Ask the assistant for a new folder link.' });
        }
    }

    async _handleNotificationPage(request, response, pathname) {
        const expectedHost = '127.0.0.1:' + this.server.address().port;
        const origin = 'http://' + expectedHost;
        const remote = request.socket.remoteAddress;
        if (request.headers.host !== expectedHost ||
            !['127.0.0.1', '::ffff:127.0.0.1'].includes(remote) ||
            (request.method === 'POST' && request.headers.origin !== origin)) {
            this._sendJSON(response, 403, { error: 'Notification setup is available only on this computer.' });
            return;
        }

        response.setHeader('cache-control', 'no-store');
        response.setHeader('referrer-policy', 'no-referrer');
        response.setHeader('x-frame-options', 'DENY');
        response.setHeader('x-content-type-options', 'nosniff');
        response.setHeader('content-security-policy',
            "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
        const nonce = pathname.slice('/notifications/setup/'.length);
        try {
            let page;
            if (request.method === 'GET') {
                page = this.notifications.renderSetup(nonce);
            } else if (request.method === 'POST') {
                if (!String(request.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded')) {
                    throw new Error('Expected a form submission.');
                }
                let size = 0;
                const parts = [];
                for await (const part of request) {
                    size += part.length;
                    if (size > 8192) {
                        throw new Error('Notification settings exceed the supported form size.');
                    }
                    parts.push(part);
                }
                page = await this.notifications.submitSetup(nonce,
                    new URLSearchParams(Buffer.concat(parts).toString('utf8')));
            } else {
                response.writeHead(405, { allow: 'GET, POST' });
                response.end();
                return;
            }
            response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            response.end(page);
        } catch (error) {
            response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
            response.end('<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><p>設定未完成。請確認欄位及 Webhook 接收端，再透過助理重新取得設定連結。</p></html>');
        }
    }

    async _handleRequest(request, response) {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        if (pathname.startsWith('/notifications/setup/')) {
            await this._handleNotificationPage(request, response, pathname);
            return;
        }
        if (request.method === 'GET' && pathname.startsWith('/open-delivery/')) {
            await this._openDeliveryLink(request, response, pathname);
            return;
        }

        const assistantId = this._authenticatedAssistant(request);
        if (!assistantId) {
            response.setHeader('www-authenticate', 'Bearer');
            this._sendJSON(response, 401, { error: 'Authentication required' });
            return;
        }

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
        const result = await this._handleMCP(payload, request.headers['mcp-protocol-version'], assistantId);
        response.writeHead(result.status, {
            'content-type': result.contentType,
            'cache-control': 'no-store',
        });
        response.end(result.body);
    }

    async listen() {
        await this.notifications.initialize();
        await new Promise((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(this.config.listenPort, this.config.listenHost, resolve);
        });

        this.notifications.start();
        return this.server.address();
    }

    async close() {
        this.notifications.close();
        await new Promise((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
    }
}
