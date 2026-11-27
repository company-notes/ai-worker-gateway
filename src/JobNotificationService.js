import { randomBytes } from 'node:crypto';
import { NotificationStore } from './NotificationStore.js';
import { validateWebhook, WebhookError, WebhookSender } from './WebhookSender.js';

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
                description: 'Only after the first work dispatch and explicit consent AND verified creation of the assistant webhook receiver, obtain a local setup URL. Pass the private notificationSetupToken returned by that dispatch to attach the original Job. The owner enters the receiver URL and key locally; no assistant name. notificationSetupToken is REQUIRED; empty arguments cannot create a receiver-only route. Then call worker_notification_pairing_status with setupId and verify notificationBound and the original jobId.',
                inputSchema: { type: 'object', properties: {
                    notificationSetupToken: { type: 'string', pattern: '^[a-f0-9]{64}$' },
                }, required: ['notificationSetupToken'], additionalProperties: false },
            },
            {
                name: 'worker_notification_pairing_status',
                description: 'Check the private setupId saved before presenting the authorization link. Before every later dispatch, recover any pending pairing using this tool. A successful authorization receipt remains claimable for 30 days, even after link expiry or Gateway restart. Save the returned notificationRouteId privately and verify worker_notification_status before use.',
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
        if (profile.manual !== true && (profile.preference !== 'on' || !profile.webhook)) {
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
                detail: 'No notification route has been paired. After a successful first work dispatch, ask once whether the user wants automatic updates.' };
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

    _prune(map, now) {
        for (const [key, value] of map) {
            if (value.expiresAt <= now) {
                map.delete(key);
            }
        }
    }

    _serialize(operation) {
        const result = this.operations.then(operation);
        this.operations = result.catch(() => {});

        return result;
    }

    _attachment(token) {
        const entry = this.attachments.get(token);

        if (!entry || entry.expiresAt <= Date.now() || this.store.data.jobs[entry.jobId]) {
            throw new Error('The private Job notification setup token is invalid, expired or already used.');
        }

        return entry;
    }

    setup(port, notificationSetupToken) {
        if (!this.store.active) {
            throw new Error('Gateway webhook storage is not enabled.');
        }

        if (typeof notificationSetupToken !== 'string' || !/^[a-f0-9]{64}$/.test(notificationSetupToken)) {
            throw new Error('notificationSetupToken is required: use the private token from the original successful work_start. Do not create another Job to recover a missing token.');
        }

        const nonce = randomBytes(24).toString('base64url');
        const setupId = randomBytes(24).toString('base64url');
        const now = Date.now();
        this._prune(this.tickets, now);
        this._prune(this.attachments, now);

        const attachment = this._attachment(notificationSetupToken);
        if (this.tickets.size >= 50) {
            throw new Error('Too many unused webhook pairing links.');
        }
        this.tickets.set(nonce, { expiresAt: now + setupTtlMs, setupId, notificationRouteId: null, notificationSetupToken, saving: false });

        return {
            url: 'http://127.0.0.1:' + port + '/notifications/setup/' + nonce,
            setupId,
            jobId: attachment.jobId,
            label: '設定完成通知',
            instruction: 'Save setupId privately BEFORE showing the browser URL. Never display setupId. After the user authorizes, or before any later dispatch, call worker_notification_pairing_status with the saved setupId; a successful receipt can be retrieved for 30 days after authorization, even after a restart. Save the returned route, verify status, then include it in new work. Do not repeat setup merely because the browser URL expired.',
            validForMinutes: 10,
        };
    }

    pairingStatus(setupId) {
        const receipt = this.store.pairingReceipt(setupId);

        if (receipt) {
            return {
                paired: true, ...receipt,
                notificationBound: !!receipt.jobId && this._isBound(receipt.jobId, receipt.notificationRouteId),
                detail: 'Verify notificationBound and the original jobId before promising notifications for this Job. Save the route privately and verify worker_notification_status before new dispatch. Clear the pending setupId only after saving and verification. Do not show either identifier to the user.',
            };
        }

        const ticket = [...this.tickets.values()].find((entry) => entry.setupId === setupId);

        if (!ticket || ticket.expiresAt <= Date.now()) {
            throw new Error('No successful pairing receipt is available for this identifier. If authorization was not completed, request a new link.');
        }

        return { paired: false, detail: 'Webhook form not yet submitted successfully.' };
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

    renderSetup(nonce, failure = '') {
        const ticket = this._ticket(nonce);
        if (ticket.notificationRouteId) {
            return this._page('通知已配對', '<h1>通知已設定</h1><p>已驗證 Webhook 接收端。請回到助理，讓助理完成配對確認。</p>');
        }

        const action = '/notifications/setup/' + nonce;
        return this._page('設定完成通知', '<h1>設定完成通知</h1>' +
            '<p>請輸入這位助理自己的通知接收位址與金鑰。所有助理可以共用原本的 MCP 連線，每位助理只需配對一次。</p>' +
            (failure ? '<p role="alert" style="color:#9b2020">' + html(failure) + ' 請重新輸入網址及金鑰後再試一次。</p>' : '') +
            '<form method="POST" action="' + action + '">' +
            '<label>Webhook 網址<input name="url" type="url" maxlength="2000" placeholder="https://..." required></label>' +
            '<label>金鑰標頭<select name="header"><option value="Authorization">Authorization: Bearer</option>' +
            '<option value="X-Webhook-Key">X-Webhook-Key</option><option value="X-API-Key">X-API-Key</option>' +
            '<option value="X-Webhook-Secret">X-Webhook-Secret</option></select></label>' +
            '<label>Webhook 金鑰<input name="secret" type="password" maxlength="2048" autocomplete="off" required></label>' +
            '<p>可直接貼上純金鑰、Bearer 金鑰或完整 Authorization: Bearer 金鑰；系統會自動處理相符的標頭。</p>' +
            '<p>Webhook 資料只會加密保存在本機 Gateway；不會出現在助理聊天，也不會更動 MCP 金鑰。</p>' +
            '<button type="submit">測試並儲存通知</button></form>');
    }

    renderSetupFailure(nonce, error) {
        try {
            const ticket = this._ticket(nonce);

            if (ticket.notificationRouteId) {
                return this.renderSetup(nonce);
            }

            this._attachment(ticket.notificationSetupToken);
        } catch {
            return this._page('設定連結已失效', '<h1>設定連結已失效</h1><p>請回到助理重新取得設定連結；不需要重新派工或配對 Worker。</p>');
        }

        const failure = WebhookError.messageFor(error);
        console.warn('Notification setup failed: ' + failure);

        return this.renderSetup(nonce, failure);
    }

    _page(title, content) {
        return '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
            '<title>' + html(title) + '</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:610px;margin:5vh auto;padding:24px;color:#1a2433}' +
            'label{display:block;margin:16px 0}input:not([type=radio]),select{display:block;box-sizing:border-box;padding:10px;width:100%;font:inherit}' +
            'button{margin:12px 10px 0 0;padding:10px 18px;font:inherit;cursor:pointer}' +
            'p{color:#424b56}code{overflow-wrap:anywhere}</style></head><body>' + content + '</body></html>';
    }

    async _verifyWebhook(webhook) {
        await this.sender.deliver(webhook, {
            schema: 'ai-worker-gateway.webhook.v1',
            deliveryId: 'test-' + randomBytes(12).toString('hex'),
            event: 'work.webhook_test', assistant: '助理',
            task: '通知連線測試', jobId: null, state: 'test',
            occurredAt: new Date().toISOString(),
            message: 'Webhook 配對測試成功，往後會收到此助理的工作進度通知。',
        });
    }

    assistantStatus(connectionId, identity) {
        return this.store.assistantStatus(connectionId, identity);
    }

    async configureAssistant(connectionId, identity, settings) {
        if (!this.store.active) {
            throw new WebhookError('Gateway 尚未啟用通知儲存。');
        }
        if (settings === null && identity.type !== 'agentAddress') {
            throw new WebhookError('Bot 必須設定 Webhook 通知接收端。');
        }

        this.store.assistantRoute(connectionId, identity);
        const webhook = settings === null ? null : validateWebhook(settings);

        return this._serialize(async () => {
            if (webhook !== null) {
                await this._verifyWebhook(webhook);
            }

            return this.store.configureAssistant(connectionId, identity, webhook);
        });
    }

    async submitSetup(nonce, fields) {
        const ticket = this._ticket(nonce);
        if (ticket.notificationRouteId) {
            throw new Error('This webhook pairing was already completed.');
        }

        if (ticket.saving) {
            throw new WebhookError('正在驗證這次配對，請稍後再確認。');
        }

        const webhook = validateWebhook({
            url: fields.get('url'), header: fields.get('header'), secret: fields.get('secret'),
        });
        ticket.saving = true;

        try {
            await this._verifyWebhook(webhook);

            await this._serialize(() => this._savePairing(ticket, webhook));
        } finally {
            ticket.saving = false;
        }

        return this._page('通知設定成功', '<h1>Webhook 配對成功</h1>' +
            '<p>請回到助理告知已完成設定。助理會確認通知狀態，成功授權的結果可在 30 天內領取，不受原設定連結有效期限限制。</p>' +
            '<p>原有 MCP 連線及其共用金鑰都不需要改動。</p>');
    }

    async _savePairing(ticket, webhook) {
        const enabledAt = new Date().toISOString();
        const token = ticket.notificationSetupToken;
        const attachment = this._attachment(token);
        const job = (await this.upstream.callTool('work_status', { jobId: attachment.jobId })).structuredContent;

        if (!job || job.jobId !== attachment.jobId) {
            throw new Error('The originally dispatched Job could not be verified.');
        }

        let initial = null;

        if (notifyingStates.has(job.state) && job.waitingOnDelegatedWork !== true) {
            const event = (job.recentEvents ?? []).filter((item) =>
                item.jobId === job.jobId && this._isNotificationEvent(item) &&
                item.toState === job.state && /^\d{1,15}$/.test(item.cursor))
                .sort((a, b) => Number(b.cursor) - Number(a.cursor))[0];

            if (event) {
                initial = this._notification(null, { name: '助理' }, job, event);
            }
        }

        ticket.notificationRouteId = await this.store.createRoute({
            name: '助理', webhook, enabledAt, jobId: attachment.jobId, initial, setupId: ticket.setupId,
        });

        this.attachments.delete(token);
    }

    _isBound(jobId, routeId) {
        const profileId = this.store.data.jobs[jobId];
        const profile = profileId && this.store.profileFor(profileId);

        return !!profile?.webhook && profile.preference === 'on' &&
            (routeId === undefined || this.store.resolveRoute(routeId) === profileId);
    }

    verifyContinuation(routeId, jobId) {
        const profileId = this.resolveRoute(routeId);

        if (typeof jobId !== 'string' || !jobIdPattern.test(jobId) || this.store.data.jobs[jobId] !== profileId) {
            throw new Error('This Job is not bound to the specified assistant. Use the original assistant identity.');
        }
    }

    describeBinding(response) {
        const jobId = response?.structuredContent?.job?.jobId;

        if (typeof jobId !== 'string' || !jobIdPattern.test(jobId) || response.isError === true) {
            return response;
        }

        const notificationBound = this._isBound(jobId);
        const structuredContent = { ...response.structuredContent, notificationBound };
        const instruction = notificationBound
            ? 'This Job has an enabled notification route; only promise delivery to this assistant if you verified its pairing.'
            : structuredContent.notificationSetupToken
                ? 'Save the private jobId and notificationSetupToken now. Check worker_notification_status using your own saved route, or empty arguments if none. If preference is unset, ask once now whether the owner wants automatic completion notifications. On consent, create the native receiver in the same turn and call worker_notification_setup with the required token. Never display private identifiers.'
                : 'This Job has NO enabled notification binding. Do not promise completion notifications or call setup without the original private token.';

        return {
            ...response,
            structuredContent,
            content: [{ type: 'text', text: JSON.stringify({ ...structuredContent, instruction }) }, ...response.content],
        };
    }

    async recordDispatch(routeId, response) {
        if (routeId !== undefined) {
            await this.trackJob(routeId, response);
            return this.describeBinding(response);
        }

        const jobId = response?.structuredContent?.job?.jobId;
        if (!this.store.active || response?.isError === true || response?.structuredContent?.created !== true ||
            typeof jobId !== 'string' || !jobIdPattern.test(jobId) || this.store.data.jobs[jobId]) {
            return this.describeBinding(response);
        }

        const now = Date.now();
        this._prune(this.attachments, now);

        if (this.attachments.size >= 5000) {
            return this.describeBinding(response);
        }

        const notificationSetupToken = randomBytes(32).toString('hex');
        this.attachments.set(notificationSetupToken, { jobId, expiresAt: now + attachmentTtlMs });

        return this.describeBinding({
            ...response,
            structuredContent: { ...response.structuredContent, notificationSetupToken },
        });
    }

    async trackJob(routeId, response) {
        if (routeId === undefined) {
            return;
        }
        const profileId = this.resolveRoute(routeId);
        const job = response?.structuredContent?.job;
        if (typeof job?.jobId === 'string' && jobIdPattern.test(job.jobId) && response?.isError !== true) {
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

    _notification(profileId, profile, job, event) {
        const title = (job.title || '交辦的工作').replace(/\s*\[job:[0-9a-z]+\]\s*$/, '').slice(0, 120);
        const description = job.state === 'idle'
            ? '這輪處理已結束，請檢查成果是否符合需求。'
            : job.state === 'needs_input'
                ? '工作需要使用者回覆或授權。'
                : '工作執行出現問題，請查看詳情。';
        return {
            id: String(event.cursor), profileId,
            payload: {
                schema: 'ai-worker-gateway.webhook.v1', deliveryId: String(event.cursor),
                event: job.state === 'idle' ? 'work.turn_finished' : 'work.' + job.state,
                assistant: profile.name, task: title,
                jobId: event.jobId, state: job.state,
                occurredAt: event.at ?? new Date().toISOString(), message: description,
            },
        };
    }

    _isNotificationEvent(event) {
        // Fleet can observe an entire external turn between two idle checks.
        // State transitions already have their own event, so only handle same-state turn_finished here.
        return (event.type === 'state_changed' && notifyingStates.has(event.toState)) ||
            (event.type === 'turn_finished' && event.fromState === 'idle' && event.toState === 'idle');
    }

    async _collect(events) {
        const notifications = [];
        for (const event of events) {
            if (!this._isNotificationEvent(event) ||
                typeof event.jobId !== 'string' || !jobIdPattern.test(event.jobId)) {
                continue;
            }
            const profileId = this.store.data.jobs[event.jobId];
            const profile = profileId && this.store.profileFor(profileId);
            if (!profile || profile.preference !== 'on' || !profile.webhook ||
                (event.at && profile.enabledAt && event.at < profile.enabledAt) ||
                Number(event.cursor) <= Number(this.store.data.initialCursors?.[event.jobId] ?? 0)) {
                continue;
            }

            const job = (await this.upstream.callTool('work_status', { jobId: event.jobId })).structuredContent;
            if (!job || job.jobId !== event.jobId || job.state !== event.toState ||
                job.waitingOnDelegatedWork === true) {
                continue;
            }

            notifications.push(this._notification(profileId, profile, job, event));
        }
        return notifications;
    }

    async poll() {
        if (!this.store.active || this.working) {
            return;
        }
        this.working = true;
        try {
            await this._serialize(() => this._poll());
        } finally {
            this.working = false;
        }
    }

    async _poll() {
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
