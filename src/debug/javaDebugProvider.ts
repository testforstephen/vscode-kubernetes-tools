import * as path from "path";
import * as vscode from 'vscode';

import { IDebugProvider, IDockerParser, IDockerResolver, PortInfo } from './debugInterfaces';
import { shell } from '../shell';

// Use the java debugger extension provided by microsoft team for java debugging.
const defaultJavaDebuggerExtension = "vscjava.vscode-java-debug";

export class JavaDebugProvider implements IDebugProvider {
    constructor(readonly dockerResolver: IDockerResolver) {
    }

    public getDebuggerType(): string {
        return "java";
    }

    public async isDebuggerInstalled(): Promise<boolean> {
        if (vscode.extensions.getExtension(defaultJavaDebuggerExtension)) {
            return true;
        }
        const answer = await vscode.window.showInformationMessage(`Please install java debugger extension '${defaultJavaDebuggerExtension}' before starting java debug.`, "Install Now");
        if (answer === "Install Now") {
            const vscodeCliProgram = path.join(path.dirname(process.argv0), "bin", "code");
            const shellResult = await shell.exec(`"${vscodeCliProgram}" --install-extension ${defaultJavaDebuggerExtension}`);
            if (shellResult.code === 0) {
                const restartAns = await vscode.window.showInformationMessage("The java debugger extension was successfully installed. Restart to enable it.", "Restart Now");
                if (restartAns === "Restart Now") {
                    await vscode.commands.executeCommand("workbench.action.reloadWindow");
                }
            }
        }
        return false;
    }

    public async startDebugging(workspaceFolder: string, sessionName: string, port: string): Promise<boolean> {
        const debugConfiguration = {
            type: "java",
            request: "attach",
            name: sessionName,
            hostName: "localhost",
            port
        };
        const currentFolder = vscode.workspace.workspaceFolders.find((folder) => folder.name === path.basename(workspaceFolder));
        return await vscode.debug.startDebugging(currentFolder, debugConfiguration);
    }

    public getDockerResolver(): IDockerResolver {
        return this.dockerResolver;
    }
}
