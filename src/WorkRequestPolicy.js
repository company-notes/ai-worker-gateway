const marker = '[AWG delivery policy v1]';
const directive = [
    '',
    '',
    marker,
    'Unless the user explicitly requests no commits, for a Git repository commit your own verified deliverable changes at each completed meaningful milestone and at final handoff.',
    'Stage only files you intentionally changed. Do not overwrite, reset, commit or discard unrelated existing changes.',
    'Do not ask the user whether to commit. Do not push or merge branches unless the user specifically requests that.',
    'If this is a non-Git workspace or Git commit fails, explain the limitation in your work result; do not pretend a version was saved.',
    'Verify the requested deliverables and give a brief nontechnical result with human-readable file names.',
    'Do not make the user handle job IDs, branches, worktrees, commit hashes or internal gateway credentials.',
    '[/AWG delivery policy v1]',
].join('\n');

export class WorkRequestPolicy {
    static apply(payload) {
        if (payload?.method !== 'tools/call') {
            return payload;
        }

        const name = payload.params?.name;
        const field = name === 'work_start' ? 'task' : name === 'work_continue' ? 'message' : null;
        if (!field || typeof payload.params.arguments?.[field] !== 'string') {
            return payload;
        }

        const original = payload.params.arguments[field];
        if (original.includes(marker)) {
            return payload;
        }

        return {
            ...payload,
            params: {
                ...payload.params,
                arguments: {
                    ...payload.params.arguments,
                    [field]: original + directive,
                },
            },
        };
    }
}
