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

/** Errors safe to present to the owner without exposing receiver credentials. */
export class WebhookError extends Error {
    static messageFor(error) {
        if (error instanceof WebhookError) {
            return error.message;
        }

        if (['ENOTFOUND', 'EAI_AGAIN'].includes(error?.code)) {
            return '無法解析 Webhook 網址，請確認接收網址是否正確。';
        }

        if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(error?.code)) {
            return '無法連線到 Webhook 接收端，請確認 Routine 已啟用且可連線。';
        }

        if (['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
            'SELF_SIGNED_CERT_IN_CHAIN', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(error?.code)) {
            return 'Webhook 接收端的 HTTPS 憑證驗證失敗。';
        }

        return '無法完成通知設定，請確認 Webhook 接收端及 Gateway 狀態。';
    }
}

function normalizeWebhookSecret(header, value) {
    let secret = value.trim();
    const copied = /^(Authorization|X-[A-Za-z0-9-]{1,60})[ \t]*:[ \t]*/i.exec(secret);

    if (copied) {
        if (copied[1].toLowerCase() !== header.toLowerCase()) {
            throw new WebhookError('貼上的金鑰標頭與所選標頭不一致，請確認金鑰標頭。');
        }

        secret = secret.slice(copied[0].length).trim();
    }

    if (header.toLowerCase() === 'authorization') {
        secret = secret.replace(/^Bearer(?:[ \t]+|$)/i, '').trim();
    }

    if (!secret) {
        throw new WebhookError('請輸入 Webhook 金鑰。');
    }

    return secret;
}

export function validateWebhook(webhook) {
    if (!webhook || typeof webhook !== 'object' ||
        typeof webhook.url !== 'string' || webhook.url.length > 2000) {
        throw new WebhookError('請提供完整通知網址。');
    }

    let url;
    try {
        url = new URL(webhook.url);
    } catch {
        throw new WebhookError('通知網址格式不正確。');
    }

    const local = url.protocol === 'http:' && url.hostname === '127.0.0.1';
    if ((url.protocol !== 'https:' && !local) ||
        url.username || url.password || url.hash ||
        !url.hostname || url.hostname === 'localhost' ||
        (!local && isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0)) {
        throw new WebhookError('通知網址必須使用 HTTPS；同機測試只允許 http://127.0.0.1。');
    }

    if (url.port && (Number(url.port) < 1 || Number(url.port) > 65535)) {
        throw new WebhookError('通知網址的連接埠不合法。');
    }

    const header = webhook.header || 'Authorization';
    const value = webhook.secret;
    if (typeof header !== 'string' || !/^(?:Authorization|X-[A-Za-z0-9-]{1,60})$/i.test(header) ||
        /^(?:X-Forwarded-|X-Original-|X-Real-)/i.test(header) ||
        typeof value !== 'string' || !value.trim() ||
        value.length > 2048 || /[\r\n\0]/.test(value)) {
        throw new WebhookError('通知金鑰或安全標頭名稱不合法。');
    }

    return {
        url: url.href,
        header,
        secret: normalizeWebhookSecret(header, value),
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
            throw new WebhookError('Webhook 網址解析到不允許的私人網路位址。');
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

        const keyValue = settings.header.toLowerCase() === 'authorization' ? 'Bearer ' + settings.secret : settings.secret;
        const transport = target.protocol === 'https:' ? httpsRequest : httpRequest;

        await new Promise((resolve, reject) => {
            const request = transport(target, {
                method: 'POST',
                lookup: (_hostname, options, callback) => {
                    if (options.all) {
                        callback(null, [ip]);
                    } else {
                        callback(null, ip.address, ip.family);
                    }
                },
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
                    const status = response.statusCode;
                    const hint = [401, 403].includes(status) ? '，請確認金鑰及金鑰標頭。' : '，請確認接收網址及 Routine 是否啟用。';
                    response.on('end', () => reject(new WebhookError('Webhook 接收端回傳 HTTP ' + status + hint)));
                }
            });
            request.once('timeout', () => request.destroy(new WebhookError('Webhook 連線逾時，請確認接收端可連線。')));
            request.once('error', reject);
            request.end(body);
        });
    }
}
