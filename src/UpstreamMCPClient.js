import { randomUUID } from 'node:crypto';

export class UpstreamMCPClient {
    constructor(upstreamURL, token) {
        this.upstreamURL = upstreamURL;
        this.token = token;
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
            body: JSON.stringify(payload),
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
