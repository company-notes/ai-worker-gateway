import { randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promises as fileSystem } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const runCommand = promisify(execFile);
const ticketLifetimeMs = 24 * 60 * 60 * 1000;
const maxTickets = 100;

export class DeliveryService {
    constructor(config, upstream, options = {}) {
        this.config = config;
        this.upstream = upstream;
        this.openFolder = options.openFolder ?? this._openExplorer.bind(this);
        this.runGit = options.runGit ?? this._runGit.bind(this);
        this.tickets = new Map();
    }

    getTool() {
        return {
            name: 'worker_delivery_link',
            description: 'After a Worker finishes a task in a managed local Git workspace, call with the REAL jobId to offer one simple clickable "查看成果資料夾" link. Clicking opens Windows Explorer on the Worker PC, without asking users about branches, worktrees or commits. Never invent paths or expose unrelated projects. The link lasts 24 hours, is single-use and only works in a browser on the same Windows PC.',
            inputSchema: {
                type: 'object',
                properties: {
                    jobId: { type: 'string', description: 'Real completed jobId from work_status' },
                },
                required: ['jobId'],
                additionalProperties: false,
            },
        };
    }

    async _runGit(cwd, args) {
        const result = await runCommand('git', ['-C', cwd, ...args], {
            windowsHide: true,
            maxBuffer: 1_048_576,
            timeout: 15_000,
        });
        return result.stdout.trim();
    }

    async _openExplorer(folder) {
        if (process.platform !== 'win32') {
            throw new Error('Opening Windows Explorer is available only on a Windows Worker.');
        }
        await new Promise((resolve, reject) => {
            const child = spawn('explorer.exe', [folder], {
                detached: true, stdio: 'ignore', windowsHide: false,
            });
            child.once('error', reject);
            child.once('spawn', () => {
                child.unref();
                resolve();
            });
        });
    }

    async _managedProject(job) {
        if (!this.config.workspaceRoot || !this.config.provisionHost ||
            job.host !== this.config.provisionHost || !job.projectId) {
            throw new Error('This result is not in a managed local Worker workspace.');
        }

        const rootStatus = await fileSystem.lstat(this.config.workspaceRoot);
        if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
            throw new Error('Managed workspace root is not a regular directory.');
        }

        const root = await fileSystem.realpath(this.config.workspaceRoot);
        const candidates = await fileSystem.readdir(root, { withFileTypes: true });
        for (const candidate of candidates.slice(0, 1000)) {
            if (!candidate.isDirectory() || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(candidate.name)) {
                continue;
            }

            const projectFolder = path.join(root, candidate.name);
            if ((await fileSystem.lstat(projectFolder)).isSymbolicLink()) {
                continue;
            }
            const markerFile = path.join(projectFolder, '.awg-provision.json');
            let marker;
            try {
                if (!(await fileSystem.lstat(markerFile)).isFile()) {
                    continue;
                }
                marker = JSON.parse(await fileSystem.readFile(markerFile, 'utf8'));
            } catch (error) {
                if (error.code === 'ENOENT') {
                    continue;
                }
                throw error;
            }

            if (marker.workspace_name === candidate.name &&
                marker.host_id === job.host && marker.project_id === job.projectId) {
                return projectFolder;
            }
        }

        throw new Error('The result does not belong to a locally managed workspace. No folder was opened.');
    }

    async _jobWorktree(job, projectFolder) {
        const branch = job.branch;
        if (typeof branch !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,180}$/.test(branch) ||
            branch.includes('..') || branch.includes('//') || !branch.endsWith('/' + job.jobId)) {
            throw new Error('The Worker has not provided a verifiable Git worktree for this job.');
        }

        const porcelain = await this.runGit(projectFolder, ['worktree', 'list', '--porcelain']);
        const registeredCommonDir = await fileSystem.realpath(await this.runGit(projectFolder, ['rev-parse', '--absolute-git-dir']));
        for (const block of porcelain.split(/\r?\n\r?\n/)) {
            const lines = block.split(/\r?\n/);
            const location = lines.find((line) => line.startsWith('worktree '))?.slice(9);
            const worktreeBranch = lines.find((line) => line.startsWith('branch '))?.slice(7);
            if (!location || worktreeBranch !== 'refs/heads/' + branch) {
                continue;
            }

            const folder = await fileSystem.realpath(location);
            const info = await fileSystem.stat(folder);
            if (!info.isDirectory()) {
                continue;
            }

            const gitCommonDir = await this.runGit(folder, ['rev-parse', '--git-common-dir']);
            const commonDirPath = path.isAbsolute(gitCommonDir)
                ? gitCommonDir : path.join(folder, gitCommonDir);
            const actualCommonDir = await fileSystem.realpath(commonDirPath);
            if (actualCommonDir === registeredCommonDir) {
                return folder;
            }
        }

        throw new Error('Could not verify the Worker job folder against its registered Git project.');
    }

    async linkFor(args, listenPort) {
        if (!args || Object.keys(args).length !== 1 ||
            typeof args.jobId !== 'string' || !/^[0-9a-z]{6,32}$/.test(args.jobId)) {
            throw new Error('Expected one valid jobId from work_status.');
        }

        const response = await this.upstream.callTool('work_status', { jobId: args.jobId });
        const job = response.structuredContent?.job;
        if (!job || job.jobId !== args.jobId || job.state !== 'idle' ||
            job.waitingOnDelegatedWork === true) {
            throw new Error('This task has not finished its current execution, so no completed result is available yet.');
        }

        const projectFolder = await this._managedProject(job);
        const folder = await this._jobWorktree(job, projectFolder);
        const items = await fileSystem.readdir(folder, { withFileTypes: true });
        const files = items.filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
            .slice(0, 30).map((entry) => entry.name);

        const outstandingChanges = await this.runGit(folder, ['status', '--porcelain', '--untracked-files=all']);
        const finishedCommits = Number(await this.runGit(folder, ['rev-list', '--count', 'main..HEAD']));
        const versionSaved = !outstandingChanges && Number.isInteger(finishedCommits) && finishedCommits > 0;

        const token = randomBytes(24).toString('base64url');
        const now = Date.now();
        for (const [key, value] of this.tickets) {
            if (value.expires <= now) {
                this.tickets.delete(key);
            }
        }
        if (this.tickets.size >= maxTickets) {
            throw new Error('Too many pending local folder links. Try again after earlier links expire.');
        }

        this.tickets.set(token, { folder, expires: now + ticketLifetimeMs });
        return {
            label: '查看成果資料夾',
            url: 'http://127.0.0.1:' + listenPort + '/open-delivery/' + token,
            title: job.title?.replace(/\s*\[job:[0-9a-z]+\]\s*$/, '') ?? '已完成的工作',
            files,
            versionSaved,
            needsVersionSave: !versionSaved,
            validForHours: 24,
            note: 'Click this link on the same Windows PC to open the actual job folder in Explorer. It does not require a second password.',
        };
    }

    async openTicket(token) {
        if (!/^[A-Za-z0-9_-]{32}$/.test(token)) {
            throw new Error('The folder link is invalid.');
        }

        const ticket = this.tickets.get(token);
        this.tickets.delete(token);
        if (!ticket || ticket.expires <= Date.now()) {
            throw new Error('The folder link expired or has already been used. Ask the assistant for a new link.');
        }

        await this.openFolder(ticket.folder);
    }
}
