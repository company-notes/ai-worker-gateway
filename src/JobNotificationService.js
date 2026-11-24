import { randomBytes } from 'node:crypto';
import { NotificationStore } from './NotificationStore.js';
import { validateWebhook, WebhookSender } from './WebhookSender.js';

const intervalMs = 30_000;
const setupTtlMs = 10 * 60_000;
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
    }

    async initialize() {
        await this.store.load();
    }

    identityFor(token) {
        return this.store.identityFor(token);
    }

    getTools() {
        return [
            {
                name: 'worker_notification_status',
                description: 'Read this assistant connection’s persistent opt-in notification preference. Ask once whether the user wants automatic notifications when preference is unset. Do not ask again if off or on. No extra MCP key is needed.',
                inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            },
            {
                name: 'worker_notification_setup',
                description: 'Only after the user agrees to automatic notifications, get a one-time local URL to securely enter their assistant webhook URL and key. Never request or show the key in chat. One webhook is saved per assistant connection; configuration remains reusable for later jobs.',
                inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            },
            {
                name: 'worker_notification_decline',
                description: 'When the user says no or disables notifications, save that preference for this assistant. No callbacks will be sent. The user can still ask for job progress normally.',
                inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            },
        ];
    }

    status(profileId) {
        const profile = this.store.profileFor(profileId);
        if (!profile || !this.store.active) {
            return { enabled: false, preference: 'unavailable', detail: 'Webhook settings are not enabled on this Gateway.' };
        }

        return {
            enabled: profile.preference === 'on' && profile.webhook !== null,
            preference: profile.preference,
            assistant: profile.name,
            detail: profile.preference === 'on'
                ? 'This assistant connection already has a reusable webhook.'
                : profile.preference === 'off'
                    ? 'User declined automatic notifications; ask for progress manually.'
                    : 'Ask the user once whether they want automatic task notifications.',
        };
    }

    async decline(profileId) {
        await this.store.setPreference(profileId, 'off');
        return this.status(profileId);
    }

    setup(profileId, port) {
        if (!this.store.active || !this.store.profileFor(profileId)) {
            throw new Error('Gateway webhook storage is not available.');
        }
        const nonce = randomBytes(24).toString('base64url');
        const now = Date.now();
        for (const [value, item] of this.tickets) {
            if (item.expiresAt <= now) {
                this.tickets.delete(value);
            }
        }
        if (this.tickets.size >= 50) {
            throw new Error('Too many unused notification setup links.');
        }
        this.tickets.set(nonce, { profileId, expiresAt: now + setupTtlMs });
        return {
            url: 'http://127.0.0.1:' + port + '/notifications/setup/' + nonce,
            label: '設定完成通知',
            instruction: 'Open on the Windows Worker PC. Enter webhook URL and key on the secure local page, not in chat. Each assistant uses one reusable webhook. To isolate separate assistants, the page can generate a dedicated single MCP connection key for the other assistant.',
            validForMinutes: 10,
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
        const profile = this.store.profileFor(ticket.profileId);
        const name = html(profile.name);
        const action = '/notifications/setup/' + nonce;
        const separate = ticket.profileId === 'default'
            ? '<label><input type="radio" name="mode" value="new"> 為另一位助理建立獨立連線（會產生該助理唯一的一組 MCP 金鑰）</label>'
            : '';
        return this._page('設定完成通知', '<h1>設定完成通知</h1>' +
            '<p>目前連線：<strong>' + name + '</strong>。一位助理設定一次，往後所有工作沿用；不設定就不會自動通知。</p>' +
            '<form method="POST" action="' + action + '">' +
            '<label><input type="radio" name="mode" value="current" checked> 為目前助理設定通知</label>' + separate +
            '<label>助理名稱<input name="name" maxlength="60" required value="' + name + '"></label>' +
            '<label>Webhook 網址<input name="url" type="url" maxlength="2000" placeholder="https://..." required></label>' +
            '<label>金鑰標頭<select name="header"><option value="Authorization">Authorization: Bearer</option>' +
            '<option value="X-Webhook-Key">X-Webhook-Key</option><option value="X-API-Key">X-API-Key</option>' +
            '<option value="X-Webhook-Secret">X-Webhook-Secret</option></select></label>' +
            '<label>Webhook 金鑰<input name="secret" type="password" maxlength="2048" autocomplete="off" required></label>' +
            '<p>網址、金鑰只送回這台電腦的 Gateway 並加密保存，不會傳給聊天助理。</p>' +
            '<button type="submit">儲存並啟用通知</button></form>' +
            '<form method="POST" action="' + action + '"><input type="hidden" name="mode" value="off">' +
            '<button type="submit">不要自動通知</button></form>');
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
        const mode = fields.get('mode');
        let result;
        if (mode === 'off') {
            await this.store.setPreference(ticket.profileId, 'off');
            result = this._page('通知已關閉', '<h1>不會自動通知</h1><p>之後可以直接問助理目前做得如何。</p>');
        } else {
            const name = String(fields.get('name') ?? '').trim();
            if (!name || name.length > 60 || /[\r\n<>]/.test(name)) {
                throw new Error('助理名稱不合法。');
            }
            const webhook = validateWebhook({
                url: fields.get('url'), header: fields.get('header'), secret: fields.get('secret'),
            });
            if (mode === 'new' && ticket.profileId === 'default') {
                const token = await this.store.createAssistant({ name, webhook });
                result = this._page('助理連線已建立', '<h1>' + html(name) + ' 的通知已設定</h1>' +
                    '<p>要分開不同助理的通知，請把以下這組<strong>唯一的 MCP 連線金鑰</strong>貼到該助理現有的 3791 MCP 設定。只顯示這一次。</p>' +
                    '<p><code>' + html(token) + '</code></p><p>MCP 網址不變：<code>http://127.0.0.1:3791/mcp</code>。</p>');
            } else if (mode === 'current') {
                await this.store.configure(ticket.profileId, { name, webhook });
                result = this._page('通知設定成功', '<h1>完成通知已啟用</h1><p>這位助理往後會重複使用同一個 Webhook；不必每項工作再填一次。</p>');
            } else {
                throw new Error('無法判定要設定的助理。');
            }
        }
        this.tickets.delete(nonce);
        return result;
    }

    async trackJob(profileId, response) {
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
            const result = (await this.upstream.callTool('work_status', { jobId: event.jobId })).structuredContent;
            const job = result?.job;
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
