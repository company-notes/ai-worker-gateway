import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { NotificationScenario } from './NotificationScenario.js';

const scenario = new NotificationScenario();
before(async () => scenario.start());
after(async () => scenario.close());

test('the shared MCP bearer authorizes tools, but does not identify a bot or reveal a webhook', async () => {
    const result = await scenario.rpc('worker_notification_status');
    assert.equal(result.status, 200);
    assert.equal(result.body.result.structuredContent.preference, 'unset');
    assert.equal((await scenario.rpc('worker_notification_status', {}, 'wrong-key')).status, 401);
});

test('pairing form is local-only, same-origin and does not leak receiver secret to MCP', async () => {
    const startedForPairing = await scenario.rpc('work_start', { task: 'Prepare initial work', requestId: 'browser-pairing' });
    const setup = await scenario.rpc('worker_notification_setup', {
        notificationSetupToken: startedForPairing.body.result.structuredContent.notificationSetupToken,
    });
    const { setupId, url } = setup.body.result.structuredContent;
    assert.ok(url.startsWith(scenario.address));
    assert.equal((await fetch(url)).status, 200);

    const form = new URLSearchParams({
        url: scenario.webhookURL,
        header: 'Authorization', secret: 'secret-only-in-local-form',
    });
    const attack = await fetch(url, {
        method: 'POST',
        headers: { origin: 'https://attacker.example', 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
    });
    assert.equal(attack.status, 403);

    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await page.goto(url);
        for (const field of ['url', 'secret']) {
            await page.locator('[name="' + field + '"]').fill(form.get(field));
        }

        const [legitimate] = await Promise.all([
            page.waitForNavigation(), page.getByRole('button', { name: '測試並儲存通知' }).click(),
        ]);
        assert.equal(legitimate.status(), 200, 'A real same-origin browser must be able to authorize notifications.');
        assert.match(await page.locator('body').innerText(), /Webhook 配對成功/);
        assert.doesNotMatch(await page.content(), /secret-only-in-local-form|[a-f0-9]{64}/);
    } finally {
        await browser.close();
    }

    const paired = await scenario.rpc('worker_notification_pairing_status', { setupId });
    const route = paired.body.result.structuredContent.notificationRouteId;
    assert.match(route, /^[a-f0-9]{64}$/);
    assert.equal((await scenario.rpc('worker_notification_status', {
        notificationRouteId: route,
    })).body.result.structuredContent.enabled, true);
    assert.equal((await fetch(url)).status, 200, 'Pairing GET may display a safe confirmation page.');
    assert.equal(scenario.callbacks.length, 1);
    assert.equal(scenario.callbacks[0].authorization, 'Bearer secret-only-in-local-form');
    assert.equal(scenario.callbacks[0].event.event, 'work.webhook_test');

    const started = await scenario.rpc('work_start', {
        task: 'Build a travel planner', requestId: 'paired-start',
        notificationRouteId: route,
    });
    assert.equal(started.body.result.isError, undefined);

    const jobID = started.body.result.structuredContent.job.jobId;
    await scenario.finish(jobID);
    assert.equal(scenario.callbacks.length, 2);
    assert.equal(scenario.callbacks[1].event.event, 'work.turn_finished');
    assert.equal(scenario.callbacks[1].event.jobId, jobID);
    assert.equal(scenario.callbacks[1].authorization, 'Bearer secret-only-in-local-form');

    const continued = await scenario.rpc('work_continue', { jobId: jobID, message: 'Add expense splitting', requestId: 'paired-continue' });
    assert.equal(continued.body.result.structuredContent.job.jobId, jobID);

    await scenario.finish(jobID);
    assert.equal(scenario.callbacks.length, 3, 'Continuing the same Job must inherit the existing notification route.');
    assert.equal(scenario.callbacks[2].event.jobId, jobID);
    assert.equal(scenario.callbacks[2].event.event, 'work.turn_finished');
    assert.notEqual(scenario.callbacks[1].event.deliveryId, scenario.callbacks[2].event.deliveryId);

    const forged = await scenario.rpc('worker_notification_status', { notificationRouteId: '0'.repeat(64) });
    assert.equal(forged.body.result.isError, true);
});

test('decline stores an off-route without any webhook; bogus route is refused before work dispatch', async () => {
    const declined = await scenario.rpc('worker_notification_decline');
    assert.equal(declined.body.result.structuredContent.preference, 'off');
    const route = declined.body.result.structuredContent.notificationRouteId;
    assert.equal((await scenario.rpc('worker_notification_status', {
        notificationRouteId: route,
    })).body.result.structuredContent.preference, 'off');
    const rejected = await scenario.rpc('work_start', {
        task: 'Should not bind', requestId: 'off-route-test',
        notificationRouteId: route,
    });
    assert.equal(rejected.body.result.isError, true);
});

class FirstJobPairingScenario extends NotificationScenario {
    async authorize(url) {
        const browser = await chromium.launch();

        try {
            const page = await browser.newPage();
            await page.goto(url);
            assert.equal(await page.locator('[name="name"]').count(), 0, 'The owner must not enter an assistant name.');
            await page.locator('[name="url"]').fill(this.webhookURL);
            await page.locator('[name="secret"]').fill('first-job-receiver-key');

            const [saved] = await Promise.all([
                page.waitForNavigation(), page.getByRole('button', { name: '測試並儲存通知' }).click(),
            ]);
            assert.equal(saved.status(), 200);
        } finally {
            await browser.close();
        }
    }
}

test('first dispatch precedes consent and a nameless browser pairing binds that same Job', async () => {
    const isolated = new FirstJobPairingScenario();

    try {
        await isolated.start();
        const started = await isolated.rpc('work_start', { task: 'Build a reading list', requestId: 'first-dispatch' });
        const { job, notificationSetupToken } = started.body.result.structuredContent;

        assert.equal(isolated.dispatches.length, 1);
        assert.equal(isolated.callbacks.length, 0);
        assert.match(notificationSetupToken ?? '', /^[a-f0-9]{64}$/, 'First dispatch must return a private attachment capability.');

        const invalid = await isolated.rpc('worker_notification_setup', { notificationSetupToken: '0'.repeat(64) });
        assert.equal(invalid.body.result.isError, true);

        const setup = await isolated.rpc('worker_notification_setup', { notificationSetupToken });
        const { url, setupId } = setup.body.result.structuredContent;
        await isolated.authorize(url);

        const paired = await isolated.rpc('worker_notification_pairing_status', { setupId });
        const { notificationRouteId, jobId } = paired.body.result.structuredContent;
        assert.match(notificationRouteId, /^[a-f0-9]{64}$/);
        assert.equal(jobId, job.jobId);
        assert.equal(isolated.dispatches.length, 1, 'Pairing must not create another Job.');

        await isolated.finish(job.jobId);
        assert.equal(isolated.callbacks.length, 2);
        assert.equal(isolated.callbacks[1].event.jobId, job.jobId);

        const replay = await isolated.rpc('worker_notification_setup', { notificationSetupToken });
        assert.equal(replay.body.result.isError, true, 'Attachment capability is single use.');
    } finally {
        await isolated.close();
    }
});

test('a Job completed before consent is delivered once after the owner pairs, and continuation still notifies', async () => {
    const isolated = new FirstJobPairingScenario();

    try {
        await isolated.start();
        const started = await isolated.rpc('work_start', { task: 'Build a quick note', requestId: 'fast-job' });
        const { job, notificationSetupToken } = started.body.result.structuredContent;

        await isolated.finish(job.jobId);
        assert.equal(isolated.callbacks.length, 0, 'No notifications before consent.');

        const setup = await isolated.rpc('worker_notification_setup', { notificationSetupToken });
        await isolated.authorize(setup.body.result.structuredContent.url);
        await isolated.gateway.notifications.poll();
        assert.equal(isolated.callbacks.length, 2);
        assert.equal(isolated.callbacks[1].event.jobId, job.jobId);
        assert.equal(isolated.callbacks[1].event.event, 'work.turn_finished');

        await isolated.gateway.notifications.poll();
        assert.equal(isolated.callbacks.length, 2, 'The catch-up event must not be duplicated.');

        await isolated.rpc('work_continue', { jobId: job.jobId, message: 'Add tags', requestId: 'fast-continue' });
        await isolated.finish(job.jobId);
        assert.equal(isolated.callbacks.length, 3);
        assert.notEqual(isolated.callbacks[1].event.deliveryId, isolated.callbacks[2].event.deliveryId);
    } finally {
        await isolated.close();
    }
});

test('owner can retry a rejected key on the same page and paste the complete Rakazo Authorization header', async () => {
    const isolated = new NotificationScenario();
    const key = 'disposable-rakazo-receiver-key';
    isolated.receiverAuthorization = 'Bearer ' + key;

    try {
        await isolated.start();
        const started = await isolated.rpc('work_start', { task: 'Build a small tool', requestId: 'retry-pairing' });
        const setup = await isolated.rpc('worker_notification_setup', {
            notificationSetupToken: started.body.result.structuredContent.notificationSetupToken,
        });
        const { url, setupId } = setup.body.result.structuredContent;
        const browser = await chromium.launch();

        try {
            const page = await browser.newPage();
            await page.goto(url);
            await page.locator('[name="url"]').fill(isolated.webhookURL);
            await page.locator('[name="secret"]').fill('incorrect-key');

            const [rejected] = await Promise.all([
                page.waitForNavigation(), page.getByRole('button', { name: '測試並儲存通知' }).click(),
            ]);
            assert.equal(rejected.status(), 400);
            assert.match(await page.getByRole('alert').innerText(), /HTTP 401/);
            assert.equal(await page.locator('[name="secret"]').inputValue(), '');
            assert.doesNotMatch(await page.content(), /incorrect-key/);
            assert.equal((await isolated.rpc('worker_notification_pairing_status', { setupId })).body.result.structuredContent.paired, false);

            // The rejected form itself is reusable, without a new setup link.
            await page.locator('[name="url"]').fill(isolated.webhookURL);
            await page.locator('[name="secret"]').fill('Authorization: Bearer ' + key);

            const [saved] = await Promise.all([
                page.waitForNavigation(), page.getByRole('button', { name: '測試並儲存通知' }).click(),
            ]);
            assert.equal(saved.status(), 200, 'Complete copied Authorization header must be accepted on the same unexpired link.');
            assert.equal(isolated.callbacks.length, 1);
            assert.equal(isolated.callbacks[0].authorization, 'Bearer ' + key);
            assert.doesNotMatch(await page.content(), /disposable-rakazo-receiver-key/);
        } finally {
            await browser.close();
        }

        assert.equal((await isolated.rpc('worker_notification_pairing_status', { setupId })).body.result.structuredContent.paired, true);
    } finally {
        await isolated.close();
    }
});

test('an owner can authorize now and the assistant can claim the route after link expiry and Gateway restart', async (context) => {
    const isolated = new FirstJobPairingScenario();

    try {
        await isolated.start();
        const startedForPairing = await isolated.rpc('work_start', { task: 'Build initial tool', requestId: 'durable-pairing' });
        const setup = await isolated.rpc('worker_notification_setup', {
            notificationSetupToken: startedForPairing.body.result.structuredContent.notificationSetupToken,
        });
        const { url, setupId } = setup.body.result.structuredContent;
        const browserNonce = new URL(url).pathname.split('/').at(-1);

        assert.notEqual(browserNonce, setupId, 'The public browser URL cannot be the private claim credential.');

        await isolated.authorize(url);
        assert.equal(isolated.callbacks.length, 1, 'The owner received the real webhook test.');

        const denied = await isolated.rpc('worker_notification_pairing_status', { setupId: browserNonce });
        assert.equal(denied.body.result.isError, true);
        assert.equal((await isolated.rpc('worker_notification_pairing_status', { setupId }, 'wrong-key')).status, 401);

        context.mock.timers.enable({ apis: ['Date'], now: Date.now() });
        context.mock.timers.tick(11 * 60_000);
        assert.notEqual((await fetch(url)).status, 200, 'Expired browser authorization must remain expired.');

        const late = await isolated.rpc('worker_notification_pairing_status', { setupId });
        assert.equal(late.body.result.structuredContent?.paired, true,
            'A successful authorization must remain claimable after its browser link expires.');
        const route = late.body.result.structuredContent.notificationRouteId;

        await isolated.restartGateway();
        const recovered = await isolated.rpc('worker_notification_pairing_status', { setupId });
        assert.equal(recovered.body.result.structuredContent?.notificationRouteId, route,
            'A Gateway restart must preserve the same private route without another authorization.');
        assert.equal((await isolated.rpc('worker_notification_status', {
            notificationRouteId: route,
        })).body.result.structuredContent.enabled, true);

        const started = await isolated.rpc('work_start', {
            task: 'Build a subscription tracker', requestId: 'delayed-pairing-start', notificationRouteId: route,
        });
        const jobID = started.body.result.structuredContent.job.jobId;
        await isolated.finish(jobID);

        const continued = await isolated.rpc('work_continue', {
            jobId: jobID, message: 'Add annual totals', requestId: 'delayed-pairing-continue',
        });
        assert.equal(continued.body.result.structuredContent.job.jobId, jobID);

        await isolated.finish(jobID);
        assert.deepEqual(isolated.callbacks.map((item) => item.event.event),
            ['work.webhook_test', 'work.turn_finished', 'work.turn_finished']);
        assert.ok(isolated.callbacks.slice(1).every((item) => item.event.jobId === jobID));
    } finally {
        context.mock.timers.reset();
        await isolated.close();
    }
});

test('missing first Job token cannot create a misleading receiver-only pairing', async () => {
    const isolated = new FirstJobPairingScenario();

    try {
        await isolated.start();
        const started = await isolated.rpc('work_start', { task: 'Build a habit tracker', requestId: 'habit-first' });
        const { job, notificationSetupToken, notificationBound } = started.body.result.structuredContent;
        assert.equal(notificationBound, false);

        const missing = await isolated.rpc('worker_notification_setup', {});
        assert.equal(missing.body.result.isError, true, 'An omitted Job token must fail before a form can be issued.');
        assert.equal(isolated.callbacks.length, 0);

        const unbound = await isolated.rpc('work_continue', {
            jobId: job.jobId, message: 'Refine existing requirements', requestId: 'habit-unbound-followup',
        });
        assert.equal(unbound.body.result.structuredContent.notificationBound, false);

        const setup = await isolated.rpc('worker_notification_setup', { notificationSetupToken });
        assert.equal(setup.body.result.structuredContent.jobId, job.jobId);

        await isolated.authorize(setup.body.result.structuredContent.url);
        const paired = await isolated.rpc('worker_notification_pairing_status', { setupId: setup.body.result.structuredContent.setupId });
        assert.equal(paired.body.result.structuredContent.jobId, job.jobId);
        assert.equal(paired.body.result.structuredContent.notificationBound, true);

        await isolated.finish(job.jobId);
        const continued = await isolated.rpc('work_continue', {
            jobId: job.jobId, message: 'Add weekly targets', requestId: 'habit-followup',
        });
        assert.equal(continued.body.result.structuredContent.notificationBound, true);

        await isolated.finish(job.jobId);
        assert.deepEqual(isolated.callbacks.map((item) => item.event.event),
            ['work.webhook_test', 'work.turn_finished', 'work.turn_finished']);
    } finally {
        await isolated.close();
    }
});

test('a paired Job receives an idle-to-idle Fleet turn_finished event without duplicating earlier completions', async () => {
    const isolated = new FirstJobPairingScenario();

    try {
        await isolated.start();
        const started = await isolated.rpc('work_start', { task: 'Build a habit tracker', requestId: 'quick-turn-start' });
        const { job, notificationSetupToken } = started.body.result.structuredContent;
        const setup = await isolated.rpc('worker_notification_setup', { notificationSetupToken });
        await isolated.authorize(setup.body.result.structuredContent.url);
        await isolated.finish(job.jobId);

        await isolated.finish(job.jobId, { type: 'turn_finished', fromState: 'idle' });

        assert.deepEqual(isolated.callbacks.map((item) => item.event.event),
            ['work.webhook_test', 'work.turn_finished', 'work.turn_finished'],
            'Fleet can report a full turn completed between its own idle polls.');
        await isolated.gateway.notifications.poll();
        assert.equal(isolated.callbacks.length, 3);
    } finally {
        await isolated.close();
    }
});

test('an assistant reading only the first text block can pair the original Job and receive completion', async () => {
    const isolated = new FirstJobPairingScenario();

    try {
        await isolated.start();
        const status = await isolated.rpc('worker_notification_status');
        assert.equal(JSON.parse(status.body.result.content[0].text).preference, 'unset');

        const started = await isolated.rpc('work_start', {
            task: 'Build a daily horoscope tool', requestId: 'visible-dispatch',
        });
        const result = started.body.result;
        const first = JSON.parse(result.content[0].text);

        assert.equal(first.job.jobId, result.structuredContent.job.jobId);
        assert.equal(first.notificationBound, false);
        assert.match(first.notificationSetupToken ?? '', /^[a-f0-9]{64}$/,
            'The first text block must contain the private token, even without structuredContent.');
        assert.equal(first.notificationSetupToken, result.structuredContent.notificationSetupToken);

        const setup = await isolated.rpc('worker_notification_setup', {
            notificationSetupToken: first.notificationSetupToken,
        });
        const { url, setupId } = JSON.parse(setup.body.result.content[0].text);
        await isolated.authorize(url);

        const paired = await isolated.rpc('worker_notification_pairing_status', { setupId });
        const receipt = JSON.parse(paired.body.result.content[0].text);

        assert.equal(receipt.jobId, first.job.jobId);
        assert.equal(receipt.notificationBound, true);

        await isolated.finish(first.job.jobId);
        const continued = await isolated.rpc('work_continue', {
            jobId: first.job.jobId, message: 'Add a daily guide', requestId: 'visible-continue',
        });
        const followup = JSON.parse(continued.body.result.content[0].text);

        assert.equal(followup.job.jobId, first.job.jobId);
        assert.equal(followup.notificationBound, true);

        await isolated.finish(first.job.jobId);

        assert.deepEqual(isolated.callbacks.map((item) => item.event.event),
            ['work.webhook_test', 'work.turn_finished', 'work.turn_finished']);
    } finally {
        await isolated.close();
    }
});

class ConnectionNotificationScenario extends NotificationScenario {
    async connection(connectionId, webhook, token = NotificationScenario.clientToken, origin) {
        const response = await fetch(this.address + '/notifications/connections/' + connectionId, {
            method: webhook ? 'PUT' : 'GET',
            headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json',
                ...(origin ? { origin } : {}) },
            ...(webhook ? { body: JSON.stringify(webhook) } : {}),
        });

        return { status: response.status, data: await response.json() };
    }
}

test('local owner configures connection notifications before any Job and the dedicated route survives restart', async () => {
    const isolated = new ConnectionNotificationScenario();
    const connectionId = 'a'.repeat(64);
    const otherConnectionId = 'b'.repeat(64);
    const webhook = { url: null, header: 'Authorization', secret: 'Authorization: Bearer owner-connection-key' };

    try {
        await isolated.start();
        webhook.url = isolated.webhookURL;

        assert.equal((await isolated.connection(connectionId, webhook, 'wrong-key')).status, 401);
        assert.equal(isolated.callbacks.length, 0);

        const configured = await isolated.connection(connectionId, webhook);
        assert.equal(configured.status, 200, 'The owner must be able to configure notification before dispatching any Job.');
        assert.equal(configured.data.enabled, true);
        assert.match(configured.data.notificationRouteId, /^[a-f0-9]{64}$/);
        assert.equal(isolated.dispatches.length, 0);
        assert.equal(isolated.callbacks[0].event.event, 'work.webhook_test');
        assert.equal((await isolated.connection(connectionId, webhook, NotificationScenario.clientToken,
            'https://untrusted.example')).status, 403);
        assert.equal(isolated.callbacks.length, 1);

        await isolated.restartGateway();
        const saved = await isolated.connection(connectionId);
        assert.equal(saved.data.notificationRouteId, configured.data.notificationRouteId);
        assert.equal((await isolated.connection(otherConnectionId)).data.enabled, false);

        const other = await isolated.connection(otherConnectionId, {
            ...webhook, secret: 'other-connection-key',
        });
        assert.notEqual(other.data.notificationRouteId, saved.data.notificationRouteId);

        for (const route of [saved.data.notificationRouteId, other.data.notificationRouteId]) {
            const started = await isolated.rpc('work_start', {
                task: 'Build a walking tracker', requestId: 'connection-' + route.slice(0, 8), notificationRouteId: route,
            });
            assert.equal(started.body.result.structuredContent.notificationBound, true);
            await isolated.finish(started.body.result.structuredContent.job.jobId);
        }

        assert.deepEqual(isolated.callbacks.filter((item) => item.event.event === 'work.turn_finished')
            .map((item) => item.authorization), ['Bearer owner-connection-key', 'Bearer other-connection-key']);
        assert.equal(isolated.dispatches.length, 2);
    } finally {
        await isolated.close();
    }
});
