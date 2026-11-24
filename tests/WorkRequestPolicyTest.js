import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkRequestPolicy } from '../src/WorkRequestPolicy.js';

test('a new Git-backed task and its follow-up default to saving meaningful finished milestones', () => {
    const start = { jsonrpc: '2.0', method: 'tools/call', params: {
        name: 'work_start', arguments: { task: '建立一個行銷工具', requestId: 'test-1' },
    } };
    const forwarded = WorkRequestPolicy.apply(start);
    assert.match(forwarded.params.arguments.task, /commit.*meaningful milestone/i);
    assert.match(forwarded.params.arguments.task, /do not ask the user whether to commit/i);
    assert.equal(start.params.arguments.task, '建立一個行銷工具', 'input must stay immutable');

    const followup = WorkRequestPolicy.apply({ method: 'tools/call', params: {
        name: 'work_continue', arguments: { message: '把 CSV 欄位對應做得更好', jobId: 'existing', requestId: 'test-2' },
    } });
    assert.match(followup.params.arguments.message, /commit.*meaningful milestone/i);
    assert.equal(followup.params.arguments.jobId, 'existing');
});

test('commit policy never alters read-only requests, starts with no task, or duplicates on retries', () => {
    const read = { method: 'tools/call', params: { name: 'work_status', arguments: { jobId: 'x' } } };
    assert.equal(WorkRequestPolicy.apply(read), read);
    const missing = { method: 'tools/call', params: { name: 'work_start', arguments: { requestId: 'x' } } };
    assert.equal(WorkRequestPolicy.apply(missing), missing);

    const start = { method: 'tools/call', params: { name: 'work_start', arguments: { task: 'Create a report' } } };
    const once = WorkRequestPolicy.apply(start);
    assert.deepEqual(WorkRequestPolicy.apply(once), once);
});
