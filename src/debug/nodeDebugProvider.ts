import * as path from "path";
import * as vscode from "vscode";

import { IDebugProvider, IDockerParser, IDockerResolver, PortInfo } from './debugInterfaces';
import { Kubectl } from '../kubectl';

const nodeDebugOptsRegExp = /(--)?(debug|inspect)(=\S*)?/;
const fullNodeDebugOptsRegExp = /node(js)?\s+.*(--)?(debug|inspect)(=\S*)?/i;

export class NodeDebugProvider implements IDebugProvider {
    constructor(readonly dockerResolver: IDockerResolver) {
    }

    public getDebuggerType(): string {
        return "node";
    }

    public async isDebuggerInstalled(): Promise<boolean> {
        // Use vscode built-in node debugger to debug nodejs application.
        return true;
    }

    public async startDebugging(workspaceFolder: string, sessionName: string, port: string): Promise<boolean> {
        const debugConfiguration = {
            type: 'node',
            request: 'attach',
            name: sessionName,
            port,
            localRoot: workspaceFolder,
            remoteRoot: '/'
        };
        const currentFolder = vscode.workspace.workspaceFolders.find((folder) => folder.name === path.basename(workspaceFolder));
        return await vscode.debug.startDebugging(currentFolder, debugConfiguration);
    }

    public getDockerResolver(): IDockerResolver {
        return this.dockerResolver;
    }
}
