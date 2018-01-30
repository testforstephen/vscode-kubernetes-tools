import { IDockerClient, IDockerParser } from "./debugInterfaces";
import { shell, ShellResult } from "../shell";

export class DockerClient implements IDockerClient {
    async build(image: string, shellOpts: any): Promise<ShellResult> {
        return await shell.execCore(`docker build -t ${image} .`, shellOpts);
    }

    async push(image: string, shellOpts: any): Promise<ShellResult> {
        return await shell.execCore('docker push ' + image, shellOpts);
    }
}
