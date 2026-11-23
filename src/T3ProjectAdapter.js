import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export class T3ProjectAdapter {
    async register(workspacePath, title) {
        const scriptPath = fileURLToPath(new URL('../scripts/windows/Register-T3Project.ps1', import.meta.url));
        const command = process.platform === 'win32' ? 'powershell.exe' : 't3';
        const args = process.platform === 'win32'
            ? [
                '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
                '-WorkspacePath', workspacePath, '-Title', title,
            ]
            : ['project', 'add', workspacePath, '--title', title];

        let stdout;
        try {
            ({ stdout } = await execute(command, args, {
                timeout: 60_000,
                maxBuffer: 64_000,
                windowsHide: true,
            }));
        } catch {
            throw new Error('T3 project registration failed. Verify the existing T3 background service and CLI; do not delete a database lock or re-register blindly');
        }

        const match = stdout.match(/Added project ([0-9a-z-]{8,100}) \(/i);
        if (!match) {
            throw new Error('T3 project registration result did not contain a verifiable project ID');
        }

        return match[1];
    }
}
