/** Canonical routing identity, scoped to an authorized connection, not proof of Bot identity. */
export class AssistantIdentity {
    static parse(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('Provide the assistant routing identity.');
        }

        if (value.type === 'bot' && Object.keys(value).length === 3 &&
            typeof value.platform === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value.platform) &&
            typeof value.botId === 'string' && /^[A-Za-z0-9._:-]{1,256}$/.test(value.botId)) {
            return { type: 'bot', platform: value.platform, botId: value.botId };
        }
        if (value.type === 'agentAddress' && Object.keys(value).length === 2 &&
            typeof value.address === 'string' && /^[^\s\u0000-\u001f\u007f]{1,512}$/u.test(value.address)) {
            return { type: 'agentAddress', address: value.address };
        }

        throw new Error('Invalid Bot ID or Agent Address.');
    }

    static fromPath(value) {
        if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,4096}$/.test(value)) {
            throw new Error('Invalid encoded assistant identity.');
        }

        return this.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    }

    static scopedKey(connectionId, identity) {
        if (typeof connectionId !== 'string' || !/^[a-f0-9]{64}$/.test(connectionId)) {
            throw new Error('Invalid authorized Worker connection identifier.');
        }

        return JSON.stringify([connectionId, this.parse(identity)]);
    }
}
