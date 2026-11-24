import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JobNotificationService } from '../src/JobNotificationService.js';

test('after job dispatch, a background feed sends one user-friendly notification without polling the chat', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'awg-notification-test-'));
    const messages = [];
    let events = [
        { type: 'state_changed', jobId: 'oldjob11', toState: 'idle' },
    ];
    const upstream = {
        async callTool(name, args) {
            if (name === 'work_feed') {
                assert.equal(args.mine, true, 'Only this client’s jobs should notify the user');
                return { structuredContent: { events, nextCursor: events.length > 1 ? '3' : '1', hasMore: false } };
            }
            if (name === 'work_status') {
                return { structuredContent: { job: {
                    jobId: args.jobId, state: 'idle', waitingOnDelegatedWork: false,
                    title: '行銷工具 [job:' + args.jobId + ']',
                } } };
            }
            throw new Error('Unexpected upstream request: ' + name);
        },
    };
    const service = new JobNotificationService({ notificationStateDirectory: directory }, upstream, {
        notify: async (message) => messages.push(message),
    });
    try {
        await service.poll();
        assert.equal(messages.length, 0, 'First start must not spam old jobs');
        events = [
            { type: 'state_changed', jobId: 'newjob22', toState: 'idle' },
            { type: 'state_changed', jobId: 'newjob22', toState: 'idle' },
        ];
        await service.poll();
        assert.deepEqual(messages, [{ title: '行銷工具', message: '這輪處理已結束，請回到助理查看成果。' }]);

        const restart = new JobNotificationService({ notificationStateDirectory: directory }, upstream, {
            notify: async (message) => messages.push(message),
        });
        events = [];
        await restart.poll();
        assert.equal(messages.length, 1, 'Stored feed position must survive an app restart');
        assert.equal(JSON.parse(await readFile(path.join(directory, 'notification-cursor.json'), 'utf8')).cursor, '1');
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('a coordinator still waiting on delegated work must not send a premature completion notice', async () => {
    const messages = [];
    const service = new JobNotificationService({}, {
        callTool: async () => ({ structuredContent: { job: {
            jobId: 'active88', state: 'idle', waitingOnDelegatedWork: true, title: '網站工具',
        } } }),
    }, { notify: async (item) => messages.push(item) });
    await service._processEvents([{ type: 'state_changed', toState: 'idle', jobId: 'active88' }]);
    assert.equal(messages.length, 0);
});
