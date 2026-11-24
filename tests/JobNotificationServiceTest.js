import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { JobNotificationService } from '../src/JobNotificationService.js';
import { validateWebhook, WebhookSender } from '../src/WebhookSender.js';

const masterToken = 'local-client-token-for-notifications-12345678';
let root;
let notification;
let receiver;
let alerts;
let feedEvents;
let cursor;
let jobStates;

before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'awg-notifications-test-'));
    alerts = [];
    jobStates = new Map();
    cursor = '0';
    feedEvents = [];

    receiver = createServer(async (request, response) => {
        const data = [];
        for await (const chunk of request) {
            data.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(data).toString('utf8'));
        if (body.event !== 'work.webhook_test') {
            alerts.push({ header: request.headers.authorization, body });
        }
        response.writeHead(204);
        response.end();
    });
    await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));

    const upstream = {
        async callTool(name, args) {
            if (name === 'work_feed') {
                assert.equal(args.mine, true);
                const newEvents = feedEvents.filter((event) => Number(event.cursor) > Number(args.cursor));
                return { structuredContent: { events: newEvents, nextCursor: cursor, hasMore: false } };
            }
            if (name === 'work_status') {
                return { structuredContent: { job: jobStates.get(args.jobId) } };
            }
            throw new Error('Unexpected test tool: ' + name);
        },
    };
    notification = new JobNotificationService({
        clientToken: masterToken, notificationStateDirectory: root,
    }, upstream);
    await notification.initialize();
});

after(async () => {
    notification.close();
    await new Promise((resolve) => receiver.close(resolve));
    await rm(root, { recursive: true, force: true });
});

function settings(name = 'Sage') {
    return new URLSearchParams({
        mode: 'current', name,
        url: 'http://127.0.0.1:' + receiver.address().port + '/webhook',
        header: 'Authorization', secret: 'private-callback-key',
    });
}

test('user opts in once using a local form; secret is encrypted and never reaches the assistant', async () => {
    assert.deepEqual(notification.status('default').preference, 'unset');
    const setup = notification.setup('default', 3791);
    assert.match(setup.url, /^http:\/\/127\.0\.0\.1:3791\/notifications\/setup\/[A-Za-z0-9_-]{32}$/);
    const nonce = setup.url.split('/').at(-1);
    assert.match(notification.renderSetup(nonce), /Webhook 網址/);

    const page = await notification.submitSetup(nonce, settings());
    assert.match(page, /完成通知已啟用/);
    assert.equal(notification.status('default').enabled, true);
    assert.doesNotMatch(JSON.stringify(notification.status('default')), /private-callback-key|\/webhook/);
    const encrypted = await readFile(path.join(root, 'assistant-webhooks.enc.json'), 'utf8');
    assert.doesNotMatch(encrypted, /private-callback-key|127\.0\.0\.1|Sage/);
    assert.throws(() => notification.renderSetup(nonce), /expired/);
});

test('Gateway sends a finished-turn event to the correct assistant webhook only once', async () => {
    await notification.trackJob('default', {
        structuredContent: { job: { jobId: 'jobfirst01' } },
    });
    jobStates.set('jobfirst01', {
        jobId: 'jobfirst01', title: '行銷追蹤工具 [job:jobfirst01]',
        state: 'idle', waitingOnDelegatedWork: false,
    });
    cursor = '1';
    feedEvents = [{
        cursor: '1', type: 'state_changed', toState: 'idle',
        jobId: 'jobfirst01', at: new Date(Date.now() + 1000).toISOString(),
    }];
    await notification.poll();
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].header, 'Bearer private-callback-key');
    assert.equal(alerts[0].body.task, '行銷追蹤工具');
    assert.equal(alerts[0].body.event, 'work.turn_finished');
    assert.equal(alerts[0].body.jobId, 'jobfirst01');
    await notification.poll();
    assert.equal(alerts.length, 1, 'The durable cursor must prevent duplicate notifications');

    const reloaded = new JobNotificationService({
        clientToken: masterToken, notificationStateDirectory: root,
    }, notification.upstream);
    await reloaded.initialize();
    assert.equal(reloaded.store.data.cursor, '1');
    assert.equal(reloaded.status('default').enabled, true);
});

test('different assistants get distinct MCP keys and isolated reusable webhook settings', async () => {
    const setup = notification.setup('default', 3791);
    const nonce = setup.url.split('/').at(-1);
    const otherSettings = settings('Noodle');
    otherSettings.set('mode', 'new');
    otherSettings.set('secret', 'another-private-key');
    const page = await notification.submitSetup(nonce, otherSettings);
    const newToken = page.match(/<code>([a-f0-9]{64})<\/code>/)?.[1];
    assert.ok(newToken, 'New assistant receives only one dedicated MCP key, shown once in the browser');
    const identity = notification.identityFor(newToken);
    assert.ok(identity && identity !== 'default');
    assert.equal(notification.status(identity).assistant, 'Noodle');

    const unrelated = await notification.trackJob(identity, {
        structuredContent: { job: { jobId: 'jobother02' } },
    });
    assert.equal(unrelated, undefined);
    await assert.rejects(notification.trackJob('default', {
        structuredContent: { job: { jobId: 'jobother02' } },
    }), /different assistant/);
    jobStates.set('jobother02', {
        jobId: 'jobother02', title: '另一位助理的報告',
        state: 'idle', waitingOnDelegatedWork: false,
    });
    cursor = '2';
    feedEvents.push({
        cursor: '2', type: 'state_changed', toState: 'idle',
        jobId: 'jobother02', at: new Date(Date.now() + 1000).toISOString(),
    });
    await notification.poll();
    assert.equal(alerts.length, 2);
    assert.equal(alerts[1].header, 'Bearer another-private-key');
    assert.equal(alerts[1].body.assistant, 'Noodle');

    await notification.decline(identity);
    assert.equal(notification.status(identity).preference, 'off');
    assert.equal(notification.status(identity).enabled, false);
});

test('jobs waiting on delegated work never create a false completion notice', async () => {
    jobStates.set('jobfirst01', {
        jobId: 'jobfirst01', title: '行銷追蹤工具',
        state: 'idle', waitingOnDelegatedWork: true,
    });
    cursor = '3';
    feedEvents.push({
        cursor: '3', type: 'state_changed', toState: 'idle',
        jobId: 'jobfirst01', at: new Date(Date.now() + 2000).toISOString(),
    });
    await notification.poll();
    assert.equal(alerts.length, 2);
});

test('the outbound sender blocks SSRF and redirects, but supports an explicit local webhook receiver', async () => {
    assert.throws(() => validateWebhook({
        url: 'http://192.168.1.4/hooks', secret: 'test',
    }), /HTTPS/);
    assert.throws(() => validateWebhook({
        url: 'https://127.0.0.1/hooks', secret: 'test',
    }), /HTTPS/);
    assert.throws(() => validateWebhook({
        url: 'https://example.org/hook', secret: 'abc\nInjection: value',
    }), /金鑰/);

    const sender = new WebhookSender();
    await sender.deliver({
        url: 'http://127.0.0.1:' + receiver.address().port + '/webhook',
        header: 'X-Webhook-Secret', secret: 'test-local',
    }, { deliveryId: 'test-1', event: 'work.test' });
    assert.equal(alerts.at(-1).body.event, 'work.test');
    alerts.pop();
});

test('failed webhook delivery is durably retried after restart without losing a completion event', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'awg-webhook-retry-'));
    const key = 'private-per-install-storage-secret-0123456789';
    const config = {
        clientToken: masterToken, notificationStorageKey: key, notificationStateDirectory: directory,
    };
    const event = {
        cursor: '19', jobId: 'retryjob9', type: 'state_changed', toState: 'idle',
        at: new Date(Date.now() + 1000).toISOString(),
    };
    const upstream = {
        async callTool(name, args) {
            if (name === 'work_feed') {
                return { structuredContent: {
                    events: Number(args.cursor) < 19 ? [event] : [],
                    nextCursor: '19', hasMore: false,
                } };
            }
            return { structuredContent: { job: {
                jobId: 'retryjob9', title: '網站製作', state: 'idle',
                waitingOnDelegatedWork: false,
            } } };
        },
    };
    let attempts = 0;
    const failed = new JobNotificationService(config, upstream, {
        sender: { deliver: async () => { attempts++; throw new Error('Receiver unavailable'); } },
    });
    try {
        await failed.initialize();
        await failed.store.configure('default', {
            name: 'Sage',
            webhook: { url: 'https://webhook.example.invalid/receiver', header: 'Authorization', secret: 'encrypted-secret' },
        });
        await failed.trackJob('default', { structuredContent: { job: { jobId: 'retryjob9' } } });
        await failed.poll();
        assert.equal(attempts, 1);
        assert.equal(failed.store.data.pending.length, 1);
        assert.equal(failed.store.data.cursor, '19');

        let delivered = [];
        const restored = new JobNotificationService(config, upstream, {
            sender: { deliver: async (_settings, payload) => { delivered.push(payload); } },
        });
        await restored.initialize();
        await restored.poll();
        assert.equal(delivered.length, 1);
        assert.equal(delivered[0].deliveryId, '19');
        assert.equal(restored.store.data.pending.length, 0);
        await restored.poll();
        assert.equal(delivered.length, 1);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('assistant webhook profiles survive rotation of the externally visible MCP connection key', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'awg-webhook-key-rotation-'));
    try {
        const stableKey = 'internal-persistent-encryption-key-012345678901';
        const first = new JobNotificationService({
            clientToken: masterToken, notificationStorageKey: stableKey,
            notificationStateDirectory: directory,
        }, {});
        await first.initialize();
        const dedicatedToken = await first.store.createAssistant({
            name: 'Another Assistant',
            webhook: { url: 'https://example.invalid/webhook', header: 'Authorization', secret: 'internal-webhook-secret' },
        });
        await first.store.trackJob(first.identityFor(dedicatedToken), 'somejob99');

        const second = new JobNotificationService({
            clientToken: 'new-mcp-external-key-after-a-rotation-abcdef',
            notificationStorageKey: stableKey,
            notificationStateDirectory: directory,
        }, {});
        await second.initialize();
        const identity = second.identityFor(dedicatedToken);
        assert.ok(identity && identity !== 'default');
        assert.equal(second.store.profileFor(identity).name, 'Another Assistant');
        assert.equal(second.store.data.jobs.somejob99, identity);
        assert.equal(second.store.profileFor(identity).webhook.secret, 'internal-webhook-secret');
        assert.equal(second.identityFor(masterToken), null, 'Old master token is not accepted after rotation');
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('webhook destinations are pinned to vetted public DNS results rather than private or redirected targets', async () => {
    const sender = new WebhookSender({
        resolve: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    await assert.rejects(sender.deliver({
        url: 'https://notify.example.invalid/hooks',
        header: 'Authorization', secret: 'test-key',
    }, { deliveryId: 'ssrf-test' }), /私人網路/);

    const redirect = createServer((_request, response) => {
        response.writeHead(302, { location: 'http://127.0.0.1:12345/' });
        response.end();
    });
    await new Promise((resolve) => redirect.listen(0, '127.0.0.1', resolve));
    try {
        await assert.rejects(new WebhookSender().deliver({
            url: 'http://127.0.0.1:' + redirect.address().port + '/notify',
            header: 'Authorization', secret: 'test-key',
        }, { deliveryId: 'redirect-test' }), /HTTP 302/);
    } finally {
        await new Promise((resolve) => redirect.close(resolve));
    }
});
