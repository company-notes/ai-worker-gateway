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
