import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, globalAgent } from 'node:https';
import { test } from 'node:test';
import { WebhookSender } from '../src/WebhookSender.js';

/** Replace only the DNS result so a real TLS receiver can run on the isolated test computer. */
class LocalReceiverSender extends WebhookSender {
    async _resolveAddress(url) {
        assert.equal(url.hostname, 'webhook.test');

        return { address: '127.0.0.1', family: 4 };
    }
}

test('a DNS-pinned HTTPS hostname receives an authenticated event with certificate verification', async () => {
    const key = readFileSync(new URL('./fixtures/webhook-test-key.pem', import.meta.url));
    const cert = readFileSync(new URL('./fixtures/webhook-test-cert.pem', import.meta.url));
    const callbacks = [];
    const receiver = createServer({ key, cert }, async (request, response) => {
        const chunks = [];

        for await (const chunk of request) {
            chunks.push(chunk);
        }

        callbacks.push({ authorization: request.headers.authorization,
            event: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        response.writeHead(204);
        response.end();
    });
    const previousCA = globalAgent.options.ca;

    // Trust only this disposable fixture in this test process; hostname and TLS checks remain enabled.
    globalAgent.options.ca = cert;
    try {
        await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
        const sender = new LocalReceiverSender();
        const event = { deliveryId: 'test-https', event: 'work.webhook_test' };
        const url = 'https://webhook.test:' + receiver.address().port + '/callback';

        for (const secret of ['disposable-test-key', 'Bearer disposable-test-key',
            'Authorization: Bearer disposable-test-key']) {
            await sender.deliver({ url, header: 'Authorization', secret }, event);
        }

        assert.equal(callbacks.length, 3);
        for (const callback of callbacks) {
            assert.deepEqual(callback, { authorization: 'Bearer disposable-test-key', event });
        }
    } finally {
        globalAgent.options.ca = previousCA;
        receiver.closeAllConnections();
        await new Promise((resolve) => receiver.close(resolve));
    }
});

test('production DNS validation still refuses a private address for a public HTTPS hostname', async () => {
    const sender = new WebhookSender({ resolve: async () => [{ address: '127.0.0.1', family: 4 }] });
    await assert.rejects(sender.deliver({ url: 'https://webhook.test/callback',
        header: 'Authorization', secret: 'disposable-test-key' }, { deliveryId: 'test-private' }), /私人網路/);
});

test('public HTTPS receiver DNS accepts ordinary IPv4 and IPv6, including dual-stack hosts', async () => {
    const url = new URL('https://webhook.test/callback');
    const ipv4 = { address: '104.21.1.1', family: 4 };
    const ipv6 = { address: '2606:4700::1', family: 6 };

    for (const entries of [[ipv4], [ipv6], [ipv4, ipv6], [ipv6, ipv4]]) {
        const sender = new WebhookSender({ resolve: async () => entries });
        assert.deepEqual(await sender._resolveAddress(url), entries[0]);
    }
});

test('mixed public and forbidden DNS results cannot bypass the receiver address policy', async () => {
    const url = new URL('https://webhook.test/callback');
    const publicAddress = { address: '104.21.1.1', family: 4 };

    for (const forbidden of [
        { address: '127.0.0.1', family: 4 },
        { address: '10.0.0.1', family: 4 },
        { address: '192.168.1.1', family: 4 },
        { address: '100.64.0.1', family: 4 },
        { address: '198.18.0.1', family: 4 },
        { address: '::1', family: 6 },
        { address: 'fc00::1', family: 6 },
        { address: '::ffff:104.21.1.1', family: 6 },
        { address: '::ffff:127.0.0.1', family: 6 },
    ]) {
        const sender = new WebhookSender({ resolve: async () => [publicAddress, forbidden] });
        await assert.rejects(sender._resolveAddress(url), /私人網路/);
    }
});
