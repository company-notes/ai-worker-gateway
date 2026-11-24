import { isIP } from 'node:net';
import path from 'node:path';
import { ModelSelectionPolicy } from './ModelSelectionPolicy.js';

export class WorkerConfig {
    static fromEnvironment(environment = process.env) {
        const listenHost = environment.AWG_LISTEN_HOST ?? '127.0.0.1';
        const listenPort = Number(environment.AWG_LISTEN_PORT ?? '3791');
        const upstreamURL = new URL(environment.AWG_UPSTREAM_MCP_URL ?? 'http://127.0.0.1:3790/mcp');
        const clientToken = environment.AWG_CLIENT_TOKEN;
        const upstreamToken = environment.AWG_UPSTREAM_TOKEN;
        const workspaceRoot = environment.AWG_WORKSPACE_ROOT ?? null;
        const generalProject = environment.AWG_GENERAL_PROJECT ?? null;
        const provisionHost = environment.AWG_PROVISION_HOST ?? null;
        const selectionJSON = environment.AWG_PROVISION_MODEL_SELECTION ?? null;
        const notificationStateDirectory = environment.AWG_NOTIFICATION_STATE_DIR ?? null;

        if (listenHost !== '127.0.0.1' && listenHost !== '::1') {
            throw new Error('AWG_LISTEN_HOST must be loopback; public access is not supported');
        }
        if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65535) {
            throw new Error('AWG_LISTEN_PORT must be a valid TCP port');
        }
        if (upstreamURL.username || upstreamURL.password || upstreamURL.search || upstreamURL.hash) {
            throw new Error('Upstream URL must not embed credentials or query parameters');
        }
        const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(upstreamURL.hostname);
        if (upstreamURL.protocol !== 'https:' && !(upstreamURL.protocol === 'http:' && loopback)) {
            throw new Error('Upstream MCP must use HTTPS, or HTTP on loopback');
        }
        if (upstreamURL.pathname !== '/mcp') {
            throw new Error('AWG_UPSTREAM_MCP_URL must point to the upstream /mcp endpoint');
        }
        if (!clientToken || clientToken.length < 24) {
            throw new Error('AWG_CLIENT_TOKEN must contain at least 24 characters');
        }
        if (!upstreamToken || upstreamToken.length < 24) {
            throw new Error('AWG_UPSTREAM_TOKEN must contain at least 24 characters');
        }
        if (clientToken === upstreamToken) {
            throw new Error('Client and upstream tokens must be different');
        }
        if (generalProject !== null && !/^[a-zA-Z0-9._-]{1,64}$/.test(generalProject)) {
            throw new Error('AWG_GENERAL_PROJECT must be an exact existing Fleet project alias');
        }
        if (provisionHost !== null && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(provisionHost)) {
            throw new Error('AWG_PROVISION_HOST must be an exact authorized local Fleet host ID');
        }
        if (provisionHost && !workspaceRoot) {
            throw new Error('AWG_PROVISION_HOST requires an existing AWG_WORKSPACE_ROOT');
        }

        const provisionModelSelection = selectionJSON === null ? null : ModelSelectionPolicy.fromJSON(selectionJSON);
        if (notificationStateDirectory !== null && !path.isAbsolute(notificationStateDirectory)) {
            throw new Error('AWG_NOTIFICATION_STATE_DIR must be an absolute local directory');
        }

        if (workspaceRoot !== null && workspaceRoot.trim() === '') {
            throw new Error('AWG_WORKSPACE_ROOT cannot be empty');
        }
        if (isIP(upstreamURL.hostname) && !loopback && upstreamURL.protocol !== 'https:') {
            throw new Error('Remote upstream requires HTTPS');
        }

        return new WorkerConfig({
            listenHost,
            listenPort,
            upstreamURL: upstreamURL.href,
            clientToken,
            upstreamToken,
            workspaceRoot,
            generalProject,
            provisionHost,
            provisionModelSelection,
            notificationStateDirectory,
        });
    }

    constructor(settings) {
        Object.assign(this, settings);
    }
}
