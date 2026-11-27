import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JobNotificationService } from '../src/JobNotificationService.js';
import { validateWebhook, WebhookSender } from '../src/WebhookSender.js';

const secret = 'fixed-private-notification-encryption-key-123456789';
const commonKey = 'one-shared-mcp-key-abcdefghijklmnopqrstuvwxyz';

async function fixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'awg-routes-'));
    const alerts = [];
    let events = [];
    let cursor = '0';
    const jobStates = new Map();
    const receiver = createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (body.event !== 'work.webhook_test') {
            alerts.push({ secret: request.headers.authorization, body });
        }
        response.writeHead(204);
        response.end();
    });
    await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    const upstream = {
        async callTool(name, args) {
            if (name === 'work_feed') {
                return { structuredContent: { events: events.filter((e) =>
                    Number(e.cursor) > Number(args.cursor)), nextCursor: cursor, hasMore: false } };
            }
            if (name === 'work_status') {
                return { structuredContent: jobStates.get(args.jobId) };
            }
            throw new Error('Unexpected tool: ' + name);
        },
    };
    const config = { notificationStateDirectory: root, notificationStorageKey: secret, clientToken: commonKey };
    const service = new JobNotificationService(config, upstream);
    await service.initialize();
    const form = (name, key) => new URLSearchParams({
        name, url: 'http://127.0.0.1:' + receiver.address().port + '/callback',
        header: 'Authorization', secret: key,
    });
    const pair = async (name, key) => {
        const setup = service.setup(3791);
        const nonce = new URL(setup.url).pathname.split('/').at(-1);
        assert.equal(service.pairingStatus(setup.setupId).paired, false);

        const confirmation = await service.submitSetup(nonce, form(name, key));
        assert.match(confirmation, /Webhook 配對成功/);

        const result = service.pairingStatus(setup.setupId);
        assert.equal(result.paired, true);
        assert.match(result.notificationRouteId, /^[a-f0-9]{64}$/);
        return result.notificationRouteId;
    };
    return {
        root, alerts, jobStates, service, upstream, config, pair,
        feed: (newEvents, next) => { events = newEvents; cursor = next; },
        close: async () => {
            service.close();
            await new Promise((resolve) => receiver.close(resolve));
            await rm(root, { recursive: true, force: true });
        },
    };
}

test('one shared MCP token can register two routes and deliver each job only to its paired webhook', async () => {
    const t = await fixture();
    try {
        const sage = await t.pair('Sage', 'sage-callback-secret');
        const noodle = await t.pair('Noodle', 'noodle-callback-secret');
        assert.notEqual(sage, noodle);
        assert.notEqual(t.service.resolveRoute(sage), t.service.resolveRoute(noodle));
        await t.service.trackJob(sage, { structuredContent: { job: { jobId: 'sagejob1' } } });
        await t.service.trackJob(noodle, { structuredContent: { job: { jobId: 'noodlejob2' } } });
        t.jobStates.set('sagejob1', {
            jobId: 'sagejob1', state: 'idle', title: '行銷工具 [job:sagejob1]',
            waitingOnDelegatedWork: false,
        });
        t.jobStates.set('noodlejob2', {
            jobId: 'noodlejob2', state: 'needs_input', title: '資料整理',
            waitingOnDelegatedWork: false,
        });
        const time = new Date(Date.now() + 1000).toISOString();
        t.feed([
            { cursor: '1', jobId: 'sagejob1', type: 'state_changed', toState: 'idle', at: time },
            { cursor: '2', jobId: 'noodlejob2', type: 'state_changed', toState: 'needs_input', at: time },
        ], '2');
        await t.service.poll();
        assert.deepEqual(t.alerts.map((x) => x.secret),
            ['Bearer sage-callback-secret', 'Bearer noodle-callback-secret']);
        assert.deepEqual(t.alerts.map((x) => x.body.event),
            ['work.turn_finished', 'work.needs_input']);
        await t.service.poll();
        assert.equal(t.alerts.length, 2, 'Stored cursor deduplicates callbacks');
        const ciphertext = await readFile(path.join(t.root, 'assistant-webhooks.enc.json'), 'utf8');
        assert.doesNotMatch(ciphertext, /sage-callback-secret|noodle-callback-secret|Sage|Noodle|[a-f0-9]{64}/);
        assert.equal(t.service.status(sage).enabled, true);
        assert.equal(t.service.status(noodle).enabled, true);
    } finally {
        await t.close();
    }
});

test('consent denied means no route callback; route IDs cannot rebind someone else’s job', async () => {
    const t = await fixture();
    try {
        const sage = await t.pair('Sage', 'sage-notification-key');
        const noodle = await t.pair('Noodle', 'noodle-notification-key');
        await t.service.trackJob(sage, { structuredContent: { job: { jobId: 'ownedjob9' } } });
        await assert.rejects(
            t.service.trackJob(noodle, { structuredContent: { job: { jobId: 'ownedjob9' } } }),
            /different assistant/,
        );
        await assert.rejects(t.service.trackJob('0'.repeat(64), {
            structuredContent: { job: { jobId: 'eviljob9' } },
        }), /unknown/);
        assert.equal(t.service.store.data.jobs.eviljob9, undefined);
        const declined = await t.service.decline(sage);
        assert.equal(declined.preference, 'off');
        assert.equal(declined.notificationRouteId, sage);
        assert.throws(() => t.service.resolveRoute(sage), /disabled/);

        const never = await t.service.decline();
        assert.match(never.notificationRouteId, /^[a-f0-9]{64}$/);
        assert.equal(t.service.status(never.notificationRouteId).preference, 'off');
        assert.equal(t.service.status().preference, 'unset');
    } finally {
        await t.close();
    }
});

test('receiver failure retains an encrypted retry queue across restarts and MCP bearer rotation', async () => {
    const t = await fixture();
    try {
        const route = await t.pair('Sage', 'durable-webhook-secret');
        await t.service.trackJob(route, { structuredContent: { job: { jobId: 'retryjob88' } } });
        t.jobStates.set('retryjob88', {
            jobId: 'retryjob88', state: 'idle', waitingOnDelegatedWork: false, title: '網站工具',
        });
        const next = new Date(Date.now() + 1000).toISOString();
        t.feed([{ cursor: '11', jobId: 'retryjob88', type: 'state_changed', toState: 'idle', at: next }], '11');

        t.service.sender = { deliver: async () => { throw new Error('Temporary receiver outage'); } };
        await t.service.poll();
        assert.equal(t.service.store.data.pending.length, 1);
        assert.equal(t.service.store.data.cursor, '11');

        const afterRotation = new JobNotificationService({
            notificationStateDirectory: t.root, notificationStorageKey: secret,
            clientToken: 'a-different-shared-mcp-connection-key-12345678',
        }, t.upstream, { sender: { deliver: async (_settings, message) => {
            t.alerts.push({ body: message, secret: 'sent-after-restart' });
        } } });
        await afterRotation.initialize();
        assert.equal(afterRotation.status(route).enabled, true);
        await afterRotation.poll();
        assert.equal(t.alerts.length, 1);
        assert.equal(t.alerts[0].body.deliveryId, '11');
        assert.equal(afterRotation.store.data.pending.length, 0);
        await afterRotation.poll();
        assert.equal(t.alerts.length, 1);
        afterRotation.close();
    } finally {
        await t.close();
    }
});

test('delegated work does not emit an early completion callback', async () => {
    const t = await fixture();
    try {
        const route = await t.pair('Sage', 'private-key-for-delegated-work');
        await t.service.trackJob(route, { structuredContent: { job: { jobId: 'delegate99' } } });
        t.jobStates.set('delegate99', {
            jobId: 'delegate99', state: 'idle', title: 'Task',
            waitingOnDelegatedWork: true,
        });
        t.feed([{
            cursor: '4', jobId: 'delegate99', type: 'state_changed',
            toState: 'idle', at: new Date(Date.now() + 1000).toISOString(),
        }], '4');
        await t.service.poll();
        assert.equal(t.alerts.length, 0);
    } finally {
        await t.close();
    }
});

test('webhook sender blocks private DNS and redirect chains, permits deliberate loopback testing', async () => {
    assert.throws(() => validateWebhook({
        url: 'http://192.168.1.4/hooks', secret: 'key',
    }), /HTTPS/);
    assert.throws(() => validateWebhook({
        url: 'https://127.0.0.1/hook', secret: 'key',
    }), /HTTPS/);
    const dnsRebind = new WebhookSender({
        resolve: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    await assert.rejects(dnsRebind.deliver({
        url: 'https://notify.example.invalid/hooks', secret: 'test',
    }, { deliveryId: 'blocked' }), /私人網路/);
    const redirect = createServer((_request, response) => {
        response.writeHead(302, { location: 'http://127.0.0.1:1234/redirected' });
        response.end();
    });
    await new Promise((resolve) => redirect.listen(0, '127.0.0.1', resolve));
    try {
        await assert.rejects(new WebhookSender().deliver({
            url: 'http://127.0.0.1:' + redirect.address().port + '/notify',
            secret: 'test-key',
        }, { deliveryId: 'redirect' }), /HTTP 302/);
    } finally {
        await new Promise((resolve) => redirect.close(resolve));
    }
});
