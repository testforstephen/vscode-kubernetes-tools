import * as vscode from "vscode";

import { Kubectl } from '../kubectl';
import { ShellResult } from "../shell";

export interface PortInfo {
    debug: string;
    app: string;
}

export interface IDebugProvider {
    /**
     * The debugger type supported by the provider.
     * 
     */
    getDebuggerType(): string;

    /**
     * The required debugger extension is installed or not.
     * 
     */
    isDebuggerInstalled(): Promise<boolean>;

    /**
     * Launch the debugger extension and attach to the target debug port.
     * 
     * @param workspaceFolder the workspace folder path.
     * @param sessionName the debug session name.
     * @param port the debugging port exposed by the target program.
     * @return A thenable that resolves when debugging could be successfully started.
     */
    startDebugging(workspaceFolder: string, sessionName: string, port: string): Promise<boolean>;

    /**
     * Get the associated docker resolver for the provider.
     */
    getDockerResolver(): IDockerResolver;
}

export interface IDockerResolver {
    /**
     * The docker image is supported by the provider or not.
     * 
     */
    isSupportedImage(baseImage: string): boolean;

    /**
     * Resolve the debug port info from the dockerfile.
     */
    resolvePortsFromFile(dockerParser: IDockerParser, env: {}): Promise<PortInfo>;

    /**
     * Resolve the debug port info from the target container's shell environment.
     */
    resolvePortsFromPod(kubectl: Kubectl, pod: string, container: string): Promise<PortInfo>;
}

export interface IDockerParser {
    /**
     * Parse the inherited base image from the dockerfile.
     */
    getBaseImage(): string;

    /**
     *  Parse the exposed ports from the dockerfile.
     */
    getExposedPorts(): string[];

    /**
     * Search the debug options from the launch command.
     */
    searchLaunchArgs(regularExpression: RegExp): RegExpMatchArray;
}

export interface IDockerClient {
    /**
     * Build the docker image.
     * 
     * @param image the image name.
     * @param shellOpts any option available to Node.js's child_process.exec().
     * @return a ShellResult object.
     */
    build(image: string, shellOpts: any): Promise<ShellResult>;

    /**
     * Push the docker image to remote docker repository.
     * 
     * @param image the image name.
     * @param shellOpts any option available to Node.js's child_process.exec().
     * @return a ShellResult object.
     */
    push(image: string, shellOpts: any): Promise<ShellResult>;
}

export interface IDebugService {
    /**
     * In launch mode, it'll build the docker image and run it in kubernetes cluster first, then smartly analyse the debugging info from the docker image
     * and create port-forward, finally start a debugger to attach to the debugging process.
     * 
     * Besides, when the debug session is terminated, it'll kill port-forward and remove the created kubernetes resources (deployment/pod) automatically.
     * 
     * @param workspaceFolder the workspace file path.
     */
    launchDebug(workspaceFolder: vscode.WorkspaceFolder): Promise<void>;

    /**
     * In attach mode, it'll analyse the debugging info from the process running on container first and create port-forward, finally start a debugger to
     * attach to the debugging process.
     * 
     * @param workspaceFolder the workspace file path.
     * @param pod the debug pod name.
     */
    attachDebug(workspaceFolder: vscode.WorkspaceFolder, pod?: string): Promise<void>;
}
