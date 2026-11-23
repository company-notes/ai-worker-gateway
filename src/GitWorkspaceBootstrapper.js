import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const execute = promisify(execFile);

export class GitWorkspaceBootstrapper {
    async initialize(workspacePath, title) {
        await writeFile(path.join(workspacePath, 'README.md'), '# ' + title + '\n\nManaged AI Worker execution workspace.\n', {
            flag: 'wx',
            mode: 0o600,
        });

        await this._runGit(workspacePath, ['init', '-b', 'main']);
        await this._runGit(workspacePath, ['add', '--', 'README.md']);
        await this._runGit(workspacePath, [
            '-c', 'user.name=AI Worker Gateway', '-c', 'user.email=ai-worker-gateway@localhost',
            'commit', '-m', 'Initialize isolated worker workspace',
        ]);
    }

    async _runGit(workspacePath, args) {
        try {
            await execute('git', ['-C', workspacePath, ...args], {
                timeout: 30_000,
                windowsHide: true,
                maxBuffer: 16_384,
            });
        } catch {
            throw new Error('Git workspace initialization failed; inspect the isolated workspace and repair before retrying');
        }
    }
}
