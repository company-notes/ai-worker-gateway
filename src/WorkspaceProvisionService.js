import { promises as fileSystem } from 'node:fs';
import path from 'node:path';
import { GitWorkspaceBootstrapper } from './GitWorkspaceBootstrapper.js';
import { ModelSelectionPolicy } from './ModelSelectionPolicy.js';
import { T3ProjectAdapter } from './T3ProjectAdapter.js';

export class WorkspaceProvisionService {
    constructor(config, workspaces, upstream, projectAdapter = new T3ProjectAdapter()) {
        this.config = config;
        this.workspaces = workspaces;
        this.upstream = upstream;
        this.projectAdapter = projectAdapter;
        this.bootstrapper = new GitWorkspaceBootstrapper();
        this.inFlight = new Map();
    }

    getTool() {
        return {
            name: 'worker_workspace_ensure',
            description: 'When Session Router determines that a NEW independent task has no suitable existing Worker workspace, create or reuse one isolated Git workspace under the operator-approved local root, register it through the installed T3 CLI, then verify the REAL authorized Fleet project and its dispatch policy. Does NOT create a company Card/Ticket. Call only if provisioning was configured by the operator; after dispatchReady=true pass target and optional modelSelection to official work_start. Never use unrelated pilot implicitly; on failure do not dispatch.',
            inputSchema: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Unique lowercase project slug; 1-63 lowercase letters, digits and hyphens.' },
                    title: { type: 'string', description: 'Optional human-readable display title; defaults to the workspace slug.' },
                    requestId: { type: 'string', description: 'Stable idempotency key for this provisioning request; reuse when retrying.' },
                    modelSelection: {
                        type: 'object',
                        description: 'Optional exact authorized model from fleet_models if no operator-fixed model is configured.',
                        properties: {
                            instanceId: { type: 'string' },
                            model: { type: 'string' },
                            options: { type: 'object', additionalProperties: { anyOf: [{ type: 'string' }, { type: 'boolean' }] } },
                        },
                        required: ['instanceId', 'model'],
                        additionalProperties: false,
                    },
                },
                required: ['name', 'requestId'],
                additionalProperties: false,
            },
        };
    }

    _validate(args) {
        if (!args || typeof args !== 'object' || Array.isArray(args) ||
            Object.keys(args).some((key) => !['name', 'title', 'requestId', 'modelSelection'].includes(key))) {
            throw new Error('Expected only name, optional title and requestId');
        }
        if (typeof args.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(args.name)) {
            throw new Error('Workspace name must be a lowercase slug of 1-63 letters, digits or hyphens');
        }
        if (typeof args.requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(args.requestId)) {
            throw new Error('requestId must be 1-128 letters, digits, dots, underscores, colons or hyphens');
        }
        if (args.title !== undefined && (typeof args.title !== 'string' || !args.title.trim() ||
            args.title.length > 120 || /[\r\n]/.test(args.title))) {
            throw new Error('Title must be a nonempty single line, at most 120 characters');
        }
        if (args.modelSelection !== undefined) {
            ModelSelectionPolicy.validate(args.modelSelection);
            if (this.config.provisionModelSelection !== null) {
                throw new Error('An operator-fixed model is configured. Do not override it in a provisioning request');
            }
        }
    }

    async _readFleetStatus() {
        const response = await this.upstream.callTool('fleet_status', {});
        const status = response.structuredContent;
        if (!status || !Array.isArray(status.hosts)) {
            throw new Error('Cannot verify authorized Fleet hosts');
        }

        return status;
    }

    async _assertHostAuthorized() {
        if (!this.config.provisionHost || !this.config.workspaceRoot) {
            throw new Error('Workspace provisioning is disabled. Operator must configure AWG_WORKSPACE_ROOT and AWG_PROVISION_HOST');
        }
        const status = await this._readFleetStatus();
        const host = status.hosts.find((candidate) => candidate.id === this.config.provisionHost);
        if (!host || host.reachable !== true || host.discovery?.enabled !== true ||
            host.discovery?.allowWorkStart !== true) {
            throw new Error('Provisioning host must be reachable, authorized and allow Fleet discovery work_start');
        }

        return host;
    }

    async _verifyModelSelection(selected) {
        if (!selected) {
            return;
        }

        let cursor = null;
        const seen = new Set();
        for (let page = 0; page < 32; page++) {
            const args = cursor
                ? { host: this.config.provisionHost, cursor, search: selected.model }
                : { host: this.config.provisionHost, refresh: true, search: selected.model };
            const response = await this.upstream.callTool('fleet_models', args);
            const hostCatalog = response.structuredContent?.hosts?.find((host) => host.host === this.config.provisionHost);
            if (!hostCatalog || hostCatalog.available !== true || !Array.isArray(hostCatalog.models)) {
                throw new Error('Fleet model catalog is unavailable for the authorized host');
            }

            const model = hostCatalog.models.find((candidate) =>
                candidate.providerInstanceId === selected.instanceId && candidate.modelId === selected.model);
            if (model) {
                const supportedOptions = new Map((model.options ?? []).map((option) => [option.id, option]));
                for (const [optionId, value] of Object.entries(selected.options ?? {})) {
                    const option = supportedOptions.get(optionId);
                    const allowed = option?.type === 'boolean'
                        ? typeof value === 'boolean'
                        : option?.type === 'select' && option.choices?.some((choice) => choice.id === value);
                    if (!allowed) {
                        throw new Error('Provisioning model option is not advertised by the authorized Fleet host: ' + optionId);
                    }
                }

                return;
            }
            cursor = hostCatalog.nextCursor ?? null;
            if (!cursor) {
                throw new Error('Provisioning model is not advertised by the authorized Fleet host');
            }
            if (seen.has(cursor)) {
                throw new Error('Fleet model catalog repeated a page cursor');
            }
            seen.add(cursor);
        }

        throw new Error('Fleet model catalog exceeds the verification page limit');
    }

    async _findProject(projectId) {
        let cursor = null;
        const seen = new Set();
        for (let page = 0; page < 32; page++) {
            const args = cursor
                ? { host: this.config.provisionHost, cursor }
                : { host: this.config.provisionHost, refresh: true };
            const response = await this.upstream.callTool('fleet_projects', args);
            const catalog = response.structuredContent;
            const pageData = catalog?.hosts?.find((host) => host.host === this.config.provisionHost);
            if (!pageData || pageData.available !== true || !Array.isArray(pageData.projects)) {
                throw new Error('Fleet project catalog is unavailable for the authorized host');
            }

            const found = pageData.projects.find((project) => project.projectId === projectId);
            if (found) {
                return found;
            }
            cursor = pageData.nextCursor ?? null;
            if (!cursor) {
                return null;
            }
            if (seen.has(cursor)) {
                throw new Error('Fleet project catalog repeated a page cursor');
            }
            seen.add(cursor);
        }

        throw new Error('Fleet project catalog exceeds the verification page limit');
    }

    async _readMarker(workspacePath, name) {
        const markerPath = path.join(workspacePath, '.awg-provision.json');
        let status;
        try {
            status = await fileSystem.lstat(markerPath);
        } catch (error) {
            if (error.code === 'ENOENT') {
                return null;
            }
            throw error;
        }
        if (!status.isFile() || status.isSymbolicLink()) {
            throw new Error('Workspace registration marker is not a regular file');
        }
        const data = JSON.parse(await fileSystem.readFile(markerPath, 'utf8'));
        if (data.workspace_name !== name || data.host_id !== this.config.provisionHost ||
            typeof data.project_id !== 'string' || !/^[0-9a-z-]{8,100}$/i.test(data.project_id) ||
            typeof data.project_title !== 'string' || !data.project_title.trim()) {
            throw new Error('Workspace registration marker does not match this authorized host and name');
        }

        return { projectId: data.project_id, title: data.project_title };
    }

    async _saveMarker(workspacePath, name, projectId, title) {
        const markerPath = path.join(workspacePath, '.awg-provision.json');
        await fileSystem.writeFile(markerPath, JSON.stringify({
            workspace_name: name,
            host_id: this.config.provisionHost,
            project_id: projectId,
            project_title: title,
        }) + '\n', { flag: 'wx', mode: 0o600 });
    }

    async _ensure(args) {
        await this._assertHostAuthorized();
        const modelSelection = this.config.provisionModelSelection ?? args.modelSelection ?? null;
        await this._verifyModelSelection(modelSelection);

        const workspacePath = await this.workspaces.pathFor(args.name);
        const existingMarker = await this._readMarker(workspacePath, args.name);
        const title = args.title?.trim() ?? existingMarker?.title ?? 'AWG-' + args.name;
        if (existingMarker && args.title && existingMarker.title !== title) {
            throw new Error('Workspace already has a different registered title; do not rename on an idempotent retry');
        }

        let projectId = existingMarker?.projectId ?? null;
        if (!projectId) {
            const result = await this.workspaces.plan(args.name);
            if (result.exists) {
                throw new Error('Workspace exists without a trusted registration marker; operator must reconcile it before retrying');
            }

            await this.workspaces.prepare(args.name);
            await this.bootstrapper.initialize(workspacePath, title);
            projectId = await this.projectAdapter.register(workspacePath, title);
            await this._saveMarker(workspacePath, args.name, projectId, title);
        }

        const project = await this._findProject(projectId);
        if (!project || project.launch?.allowed !== true || project.name !== title) {
            throw new Error('T3 project exists but the Fleet client cannot verify an allowed dispatch target. Grant this project to the wrapper client and enable host discovery; no job has been dispatched');
        }

        if (!project.launch.defaultModelSource && !modelSelection) {
            throw new Error('Registered project is visible but lacks a launch model. Session Router: select modelSelection from fleet_models and retry, or operator: set AWG_PROVISION_MODEL_SELECTION');
        }

        return {
            workspaceName: args.name,
            projectTitle: title,
            host: this.config.provisionHost,
            target: { host: this.config.provisionHost, projectId },
            modelSelection,
            dispatchReady: true,
            created: existingMarker === null,
            explanation: 'T3 Project is registered and visible to Fleet. Use official work_start with target and modelSelection; a new company Card was not created.',
        };
    }

    async ensure(args) {
        this._validate(args);
        const previous = this.inFlight.get(args.name);
        if (previous) {
            return previous;
        }

        const pending = this._ensure(args);
        this.inFlight.set(args.name, pending);
        try {
            return await pending;
        } finally {
            this.inFlight.delete(args.name);
        }
    }
}
