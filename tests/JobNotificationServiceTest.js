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
