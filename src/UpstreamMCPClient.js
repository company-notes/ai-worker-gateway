import { randomUUID } from 'node:crypto';
import { WorkRequestPolicy } from './WorkRequestPolicy.js';

export class UpstreamMCPClient {
    constructor(upstreamURL, token, options = {}) {
        this.upstreamURL = upstreamURL;
        this.token = token;
        this.defaultModelSelection = options.defaultModelSelection ?? null;
        this.defaultHost = options.defaultHost ?? null;
    }

    _applyDefaultModel(payload) {
        if (payload.method !== 'tools/call' || payload.params?.name !== 'work_start' ||
            !this.defaultModelSelection || !this.defaultHost) {
            return payload;
        }

        const args = payload.params.arguments;
        if (!args || typeof args !== 'object' || Array.isArray(args) ||
            Object.prototype.hasOwnProperty.call(args, 'modelSelection') ||
            args.project !== undefined || args.target?.host !== this.defaultHost) {
            return payload;
        }

        return {
            ...payload,
            params: {
                ...payload.params,
                arguments: { ...args, modelSelection: this.defaultModelSelection },
            },
        };
    }

    async callTool(name, args) {
        const payload = {
            jsonrpc: '2.0',
            id: randomUUID(),
            method: 'tools/call',
            params: { name, arguments: args },
        };
        const response = await this.forward(payload);
        if (response.status !== 200 || !response.contentType.includes('application/json')) {
            throw new Error('Upstream Fleet tool unavailable (HTTP ' + response.status + ')');
        }

        const message = JSON.parse(response.body);
        if (message.error) {
            throw new Error('Upstream ' + name + ' rejected the request: ' + (message.error.message ?? 'unknown error'));
        }
        if (!message.result || !Array.isArray(message.result.content)) {
            throw new Error('Upstream ' + name + ' returned an invalid MCP result');
        }
        if (message.result.isError) {
            const details = message.result.content.map((part) => part.text ?? '').join(' ');
            throw new Error('Upstream ' + name + ' failed: ' + details.slice(0, 1200));
        }

        return message.result;
    }

    async forward(payload, protocolVersion) {
        const headers = {
            authorization: `Bearer ${this.token}`,
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
        };
        if (protocolVersion) {
            headers['mcp-protocol-version'] = protocolVersion;
        }

        const response = await fetch(this.upstreamURL, {
            method: 'POST',
            headers,
            body: JSON.stringify(WorkRequestPolicy.apply(this._applyDefaultModel(payload))),
            signal: AbortSignal.timeout(120_000),
        });
        const body = await response.text();
        if (body.length > 10_000_000) {
            throw new Error('Upstream response exceeds the supported size limit');
        }

        return {
            status: response.status,
            contentType: response.headers.get('content-type') ?? 'application/json',
            body,
        };
    }
}
