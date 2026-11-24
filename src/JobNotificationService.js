import { spawn } from 'node:child_process';
import { promises as fileSystem } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultIntervalMs = 30_000;
const batchLimit = 100;

export class JobNotificationService {
    constructor(config, upstream, options = {}) {
        this.upstream = upstream;
        this.stateDirectory = config.notificationStateDirectory ?? null;
        this.notify = options.notify ?? this._notifyWindows.bind(this);
        this.intervalMs = options.intervalMs ?? defaultIntervalMs;
        this.timer = null;
        this.inFlight = false;
        this.cursor = null;
    }

    async _notifyWindows({ title, message }) {
        if (process.platform !== 'win32') {
            return;
        }

        const script = path.join(path.dirname(fileURLToPath(import.meta.url)),
            '..', 'scripts', 'windows', 'Notify-WorkerResult.ps1');
        await new Promise((resolve, reject) => {
            const child = spawn('powershell.exe', [
                '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                '-File', script,
            ], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
            child.once('error', reject);
            child.once('exit', (code) => code === 0 ? resolve() : reject(new Error('Desktop notification failed')));
            child.stdin.end(JSON.stringify({ title, message }));
        });
    }

    async _readCursor() {
        const file = path.join(this.stateDirectory, 'notification-cursor.json');
        try {
            const data = JSON.parse(await fileSystem.readFile(file, 'utf8'));
            if (/^\d{1,15}$/.test(data.cursor)) {
                return data.cursor;
            }
        } catch (error) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
        }

        return null;
    }

    async _saveCursor(cursor) {
        const file = path.join(this.stateDirectory, 'notification-cursor.json');
        const temporary = file + '.tmp-' + process.pid;
        await fileSystem.writeFile(temporary, JSON.stringify({ cursor }) + '\n', { mode: 0o600, flag: 'wx' });
        try {
            await fileSystem.rename(temporary, file);
        } finally {
            await fileSystem.rm(temporary, { force: true });
        }
    }

    async _readFeed(cursor) {
        const args = { limit: batchLimit, mine: true };
        if (cursor !== null) {
            args.cursor = cursor;
        }

        const result = (await this.upstream.callTool('work_feed', args)).structuredContent;
        if (!result || !Array.isArray(result.events) ||
            typeof result.nextCursor !== 'string' || !/^\d{1,15}$/.test(result.nextCursor) ||
            typeof result.hasMore !== 'boolean') {
            throw new Error('Fleet notification feed returned an invalid cursor or event list');
        }

        return result;
    }

    async _processEvents(events) {
        const visited = new Set();
        for (const event of events) {
            if (event.type !== 'state_changed' ||
                !['idle', 'needs_input', 'failed', 'cancelled'].includes(event.toState) ||
                visited.has(event.jobId + ':' + event.toState)) {
                continue;
            }
            visited.add(event.jobId + ':' + event.toState);

            const result = (await this.upstream.callTool('work_status', { jobId: event.jobId })).structuredContent;
            const job = result?.job;
            if (!job || job.jobId !== event.jobId || job.waitingOnDelegatedWork === true ||
                job.state !== event.toState) {
                continue;
            }

            const title = (job.title || '交辦的工作').replace(/\s*\[job:[0-9a-z]+\]\s*$/, '').slice(0, 80);
            const message = job.state === 'idle'
                ? '這輪處理已結束，請回到助理查看成果。'
                : job.state === 'needs_input'
                    ? '工作需要你的回覆或確認，請打開助理。'
                    : '工作遇到問題，請打開助理查看。';
            await this.notify({ title, message });
        }
    }

    async poll() {
        if (!this.stateDirectory || this.inFlight) {
            return;
        }
        this.inFlight = true;
        try {
            let cursor = this.cursor;
            if (cursor === null) {
                cursor = await this._readCursor();
            }

            const initializing = cursor === null;
            for (let page = 0; page < 100; page++) {
                const feed = await this._readFeed(cursor);
                if (!initializing) {
                    await this._processEvents(feed.events);
                }

                if (feed.nextCursor === cursor && feed.hasMore) {
                    throw new Error('Fleet notification feed stopped advancing');
                }

                cursor = feed.nextCursor;
                await this._saveCursor(cursor);
                this.cursor = cursor;
                if (!feed.hasMore) {
                    return;
                }
            }

            throw new Error('Fleet notification feed exceeded the available page limit');
        } finally {
            this.inFlight = false;
        }
    }

    start() {
        if (!this.stateDirectory) {
            return;
        }

        this.timer = setInterval(() => {
            this.poll().catch(() => {
                console.warn('Worker completion notification check failed; will retry.');
            });
        }, this.intervalMs);
        this.timer.unref();
        this.poll().catch(() => {
            console.warn('Initial Worker notification check failed; will retry.');
        });
    }

    close() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}
