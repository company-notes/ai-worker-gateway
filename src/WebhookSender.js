import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
for (const [subnet, bits] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10],
    ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
    ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
    ['224.0.0.0', 4], ['240.0.0.0', 4],
]) {
    blocked.addSubnet(subnet, bits, 'ipv4');
}
for (const [subnet, bits] of [
    ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10],
    ['ff00::', 8], ['::ffff:0:0', 96],
]) {
    blocked.addSubnet(subnet, bits, 'ipv6');
}

export function validateWebhook(webhook) {
    if (!webhook || typeof webhook !== 'object' ||
        typeof webhook.url !== 'string' || webhook.url.length > 2000) {
        throw new Error('請提供完整通知網址。');
    }

    let url;
    try {
        url = new URL(webhook.url);
    } catch {
        throw new Error('通知網址格式不正確。');
    }

    const local = url.protocol === 'http:' && url.hostname === '127.0.0.1';
    if ((url.protocol !== 'https:' && !local) ||
        url.username || url.password || url.hash ||
        !url.hostname || url.hostname === 'localhost' ||
        (!local && isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0)) {
        throw new Error('通知網址必須使用 HTTPS；同機測試只允許 http://127.0.0.1。');
    }
    if (url.port && (Number(url.port) < 1 || Number(url.port) > 65535)) {
        throw new Error('通知網址的連接埠不合法。');
    }

    const header = webhook.header || 'Authorization';
    const value = webhook.secret;
    if (!/^(?:Authorization|X-[A-Za-z0-9-]{1,60})$/i.test(header) ||
        /^(?:X-Forwarded-|X-Original-|X-Real-)/i.test(header) ||
        typeof value !== 'string' || !value.trim() ||
        value.length > 2048 || /[\r\n\0]/.test(value)) {
        throw new Error('通知金鑰或安全標頭名稱不合法。');
    }

    return {
        url: url.href,
        header,
        secret: value.trim(),
    };
}

export class WebhookSender {
    constructor(options = {}) {
        this.resolve = options.resolve ?? lookup;
    }

    async _resolveAddress(url) {
        if (url.protocol === 'http:' && url.hostname === '127.0.0.1') {
            return { address: '127.0.0.1', family: 4 };
        }
        const entries = await this.resolve(url.hostname, { all: true, verbatim: true });
        if (!Array.isArray(entries) || entries.length === 0 ||
            entries.some(({ address, family }) =>
                ![4, 6].includes(family) || blocked.check(address, family === 4 ? 'ipv4' : 'ipv6'))) {
            throw new Error('Webhook 網址解析到不允許的私人網路位址。');
        }

        return entries[0];
    }

    async deliver(webhook, payload) {
        const settings = validateWebhook(webhook);
        const target = new URL(settings.url);
        const ip = await this._resolveAddress(target);
        const body = Buffer.from(JSON.stringify(payload), 'utf8');
        if (body.length > 16_384) {
            throw new Error('Webhook event exceeds size limit');
        }

        const keyValue = settings.header.toLowerCase() === 'authorization' &&
            !/^Bearer\s+/i.test(settings.secret) ? 'Bearer ' + settings.secret : settings.secret;
        const transport = target.protocol === 'https:' ? httpsRequest : httpRequest;
        await new Promise((resolve, reject) => {
            const request = transport(target, {
                method: 'POST',
                lookup: (_hostname, _options, callback) => callback(null, ip.address, ip.family),
                headers: {
                    'content-type': 'application/json',
                    'content-length': body.length,
                    'x-awg-event-id': payload.deliveryId,
                    [settings.header]: keyValue,
                },
                timeout: 10_000,
            }, (response) => {
                response.resume();
                if (response.statusCode >= 200 && response.statusCode < 300) {
                    response.on('end', resolve);
                } else {
                    response.on('end', () => reject(new Error('Webhook responded HTTP ' + response.statusCode)));
                }
            });
            request.once('timeout', () => request.destroy(new Error('Webhook delivery timed out')));
            request.once('error', reject);
            request.end(body);
        });
    }
}
