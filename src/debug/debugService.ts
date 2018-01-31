import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { ChildProcess } from "child_process";

import { IDebugProvider, IDebugService, IDockerClient, IDockerParser } from "./debugInterfaces";
import { DockerClient } from "./dockerClient";
import { DockerfileParser } from "./dockerfileParser";
import * as providerRegistry from "./providerRegistry";

import * as docker from "../docker";
import { kubeChannel } from "../kubeChannel";
import { Kubectl } from "../kubectl";
import { getKubeconfig } from "../kubectlUtils";
import { shell } from "../shell";
import { sleep } from "../sleep";

export class DebugService implements IDebugService {
    private debugProvider: IDebugProvider;
    private dockerParser: IDockerParser;
    private dockerClient: IDockerClient;

    constructor(private readonly kubectl: Kubectl) {
    }

    public async launchDebug(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
        if (!workspaceFolder) {
            return;
        }
        // TODO: Support docker-compose.yml
        const dockerfilePath = path.join(workspaceFolder.uri.fsPath, "Dockerfile");
        if (!fs.existsSync(dockerfilePath)) {
            vscode.window.showErrorMessage(`No Dockerfile found at the workspace ${workspaceFolder.name}`);
            return;
        }
        this.dockerParser = new DockerfileParser(dockerfilePath);
        this.dockerClient = new DockerClient();
        this.debugProvider = await providerRegistry.getDebugProvider(this.dockerParser.getBaseImage());
        if (!this.debugProvider) {
            return;
        } else if (!await this.debugProvider.isDebuggerInstalled()) { // Check the required debugger extension is installed or not.
            return;
        }

        const cwd = workspaceFolder.uri.fsPath;
        const dockerImageUser = vscode.workspace.getConfiguration().get("vsdocker.imageUser", null);
        const containerEnv= {};
        const portInfo = await this.debugProvider.getDockerResolver().resolvePortsFromFile(this.dockerParser, containerEnv);
        if (!portInfo.debug) {
            vscode.window.showErrorMessage("Cannot resolve debug port from Dockerfile.");
            return;
        }
        if (!portInfo.app || !Number.isInteger(Number(portInfo.app))) {
            vscode.window.showErrorMessage(`Cannot resolve application port from Dockerfile.`);
            return;
        }

        vscode.window.withProgress({ location: vscode.ProgressLocation.Window }, async (p) => {
            let appName;
            try {
                // Build docker image.
                p.report({ message: "Building docker image..."});
                const image = await this.buildDockerImage(cwd, dockerImageUser);
    
                // Run docker image in k8s container.
                p.report({ message: "Running docker image on k8s..."});
                appName = await this.runDockerImageInK8s(image, [portInfo.app, portInfo.debug], containerEnv);
    
                // Find the running debug pod.
                p.report({ message: "Finding the debug pod..."});
                const podList = await this.findPods(`run=${appName}`);
                if (podList.items.length === 0) {
                    vscode.window.showErrorMessage("Failed to find debug pod.");
                    throw new Error("Failed to find debug pod.");
                }
                const podName = podList.items[0].metadata.name;
                kubeChannel.showOutput(`Debug pod running as: ${podName}`, "Run debug pod");
                
                // Wait for the debug pod status to be running.
                p.report({ message: "Waiting for the pod to be ready..."});
                await this.waitForRunningPod(podName);
    
                // Setup port-forward.
                p.report({ message: "Creating port-forwarding..."});
                const proxyResult = await this.createPortForward(podName, portInfo.debug, portInfo.app);
    
                // Start debug session.
                p.report({ message: `Starting ${this.debugProvider.getDebuggerType()} debug session...`});
                await this.startDebug(
                    appName,
                    proxyResult.proxyProcess,
                    cwd,
                    this.debugProvider.getDebuggerType(),
                    proxyResult.proxyDebugPort,
                    proxyResult.proxyAppPort);
            } catch (error) {
                kubeChannel.showOutput(`Debug(Launch) on kubernetes failed. See the errors: ${error}.`);
                if (appName) {
                    try {
                        await this.deleteResource(`deployment/${appName}`);
                    } catch (error1) {
                        // do nothing.
                    }
                }
            }
            return null;
        });
    }

    public async attachDebug(workspaceFolder: vscode.WorkspaceFolder, pod?: string): Promise<void> {
        if (!workspaceFolder) {
            return;
        }

        // Select the image type to attach.
        this.debugProvider = await providerRegistry.getDebugProvider();
        if (!this.debugProvider) {
            return;
        } else if (!await this.debugProvider.isDebuggerInstalled()) { // Check the debugger extension is installed or not.
            return;
        }

        // Select the target pod to attach.
        let targetPod, targetContainer, containers = [];
        if (pod) {
            targetPod = pod;
            const shellResult = await this.kubectl.invokeAsync(`get pod/${pod} -o json`);
            if (shellResult.code !== 0) {
                vscode.window.showErrorMessage(shellResult.stderr);
                return;
            }
            containers = JSON.parse(shellResult.stdout.trim()).spec.containers;
        } else {
            const shellResult = await this.kubectl.invokeAsync("get pods -o json");
            if (shellResult.code !== 0) {
                vscode.window.showErrorMessage(shellResult.stderr);
                return;
            }
            const podObj = JSON.parse(shellResult.stdout.trim());
            const podPickItems: vscode.QuickPickItem[] = podObj.items.map((pod) => {
                return { 
                    label: `${pod.metadata.name} (${pod.spec.nodeName})`,
                    description: "pod",
                    name: pod.metadata.name,
                    containers: pod.spec.containers
                };
            });
            const selectedPod = await vscode.window.showQuickPick(podPickItems, { placeHolder: `Please select a pod to attach` });
            if (!selectedPod) {
                return;
            }
            targetPod = (<any> selectedPod).name;
            containers = (<any> selectedPod).containers;
        }
    
        // Select the target container to attach.
        if (containers.length > 1) {
            const containerPickItems: vscode.QuickPickItem[] = containers.map((container) => {
                return {
                    label: `${container.name} (${container.image})`,
                    description: "container",
                    name: container.name
                };
            });
            const selectedContainer = await vscode.window.showQuickPick(containerPickItems, { placeHolder: "Please select a container to attach" });
            if (!selectedContainer) {
                return;
            }
            targetContainer = (<any> selectedContainer).name;
        }
    
        // Find the debug port to attach.
       const portInfo = await this.debugProvider.getDockerResolver().resolvePortsFromPod(this.kubectl, targetPod, targetContainer);
        if (!portInfo.debug) {
            return;
        }
    
        vscode.window.withProgress({ location: vscode.ProgressLocation.Window }, async (p) => {
            try {
                // Setup port-forward.
                p.report({ message: "Creating port-forwarding..."});
                const proxyResult = await this.createPortForward(targetPod, portInfo.debug, null);
    
                // Start debug session.
                p.report({ message: `Starting ${this.debugProvider.getDebuggerType()} debug session...`});
                await this.startDebug(
                    null,
                    proxyResult.proxyProcess,
                    workspaceFolder.uri.fsPath,
                    this.debugProvider.getDebuggerType(),
                    proxyResult.proxyDebugPort,
                    proxyResult.proxyAppPort);
            } catch (error) {
                // do nothing.
            }
            return null;
        });
    }

    private async buildDockerImage(cwd: string, dockerImageUser?: string): Promise<string> {
        const name = docker.sanitiseTag(path.basename(cwd));
        const version = await this.findVersion(cwd);
        let image = name + ":" + version;
        if (dockerImageUser) {
            image = dockerImageUser + "/" + image;
        }
        const shellOpts = Object.assign({ }, shell.execOpts(), { cwd });
        if (!dockerImageUser) {
            const dockerEnv = await this.resolveDockerEnv();
            // In order to allow local kubernetes cluster (e.g. minikube) to have access to local docker images,
            // need override docker-env before running docker build.
            shellOpts.env = Object.assign({}, shellOpts.env, dockerEnv);
        }
        const buildResult = await this.dockerClient.build(image, shellOpts);
        if (buildResult.code === 0) {
            kubeChannel.showOutput(image + ' built.', "Docker build");
            if (dockerImageUser) {
                const pushResult = await this.dockerClient.push(image, shellOpts);
                if (pushResult.code !== 0) {
                    vscode.window.showErrorMessage('Image push failed. See Output window for details.');
                    kubeChannel.showOutput(pushResult.stderr, 'Docker push');
                    throw new Error(`Image push failed: ${pushResult.stderr}`);
                }
                kubeChannel.showOutput(image + ' pushed.', "Docker push");
            }
            return image;
        } else {
            vscode.window.showErrorMessage('Image build failed. See Output window for details.');
            kubeChannel.showOutput(buildResult.stderr, 'Docker build');
            throw new Error(`Image build failed: ${buildResult.stderr}`);
        }
    }

    // When using command "minikube docker-env" to get local kubernetes docker env, it needs run with the admin privilege.
    // To workaround this, this function will try to resolve the equivalent docker env from kubeconfig instead.
    private async resolveDockerEnv(): Promise<{}> {
        const dockerEnv = {};
        const versionResult = await shell.exec(`docker version --format "{{.Client.APIVersion}}"`);
        dockerEnv["DOCKER_API_VERSION"] = "1.23";
        if (versionResult.code === 0) {
            dockerEnv["DOCKER_API_VERSION"] = versionResult.stdout.trim();
        }
        const kubeConfig = await getKubeconfig(this.kubectl);
        if (!kubeConfig) {
            return {};
        }
        const contextConfig = kubeConfig.contexts.find((context) => context.name === kubeConfig["current-context"]);
        const clusterConfig = kubeConfig.clusters.find((cluster) => cluster.name === contextConfig.context.cluster);
        const server = clusterConfig.cluster.server;
        const certificate = clusterConfig.cluster["certificate-authority"];
        if (!certificate) {
            return {};
        }
        if (/^https/.test(server)) {
            dockerEnv["DOCKER_TLS_VERIFY"] = 1;
        }
        dockerEnv["DOCKER_HOST"] = server.replace(/^https?:/, "tcp:").replace(/:\d+$/, ":2376");
        const certDir = path.dirname(certificate);
        if (fs.existsSync(path.join(certDir, "certs"))) {
            dockerEnv["DOCKER_CERT_PATH"] = path.join(certDir, "certs");
        } else {
            dockerEnv["DOCKER_CERT_PATH"] = certDir;
        }
        return dockerEnv;
    }

    private async findVersion(cwd: string): Promise<string> {
        const shellOpts = Object.assign({ }, shell.execOpts(), { cwd });
        const shellResult = await shell.execCore('git describe --always --dirty', shellOpts);
        return shellResult.code !== 0 ? "latest" : shellResult.stdout.trim();
    }

    private async runDockerImageInK8s(image: string, exposedPorts: string[], env: any): Promise<string> {
        let imageName = image.split(":")[0];
        let imageUser = imageName.substring(0, imageName.lastIndexOf("/")+1);
        let baseName = imageName.substring(imageName.lastIndexOf("/")+1);
        const deploymentName = `${baseName}-debug-${Date.now()}`;
        let runCmd = [
            "run",
            deploymentName,
            `--image=${image}`,
            !imageUser ? " --image-pull-policy=Never" : "",
            ...exposedPorts.map((port) => port ? `--port=${port}` : ""),
            ...Object.keys(env || {}).map((key) => `--env="${key}=${env[key]}"`)
        ];
        const runResult = await this.kubectl.invokeAsync(runCmd.join(" "));
        if (runResult.code !== 0) {
            vscode.window.showErrorMessage("Failed to start debug container: " + runResult.stderr);
            throw new Error("Failed to start debug container: " + runResult.stderr);
        }
        return deploymentName;
    }

    private async findPods(labelQuery): Promise<any> {
        const getResult = await this.kubectl.invokeAsync(`get pods -o json -l ${labelQuery}`);
        if (getResult.code !== 0) {
            vscode.window.showErrorMessage('Kubectl command failed: ' + getResult.stderr);
            throw new Error('Kubectl command failed: ' + getResult.stderr);
        }
        try {
            return JSON.parse(getResult.stdout);
        } catch (ex) {
            vscode.window.showErrorMessage('unexpected error: ' + ex);
            throw new Error('unexpected error: ' + ex);
        }
    }

    private async waitForRunningPod(podName): Promise<void> {
        const shellResult = await this.kubectl.invokeAsync(`get pod/${podName} --no-headers`);
        if (shellResult.code !== 0) {
            kubeChannel.showOutput(`Failed to get pod status: ${shellResult.stderr}`, "Query pod status");
            vscode.window.showErrorMessage(`Failed to get pod status: ${shellResult.stderr}`);
            throw new Error(`Failed to get pod status: ${shellResult.stderr}`);
        }
        const status = shellResult.stdout.split(/\s+/)[2];
        kubeChannel.showOutput(`pod/${podName} status: ${status}`, "Query pod status");
        if (status === "Running") {
            return;
        } else if (status !== "ContainerCreating" && status !== "Pending" && status !== "Succeeded") {
            vscode.window.showErrorMessage(`The pod "${podName}" stays at a wrong status "${status}". See Output window for more details.`);

            const logsResult = await this.kubectl.invokeAsync(`logs pod/${podName}`);
            kubeChannel.showOutput(`Failed to start the pod "${podName}", it's status is "${status}".\n
                See more details from the pod logs:\n${logsResult.code === 0 ? logsResult.stdout : logsResult.stderr}`, `Query pod status`);
            throw new Error(`Failed to start the pod "${podName}", it's status is "${status}".`);
        }

        await sleep(1000);
        await this.waitForRunningPod(podName);
    }

    private async createPortForward(podName, debugPort, appPort): Promise<any> {
        const portMapping = [];
        const portfinder = require('portfinder');
        // Find a free local port for forwarding data to remote app port.
        let proxyAppPort = 0;
        if (appPort) {
            proxyAppPort = await portfinder.getPortPromise({
                port: appPort
            });
            portMapping.push(proxyAppPort + ":" + appPort);
        }
        // Find a free local port for forwarding data to remote debug port.
        let proxyDebugPort = await portfinder.getPortPromise();
        if (proxyDebugPort === proxyAppPort) {
            proxyDebugPort = await portfinder.getPortPromise({
                port: proxyAppPort + 1
            });
        }
        portMapping.push(proxyDebugPort + ":" + debugPort);

        let bin = vscode.workspace.getConfiguration('vs-kubernetes')['vs-kubernetes.kubectl-path'];
        if (!bin) {
            bin = 'kubectl';
        }
        
        return {
            proxyProcess: require('child_process').spawn(bin, ["port-forward", podName, ...portMapping]),
            proxyDebugPort,
            proxyAppPort
        };
    }

    private async startDebug(appName: string, proxyProcess: ChildProcess, workspaceFolder: string, debugType: string, proxyDebugPort: any, proxyAppPort: any): Promise<{}> {
        const forwardingRegExp = /Forwarding\s+from\s+127\.0\.0\.1:/;
        let isStarted = false;

        return new Promise((resolve, reject) => {

            proxyProcess.stdout.on('data', async (data) => {
                const message = `${data}`;
                if (!isStarted && forwardingRegExp.test(message)) {
                    isStarted = true;
                    const sessionName = appName || `${Date.now()}`;
                    const disposables: vscode.Disposable[] = [];

                    disposables.push(vscode.debug.onDidStartDebugSession((debugSession) => {
                        if (debugSession.name === sessionName) {
                            kubeChannel.showOutput(`The ${debugType} debug session is started, you could start debugging your application now.`, `Start ${debugType} debug`);
                            if (proxyAppPort) {
                                kubeChannel.showOutput(`The local proxy url for your service is http://localhost:${proxyAppPort}`, "Create proxy for service");
                                vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(`http://localhost:${proxyAppPort}`));
                            }
                        }
                    }));

                    disposables.push(vscode.debug.onDidTerminateDebugSession((debugSession) => {
                        if (debugSession.name === sessionName) {
                            proxyProcess.kill();
                            disposables.forEach((d) => d.dispose());
                        }
                    }));
    
                    const success = this.debugProvider.startDebugging(workspaceFolder, sessionName, proxyDebugPort);
                    if (!success) {
                        proxyProcess.kill();
                        disposables.forEach((d) => d.dispose());
                        reject();
                        return;
                    }
                    resolve();
                }
            });

            proxyProcess.stderr.on('data', (data) => {
                kubeChannel.showOutput(`${data}`, "port-forward");
            });

            proxyProcess.on('close', async (code) => {
                isStarted = true;
                resolve();
                if (appName) {
                    await this.deleteResource(`deployment/${appName}`);
                }
            });
        });
    }

    async deleteResource(resourceId: string) {
        const deleteResult = await this.kubectl.invokeAsync(`delete ${resourceId}`);
        if (deleteResult.code !== 0) {
            kubeChannel.showOutput(`Kubectl command failed: ${deleteResult.stderr}`, "Delete debug resource");
            return;
        } else {
            kubeChannel.showOutput(`Resource ${resourceId} is removed successfully.`, "Delete debug resource");
            vscode.commands.executeCommand("extension.vsKubernetesRefreshExplorer");
        }
    }
}
