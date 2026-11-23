import { randomUUID } from 'node:crypto';

export class TaskDispatchService {
    constructor(upstream, generalProject = null) {
        this.upstream = upstream;
        this.generalProject = generalProject;
        this.toolNames = new Set(['worker_task_plan', 'worker_task_start']);
    }

    getTools() {
        const properties = {
            task: {
                type: 'string',
                description: 'The complete natural-language work request, including desired deliverable. Chinese and English are supported.',
            },
            project: {
                type: 'string',
                description: 'Optional exact existing project alias ONLY when the user explicitly chose one. Do not guess or reuse pilot for unrelated work.',
            },
            host: {
                type: 'string',
                description: 'Optional host ID to disambiguate multiple authorized default scratch hosts.',
            },
        };

        return [
            {
                name: 'worker_task_plan',
                description: 'START HERE for a NEW USER TASK when you have no previous chat context. Read-only. Inspects live authorized Fleet destinations and decides whether this request has a safe route. Named projects must match exactly; otherwise uses the operator-selected general workspace or one configured host scratch. Never guesses, creates projects, or reuses unrelated Pilot jobs. If blocked, reports the missing one-time operator configuration.',
                inputSchema: {
                    type: 'object',
                    properties,
                    required: ['task'],
                    additionalProperties: false,
                },
            },
            {
                name: 'worker_task_start',
                description: 'For a new, independent natural-language task, route it safely and create a fresh T3 Fleet Job through the ORIGINAL upstream work_start. Works without past conversation or manual project selection WHEN an authorized general-purpose workspace or single default scratch destination is configured. Never uses an unrelated Pilot project implicitly. Pass a unique requestId per new task; on uncertain errors retry with the SAME ID AND SAME INPUT, not a second job. After creation use work_status/work_messages; for follow-ups find the correct job with work_list and use work_continue, NOT this tool.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        ...properties,
                        requestId: {
                            type: 'string',
                            description: 'Unique idempotency key 1–128 characters [A-Za-z0-9._:-]; reuse for retries of the same task and route.',
                        },
                        title: { type: 'string', description: 'Optional short Job title.' },
                    },
                    required: ['task', 'requestId'],
                    additionalProperties: false,
                },
            },
        ];
    }

    handles(name) {
        return this.toolNames.has(name);
    }

    _validateArguments(name, args) {
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
            throw new Error('Provide the tool arguments as an object');
        }
        const allowed = name === 'worker_task_start'
            ? new Set(['task', 'project', 'host', 'requestId', 'title'])
            : new Set(['task', 'project', 'host']);

        for (const key of Object.keys(args)) {
            if (!allowed.has(key)) {
                throw new Error('Unsupported argument: ' + key);
            }
        }

        if (typeof args.task !== 'string' || !args.task.trim() || args.task.length > 20_000) {
            throw new Error('task must contain 1–20000 characters');
        }

        for (const key of ['project', 'host', 'title']) {
            if (args[key] !== undefined && (typeof args[key] !== 'string' || !args[key].trim())) {
                throw new Error(key + ' must be a nonempty string');
            }
        }

        if (name === 'worker_task_start' &&
            (typeof args.requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(args.requestId))) {
            throw new Error('requestId is required and must be 1–128 letters, digits, dots, underscores, colons or hyphens');
        }
    }

    async _callUpstream(name, args) {
        const response = await this.upstream.forward({
            jsonrpc: '2.0',
            id: randomUUID(),
            method: 'tools/call',
            params: { name, arguments: args },
        });

        if (response.status !== 200 || !response.contentType.includes('application/json')) {
            throw new Error('Upstream Fleet tool unavailable (HTTP ' + response.status + ')');
        }

        const message = JSON.parse(response.body);
        if (message.error) {
            throw new Error('Upstream ' + name + ' rejected the request: ' + (message.error.message ?? 'unknown error'));
        }
        if (!message.result || !Array.isArray(message.result.content)) {
            throw new Error('Upstream ' + name + ' returned an invalid MCP tool result');
        }

        return message.result;
    }

    async _readStatus() {
        const response = await this._callUpstream('fleet_status', {});
        if (response.isError) {
            throw new Error('Cannot inspect authorized Fleet destinations: ' + response.content.map((part) => part.text ?? '').join(' '));
        }

        const status = response.structuredContent;
        if (!status || !Array.isArray(status.hosts) || !Array.isArray(status.projects)) {
            throw new Error('fleet_status did not return its expected structured host/project catalog');
        }

        return status;
    }

    _blocked(reason, status) {
        return {
            ready: false,
            reason,
            availableProjects: status.projects
                .filter((project) => project.allowWorkStart === true)
                .map((project) => ({ alias: project.alias, host: project.host, description: project.description })),
        };
    }

    _routeProject(status, projectAlias, hostId) {
        const project = status.projects.find((candidate) =>
            candidate.alias === projectAlias && (hostId === undefined || candidate.host === hostId));
        if (!project || project.allowWorkStart !== true) {
            return this._blocked('The requested project is not an authorized work_start destination. Check fleet_status or ask the operator to register/authorize it.', status);
        }

        return {
            ready: true,
            destination: { project: project.alias },
            host: project.host,
            reason: 'Operator-configured project alias selected explicitly.',
        };
    }

    _routeScratch(status, hostId) {
        const hosts = status.hosts.filter((host) =>
            host.defaultProject && (hostId === undefined || host.id === hostId) &&
            status.projects.some((project) =>
                project.alias === host.defaultProject && project.host === host.id &&
                project.workspaceMode === 'scratch' && project.allowWorkStart === true));

        if (hosts.length === 1) {
            return {
                ready: true,
                destination: { target: { host: hosts[0].id } },
                host: hosts[0].id,
                reason: 'Operator-configured default T3 scratch destination for projectless tasks.',
            };
        }

        if (hosts.length > 1) {
            return this._blocked('Multiple authorized scratch hosts are configured. Specify a host, or configure one general project.', status);
        }

        return this._blocked(
            'No authorized general-purpose destination exists. Operator: configure AWG_GENERAL_PROJECT to an existing dedicated general-work Fleet alias, OR configure one verified upstream hosts[].defaultProject scratch alias. Do not use pilot as an implicit fallback.',
            status,
        );
    }

    async _plan(args) {
        const status = await this._readStatus();
        if (args.project) {
            return this._routeProject(status, args.project, args.host);
        }
        if (this.generalProject) {
            return this._routeProject(status, this.generalProject, args.host);
        }

        return this._routeScratch(status, args.host);
    }

    _asToolResult(value, isError = false) {
        return {
            content: [{ type: 'text', text: JSON.stringify(value) }],
            structuredContent: value,
            isError,
        };
    }

    async run(name, args) {
        this._validateArguments(name, args);

        const plan = await this._plan(args);
        if (name === 'worker_task_plan') {
            return this._asToolResult(plan);
        }
        if (!plan.ready) {
            return this._asToolResult(plan, true);
        }

        const inputs = {
            ...plan.destination,
            task: args.task,
            requestId: args.requestId,
        };
        if (args.title !== undefined) {
            inputs.title = args.title;
        }

        const result = await this._callUpstream('work_start', inputs);
        return {
            ...result,
            content: [
                { type: 'text', text: 'Task routed via the approved Fleet destination on host ' + plan.host + '.' },
                ...result.content,
            ],
        };
    }
}
