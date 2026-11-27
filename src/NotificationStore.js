import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const version = 1;
const pairingReceiptTtlMs = 30 * 24 * 60 * 60_000;

export class NotificationStore {
    constructor(config) {
        this.directory = config.notificationStateDirectory ?? null;
        this.secret = config.notificationStorageKey ?? config.clientToken;
        this.file = this.directory ? path.join(this.directory, 'assistant-webhooks.enc.json') : null;
        this.key = createHmac('sha256', this.secret).update('awg-webhook-store-v1').digest();
        this.data = {
            version, cursor: '0', profiles: {
                default: { name: '預設助理', tokenHash: null, preference: 'unset', webhook: null, enabledAt: null },
            }, jobs: {}, pending: [], initialCursors: {}, pairingReceipts: {},
        };
        this.writer = Promise.resolve();
    }

    get active() {
        return this.directory !== null;
    }

    _seal(data) {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.key, iv);
        cipher.setAAD(Buffer.from('awg-webhooks-v1'));
        const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
        return JSON.stringify({
            version, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
            payload: ciphertext.toString('base64'),
        }) + '\n';
    }

    _unseal(content) {
        const envelope = JSON.parse(content);
        if (envelope.version !== version) {
            throw new Error('Unsupported webhook storage version.');
        }
        const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(envelope.iv, 'base64'));
        decipher.setAAD(Buffer.from('awg-webhooks-v1'));
        decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
        const data = JSON.parse(Buffer.concat([
            decipher.update(Buffer.from(envelope.payload, 'base64')), decipher.final(),
        ]).toString('utf8'));
        if (!data || data.version !== version || !data.profiles?.default ||
            !Array.isArray(data.pending) || typeof data.jobs !== 'object' ||
            !/^\d{1,15}$/.test(data.cursor)) {
            throw new Error('Webhook storage is invalid.');
        }
        return data;
    }

    async load() {
        if (!this.active) {
            return;
        }
        const status = await fs.lstat(this.directory);
        if (!status.isDirectory() || status.isSymbolicLink()) {
            throw new Error('Notification directory must be a private ordinary directory.');
        }
        try {
            const fileStatus = await fs.lstat(this.file);
            if (!fileStatus.isFile() || fileStatus.isSymbolicLink()) {
                throw new Error('Webhook storage is not a regular file.');
            }
            this.data = this._unseal(await fs.readFile(this.file, 'utf8'));
        } catch (error) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
        }
    }

    async _save(state) {
        if (!this.active) {
            throw new Error('Webhook notifications are not configured on this Gateway.');
        }

        const temporary = this.file + '.' + randomUUID() + '.tmp';
        await fs.writeFile(temporary, this._seal(state), { flag: 'wx', mode: 0o600 });
        try {
            await fs.rename(temporary, this.file);
        } finally {
            await fs.rm(temporary, { force: true });
        }
    }

    async change(updater) {
        const operation = this.writer.then(async () => {
            const nextState = structuredClone(this.data);
            const result = await updater(nextState);
            await this._save(nextState);
            this.data = nextState;
            return result;
        });
        this.writer = operation.catch(() => {});
        return operation;
    }

    profileFor(id) {
        return this.data.profiles[id] ?? null;
    }

    async setPreference(id, preference) {
        if (!['off', 'unset', 'pending'].includes(preference)) {
            throw new Error('Invalid notification preference.');
        }
        await this.change((state) => {
            if (!state.profiles[id]) {
                throw new Error('Unknown assistant identity.');
            }
            state.profiles[id].preference = preference;
            state.profiles[id].webhook = null;
            state.profiles[id].enabledAt = null;
            state.pending = state.pending.filter((item) => item.profileId !== id);
        });
    }

    async configure(id, settings) {
        await this.change((state) => {
            const profile = state.profiles[id];
            if (!profile) {
                throw new Error('Unknown assistant identity.');
            }
            profile.name = settings.name;
            profile.webhook = settings.webhook;
            profile.preference = 'on';
            profile.enabledAt = new Date().toISOString();
        });
    }

    _routeHash(routeId) {
        if (typeof routeId !== 'string' || !/^[a-f0-9]{64}$/.test(routeId)) {
            throw new Error('Notification route identifier is invalid.');
        }
        return createHmac('sha256', this.secret).update('notification-route:' + routeId).digest('hex');
    }

    _findRoute(state, routeId) {
        const hashed = this._routeHash(routeId);

        for (const [id, profile] of Object.entries(state.profiles)) {
            if (typeof profile.routeHash === 'string' &&
                profile.routeHash.length === hashed.length &&
                timingSafeEqual(Buffer.from(profile.routeHash), Buffer.from(hashed))) {
                return id;
            }
        }
        return null;
    }

    resolveRoute(routeId) {
        const id = this._findRoute(this.data, routeId);
        if (!id) {
            throw new Error('Notification route is unknown. Pair the webhook again.');
        }

        return id;
    }

    connectionRoute(connectionId) {
        if (typeof connectionId !== 'string' || !/^[a-f0-9]{64}$/.test(connectionId)) {
            throw new Error('Invalid dedicated Worker connection identifier.');
        }

        return createHmac('sha256', this.secret).update('notification-connection:' + connectionId).digest('hex');
    }

    connectionStatus(connectionId) {
        const routeId = this.connectionRoute(connectionId);
        const id = this._findRoute(this.data, routeId);
        const profile = id && this.profileFor(id);

        if (!profile?.webhook || profile.preference !== 'on') {
            return { enabled: false };
        }

        return { enabled: true, notificationRouteId: routeId };
    }

    async configureConnection(connectionId, webhook) {
        const routeId = this.connectionRoute(connectionId);
        await this.change((state) => {
            const id = this._findRoute(state, routeId) ?? randomUUID();
            state.profiles[id] = this._profile(routeId, { name: '助理', webhook });
        });

        return this.connectionStatus(connectionId);
    }

    _profile(routeId, settings) {
        return {
            name: settings.name,
            routeHash: this._routeHash(routeId),
            tokenHash: null,
            preference: settings.webhook ? 'on' : 'off',
            webhook: settings.webhook ?? null,
            enabledAt: settings.webhook ? (settings.enabledAt ?? new Date().toISOString()) : null,
        };
    }

    _receiptHash(setupId) {
        if (typeof setupId !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(setupId)) {
            throw new Error('Invalid notification pairing identifier.');
        }

        return createHmac('sha256', this.secret).update('notification-receipt:' + setupId).digest('hex');
    }

    pairingReceipt(setupId) {
        const receipt = this.data.pairingReceipts?.[this._receiptHash(setupId)];

        if (!receipt || receipt.expiresAt <= Date.now()) {
            return null;
        }

        return { notificationRouteId: receipt.notificationRouteId, ...(receipt.jobId ? { jobId: receipt.jobId } : {}) };
    }

    _savePairingReceipt(state, settings, routeId) {
        const now = Date.now();
        state.pairingReceipts ??= {};

        for (const [hash, receipt] of Object.entries(state.pairingReceipts)) {
            if (receipt.expiresAt <= now) {
                delete state.pairingReceipts[hash];
            }
        }

        if (settings.setupId === undefined) {
            return;
        }

        const hash = this._receiptHash(settings.setupId);
        if (state.pairingReceipts[hash]) {
            throw new Error('Notification pairing already completed.');
        }
        if (Object.keys(state.pairingReceipts).length >= 5000) {
            throw new Error('Notification pairing receipt capacity reached.');
        }

        state.pairingReceipts[hash] = {
            notificationRouteId: routeId, jobId: settings.jobId ?? null, expiresAt: now + pairingReceiptTtlMs,
        };
    }

    async createRoute(settings) {
        const routeId = randomBytes(32).toString('hex');
        const profileId = randomUUID();
        await this.change((state) => {
            state.profiles[profileId] = this._profile(routeId, settings);

            this._savePairingReceipt(state, settings, routeId);

            if (settings.jobId) {
                if (state.jobs[settings.jobId]) {
                    throw new Error('The job is already associated with a different assistant.');
                }
                state.jobs[settings.jobId] = profileId;

                if (settings.initial) {
                    state.initialCursors ??= {};
                    state.initialCursors[settings.jobId] = settings.initial.id;
                    state.pending.push({ ...settings.initial, profileId });
                }
            }
        });

        return routeId;
    }

    async declineRoute(routeId) {
        if (routeId === undefined) {
            return this.createRoute({ name: '助理', webhook: null });
        }

        const id = this.resolveRoute(routeId);
        await this.setPreference(id, 'off');
        return routeId;
    }

    async trackJob(id, jobId) {
        if (!/^[0-9a-z]{6,32}$/.test(jobId)) {
            throw new Error('Invalid worker job reference.');
        }
        await this.change((state) => {
            if (!state.profiles[id]) {
                throw new Error('Unknown assistant.');
            }
            if (state.jobs[jobId] && state.jobs[jobId] !== id) {
                throw new Error('The job is already associated with a different assistant.');
            }
            state.jobs[jobId] = id;
        });
    }

    async stageEvents(items, cursor) {
        if (!/^\d{1,15}$/.test(cursor)) {
            throw new Error('Invalid worker feed position.');
        }
        await this.change((state) => {
            const seen = new Set(state.pending.map((item) => item.id));
            for (const item of items) {
                if (!seen.has(item.id)) {
                    state.pending.push(item);
                    seen.add(item.id);
                }
            }
            if (state.pending.length > 5000) {
                throw new Error('Notification backlog limit reached; delivery must recover first.');
            }
            state.cursor = cursor;
        });
    }

    async removeDelivered(id) {
        await this.change((state) => {
            state.pending = state.pending.filter((item) => item.id !== id);
        });
    }
}
