export class UpstreamMCPClient {
    constructor(upstreamURL, token) {
        this.upstreamURL = upstreamURL;
        this.token = token;
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
