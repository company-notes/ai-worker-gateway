import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ModelSelectionPolicy } from './ModelSelectionPolicy.js';

const maxSettingsBytes = 2 * 1024 * 1024;

export function normalizeT3ModelSelection(input) {
    if (input === null || input === undefined) {
        return null;
    }

    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('T3 default model selection is invalid.');
    }

    const selection = {
        instanceId: input.instanceId,
        model: input.model,
    };

    if (input.options !== undefined && input.options !== null) {
        let options;
        if (Array.isArray(input.options)) {
            options = Object.create(null);
            for (const entry of input.options) {
                if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
                    typeof entry.id !== 'string' || !entry.id.trim() ||
                    Object.prototype.hasOwnProperty.call(options, entry.id)) {
                    throw new Error('T3 model options contain invalid or duplicate IDs.');
                }
                options[entry.id] = entry.value;
            }
        } else {
            options = input.options;
        }

        selection.options = { ...options };
    }

    return ModelSelectionPolicy.validate(selection);
}

export async function inspectT3Default(options = {}) {
    const baseDir = options.t3Home ?? process.env.T3CODE_HOME ?? path.join(os.homedir(), '.t3');
    const settingsPath = path.join(baseDir, 'userdata', 'settings.json');
    let info;
    try {
        info = await fs.lstat(settingsPath);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return { status: 'missing' };
        }
        throw error;
    }

    if (!info.isFile() || info.isSymbolicLink() || info.size > maxSettingsBytes) {
        return { status: 'invalid', detail: 'T3 settings must be a regular bounded file.' };
    }

    try {
        const data = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
        const selection = normalizeT3ModelSelection(data?.defaultModelSelection);
        return selection
            ? { status: 'found', selection }
            : { status: 'unset' };
    } catch {
        return { status: 'invalid', detail: 'Could not parse a valid T3 default model selection.' };
    }
}
