import { randomBytes } from 'node:crypto';
import { NotificationStore } from './NotificationStore.js';
import { validateWebhook, WebhookSender } from './WebhookSender.js';

const intervalMs = 30_000;
const setupTtlMs = 10 * 60_000;
const attachmentTtlMs = 30 * 60_000;
const notifyingStates = new Set(['idle', 'needs_input', 'failed', 'cancelled']);
const jobIdPattern = /^[0-9a-z]{6,32}$/;

function html(text) {
    return String(text).replace(/[&<>"']/g, (value) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[value]));
}

export class JobNotificationService {
    constructor(config, upstream, options = {}) {
        this.store = new NotificationStore(config);
        this.upstream = upstream;
        this.sender = options.sender ?? new WebhookSender();
        this.intervalMs = options.intervalMs ?? intervalMs;
        this.timer = null;
        this.working = false;
        this.tickets = new Map();
        this.attachments = new Map();
        this.operations = Promise.resolve();
    }

    async initialize() {
        await this.store.load();
    }

    getTools() {
        const routeProperty = {
            notificationRouteId: {
                type: 'string',
                description: 'Opaque route handle returned after webhook pairing. Keep it in this assistant’s private settings, never display it as a user-facing job ID. Multiple assistants may share the SAME MCP credential.',
                pattern: '^[a-f0-9]{64}$',
            },
        };
        return [
            {
                name: 'worker_notification_status',
                description: 'Read notification settings for an explicitly paired notificationRouteId. With no handle, the assistant is unpaired. Ask once AFTER a successful first dispatch, not during installation or Worker connection.',
                inputSchema: {
                    type: 'object', properties: routeProperty, additionalProperties: false,
                },
            },
            {
                name: 'worker_notification_setup',
                description: 'Only after the first work dispatch and explicit consent AND verified creation of the assistant webhook receiver, obtain a local setup URL. Pass the private notificationSetupToken returned by that dispatch to attach the original Job. The owner enters the receiver URL and key locally; no assistant name. An explicit standalone notification settings request may omit the token. Then call worker_notification_pairing_status with setupId.',
                inputSchema: { type: 'object', properties: {
                    notificationSetupToken: { type: 'string', pattern: '^[a-f0-9]{64}$' },
                }, additionalProperties: false },
            },
            {
                name: 'worker_notification_pairing_status',
                description: 'Check a pending setupId after the user has submitted the local form. On successful webhook test, returns one opaque notificationRouteId for THIS assistant to include in future work_start / worker_task_start calls.',
                inputSchema: {
                    type: 'object', properties: {
                        setupId: { type: 'string', pattern: '^[A-Za-z0-9_-]{32}$' },
                    }, required: ['setupId'], additionalProperties: false,
                },
            },
            {
                name: 'worker_notification_decline',
                description: 'The user declined automatic alerts or disabled their existing webhook route. Returns or preserves an opaque notificationRouteId so the assistant can remember the decision; no callback will be sent.',
                inputSchema: { type: 'object', properties: routeProperty, additionalProperties: false },
            },
        ];
    }

    resolveRoute(routeId) {
        if (routeId === undefined) {
            return null;
        }
        if (!this.store.active) {
            throw new Error('Webhook notification storage is not enabled.');
        }
        const id = this.store.resolveRoute(routeId);
        const profile = this.store.profileFor(id);
        if (profile.preference !== 'on' || !profile.webhook) {
            throw new Error('Notification route is disabled. Cannot bind new work to it.');
        }
        return id;
    }

    status(routeId) {
        if (!this.store.active) {
            return { enabled: false, preference: 'unavailable' };
        }
        if (routeId === undefined) {
            return { enabled: false, preference: 'unset',
                detail: 'No notification route has been paired for this assistant. Ask once whether the user wants automatic updates.' };
        }
        const id = this.store.resolveRoute(routeId);
        const profile = this.store.profileFor(id);
        return {
            enabled: profile.preference === 'on' && !!profile.webhook,
            preference: profile.preference,
            assistant: profile.name,
            detail: profile.preference === 'on'
                ? 'The assistant can reuse this routeId when dispatching work.'
                : 'The user declined automatic updates. Do not ask again unless they change their preference.',
        };
    }

    async decline(routeId) {
        const value = await this.store.declineRoute(routeId);
        return { notificationRouteId: value, ...this.status(value) };
    }

    setup(port) {
        if (!this.store.active) {
            throw new Error('Gateway webhook storage is not enabled.');
        }
        const nonce = randomBytes(24).toString('base64url');
        const now = Date.now();
        for (const [key, value] of this.tickets) {
            if (value.expiresAt <= now) {
                this.tickets.delete(key);
            }
        }
        if (this.tickets.size >= 50) {
            throw new Error('Too many unused webhook pairing links.');
        }
        this.tickets.set(nonce, { expiresAt: now + setupTtlMs, notificationRouteId: null, name: null });
        return {
            url: 'http://127.0.0.1:' + port + '/notifications/setup/' + nonce,
            setupId: nonce,
            label: '設定完成通知',
            instruction: 'The user fills the URL and key in the local form. After successful pairing, call worker_notification_pairing_status with setupId to obtain a private reusable route handle. All assistants keep their existing shared MCP connection key.',
            validForMinutes: 10,
        };
    }

    pairingStatus(setupId) {
        const ticket = this._ticket(setupId);
        if (!ticket.notificationRouteId) {
            return { paired: false, detail: 'Webhook form not yet submitted successfully.' };
        }
        return {
            paired: true, assistant: ticket.name,
            notificationRouteId: ticket.notificationRouteId,
            detail: 'Save this route handle in private assistant configuration; include it with every future new task. Do not show it to the user.',
        };
    }

    _ticket(nonce) {
        if (!/^[A-Za-z0-9_-]{32}$/.test(nonce)) {
            throw new Error('Invalid setup URL.');
        }
        const ticket = this.tickets.get(nonce);
        if (!ticket || ticket.expiresAt <= Date.now()) {
            this.tickets.delete(nonce);
            throw new Error('This setup link has expired. Request a new link from the assistant.');
        }
        return ticket;
    }

    renderSetup(nonce) {
        const ticket = this._ticket(nonce);
        if (ticket.notificationRouteId) {
            return this._page('通知已配對', '<h1>通知已設定</h1><p>已驗證 Webhook 接收端。請回到助理，讓助理完成配對確認。</p>');
        }

        const action = '/notifications/setup/' + nonce;
        return this._page('設定完成通知', '<h1>設定完成通知</h1>' +
            '<p>請輸入這位助理自己的通知接收位址與金鑰。所有助理可以共用原本的 MCP 連線，每位助理只需配對一次。</p>' +
            '<form method="POST" action="' + action + '">' +
            '<label>助理名稱<input name="name" maxlength="60" required placeholder="例如 Sage"></label>' +
            '<label>Webhook 網址<input name="url" type="url" maxlength="2000" placeholder="https://..." required></label>' +
            '<label>金鑰標頭<select name="header"><option value="Authorization">Authorization: Bearer</option>' +
            '<option value="X-Webhook-Key">X-Webhook-Key</option><option value="X-API-Key">X-API-Key</option>' +
            '<option value="X-Webhook-Secret">X-Webhook-Secret</option></select></label>' +
            '<label>Webhook 金鑰<input name="secret" type="password" maxlength="2048" autocomplete="off" required></label>' +
            '<p>Webhook 資料只會加密保存在本機 Gateway；不會出現在助理聊天，也不會更動 MCP 金鑰。</p>' +
            '<button type="submit">測試並儲存通知</button></form>');
    }

    _page(title, content) {
        return '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
            '<title>' + html(title) + '</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:610px;margin:5vh auto;padding:24px;color:#1a2433}' +
            'label{display:block;margin:16px 0}input:not([type=radio]),select{display:block;box-sizing:border-box;padding:10px;width:100%;font:inherit}' +
            'button{margin:12px 10px 0 0;padding:10px 18px;font:inherit;cursor:pointer}' +
            'p{color:#424b56}code{overflow-wrap:anywhere}</style></head><body>' + content + '</body></html>';
    }

    async submitSetup(nonce, fields) {
        const ticket = this._ticket(nonce);
        if (ticket.notificationRouteId) {
            throw new Error('This webhook pairing was already completed.');
        }

        const name = String(fields.get('name') ?? '').trim();
        if (!name || name.length > 60 || /[\r\n<>]/.test(name)) {
            throw new Error('助理名稱不合法。');
        }
        const webhook = validateWebhook({
            url: fields.get('url'), header: fields.get('header'), secret: fields.get('secret'),
        });
        await this.sender.deliver(webhook, {
            schema: 'ai-worker-gateway.webhook.v1',
            deliveryId: 'test-' + randomBytes(12).toString('hex'),
            event: 'work.webhook_test', assistant: name,
            task: '通知連線測試', jobId: null, state: 'test',
            occurredAt: new Date().toISOString(),
            message: 'Webhook 配對測試成功，往後會收到此助理的工作進度通知。',
        });

        const notificationRouteId = await this.store.createRoute({ name, webhook });
        ticket.notificationRouteId = notificationRouteId;
        ticket.name = name;
        return this._page('通知設定成功', '<h1>Webhook 配對成功</h1>' +
            '<p>請回到助理。助理會完成配對確認並在後續派工時自動使用這條通知路線。</p>' +
            '<p>原有 MCP 連線及其共用金鑰都不需要改動。</p>');
    }

    async trackJob(routeId, response) {
        if (routeId === undefined) {
            return;
        }
        const profileId = this.resolveRoute(routeId);
        const job = response?.structuredContent?.job;
        if (jobIdPattern.test(job?.jobId) && response?.isError !== true) {
            await this.store.trackJob(profileId, job.jobId);
        }
    }

    async _feed(cursor) {
        const feed = (await this.upstream.callTool('work_feed', {
            cursor, limit: 100, mine: true,
        })).structuredContent;
        if (!feed || !Array.isArray(feed.events) ||
            !/^\d{1,15}$/.test(feed.nextCursor) || typeof feed.hasMore !== 'boolean') {
            throw new Error('Upstream did not return a supported work_feed result.');
        }
        return feed;
    }

    async _collect(events) {
        const notifications = [];
        for (const event of events) {
            if (event.type !== 'state_changed' ||
                !['idle', 'needs_input', 'failed', 'cancelled'].includes(event.toState) ||
                !jobIdPattern.test(event.jobId)) {
                continue;
            }
            const profileId = this.store.data.jobs[event.jobId];
            const profile = profileId && this.store.profileFor(profileId);
            if (!profile || profile.preference !== 'on' || !profile.webhook ||
                (event.at && profile.enabledAt && event.at < profile.enabledAt)) {
                continue;
            }

            const job = (await this.upstream.callTool('work_status', { jobId: event.jobId })).structuredContent;
            if (!job || job.jobId !== event.jobId || job.state !== event.toState ||
                job.waitingOnDelegatedWork === true) {
                continue;
            }

            const title = (job.title || '交辦的工作').replace(/\s*\[job:[0-9a-z]+\]\s*$/, '').slice(0, 120);
            const description = job.state === 'idle'
                ? '這輪處理已結束，請檢查成果是否符合需求。'
                : job.state === 'needs_input'
                    ? '工作需要使用者回覆或授權。'
                    : '工作執行出現問題，請查看詳情。';
            notifications.push({
                id: String(event.cursor), profileId,
                payload: {
                    schema: 'ai-worker-gateway.webhook.v1', deliveryId: String(event.cursor),
                    event: job.state === 'idle' ? 'work.turn_finished' : 'work.' + job.state,
                    assistant: profile.name, task: title,
                    jobId: event.jobId, state: job.state,
                    occurredAt: event.at ?? new Date().toISOString(), message: description,
                },
            });
        }
        return notifications;
    }

    async poll() {
        if (!this.store.active || this.working) {
            return;
        }
        this.working = true;
        try {
            for (let page = 0; page < 100; page++) {
                const cursor = this.store.data.cursor;
                const feed = await this._feed(cursor);
                const notifications = await this._collect(feed.events);
                if (feed.hasMore && feed.nextCursor === cursor) {
                    throw new Error('Work feed cursor did not advance.');
                }
                if (feed.events.length || feed.nextCursor !== cursor) {
                    await this.store.stageEvents(notifications, feed.nextCursor);
                }
                if (!feed.hasMore) {
                    break;
                }
            }

            for (const item of [...this.store.data.pending]) {
                const profile = this.store.profileFor(item.profileId);
                if (!profile || profile.preference !== 'on' || !profile.webhook) {
                    await this.store.removeDelivered(item.id);
                    continue;
                }
                try {
                    await this.sender.deliver(profile.webhook, item.payload);
                    await this.store.removeDelivered(item.id);
                } catch {
                    console.warn('A webhook notification could not be delivered; it will be retried.');
                }
            }
        } finally {
            this.working = false;
        }
    }

    start() {
        if (!this.store.active) {
            return;
        }
        this.timer = setInterval(() => {
            this.poll().catch(() => console.warn('Webhook notification check failed; will retry.'));
        }, this.intervalMs);
        this.timer.unref();
        this.poll().catch(() => console.warn('Initial webhook check failed; will retry.'));
    }

    close() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}
