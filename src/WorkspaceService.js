import { promises as fileSystem } from 'node:fs';
import path from 'node:path';

export class WorkspaceService {
    constructor(rootPath) {
        this.rootPath = rootPath;
    }

    _validateName(name) {
        if (typeof name !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,62})$/.test(name)) {
            throw new Error('Workspace name must be a lowercase slug of 1–63 letters, digits or hyphens');
        }
    }

    async _getRoot() {
        if (this.rootPath === null) {
            throw new Error('Workspace provisioning is disabled (AWG_WORKSPACE_ROOT is unset)');
        }
        const rootStatus = await fileSystem.lstat(this.rootPath);
        if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
            throw new Error('Configured workspace root must be an existing directory, not a symlink');
        }

        return fileSystem.realpath(this.rootPath);
    }

    async _inspectWorkspace(workspacePath) {
        let status;
        try {
            status = await fileSystem.lstat(workspacePath);
        } catch (error) {
            if (error.code === 'ENOENT') {
                return false;
            }
            throw error;
        }
        if (!status.isDirectory() || status.isSymbolicLink()) {
            throw new Error('Workspace path already exists and is not a regular directory');
        }

        return true;
    }

    async pathFor(name) {
        this._validateName(name);
        const root = await this._getRoot();
        const workspacePath = path.join(root, name);
        await this._inspectWorkspace(workspacePath);

        return workspacePath;
    }

    async plan(name) {
        this._validateName(name);
        const root = await this._getRoot();
        const exists = await this._inspectWorkspace(path.join(root, name));

        return {
            workspaceName: name,
            exists,
            dispatchReady: false,
            registrationRequired: true,
            explanation: 'A local folder is not a registered T3 Project or a Fleet job target.',
        };
    }

    async prepare(name) {
        this._validateName(name);
        const root = await this._getRoot();
        const workspacePath = path.join(root, name);
        const existing = await this._inspectWorkspace(workspacePath);
        let created = false;
        if (!existing) {
            try {
                await fileSystem.mkdir(workspacePath, { mode: 0o700 });
                created = true;
            } catch (error) {
                if (error.code !== 'EEXIST') {
                    throw error;
                }
            }
        }

        await this._inspectWorkspace(workspacePath);

        return {
            workspaceName: name,
            created,
            dispatchReady: false,
            registrationRequired: true,
            explanation: 'Folder prepared; the operator must register the project with T3 and approve its Fleet policy before dispatch.',
        };
    }
}
