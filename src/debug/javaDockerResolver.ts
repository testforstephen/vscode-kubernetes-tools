import * as vscode from 'vscode';

import { IDockerParser, IDockerResolver, PortInfo } from './debugInterfaces';
import { Kubectl } from '../kubectl';
import { shell } from '../shell';

const defaultJavaDebugPort = "5005";
const defaultJavaDebugOpts = `-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=${defaultJavaDebugPort},quiet=y`;
const javaDebugOptsRegExp = /(-agentlib|-Xrunjdwp):\S*(address=[^\s,]+)/i;
const fullJavaDebugOptsRegExp = /^java\s+.*(-agentlib|-Xrunjdwp):\S*(address=[^\s,]+)\S*/i;
const defaultJavaAppPort = "9000";

export class JavaDockerResolver implements IDockerResolver {
    public isSupportedImage(baseImage: string): boolean {
        return baseImage.indexOf("java") >= 0
            || baseImage.indexOf("openjdk") >= 0
            || baseImage.indexOf("oracle") >= 0;
    }

    public async resolvePortsFromFile(dockerParser: IDockerParser, env: {}): Promise<PortInfo> {
        const portInfo: PortInfo = {
            debug: null,
            app: null
        };

        // Resolve the debug port.
        const matches = dockerParser.searchLaunchArgs(javaDebugOptsRegExp);
        if (matches) {
            const addresses = matches[2].split("=")[1].split(":");
            portInfo.debug = addresses[addresses.length - 1];
        } else if (dockerParser.searchLaunchArgs(/\$\{?JAVA_OPTS\}?/)) {
            env["JAVA_OPTS"] = defaultJavaDebugOpts;
            portInfo.debug = defaultJavaDebugPort;
        }
        
        // Resolve the app port.
        const dockerExpose = dockerParser.getExposedPorts();
        if (portInfo.debug && dockerExpose.length) {
            const excludes = [ portInfo.debug ];
            const possiblePorts = dockerExpose.filter((port) => excludes.indexOf(port) === -1);
            if (possiblePorts.length === 1) {
                portInfo.app = possiblePorts[0];
            } else if (possiblePorts.length > 1) {
                const appPort = await vscode.window.showQuickPick(possiblePorts, { placeHolder: "Please select the app port exposed at Dockerfile" });
                if (/\$\{?(\w+)\}?/.test(appPort)) {
                    const varName = appPort.match(/\$\{?(\w+)\}?/)[1];
                    env[varName] = defaultJavaAppPort;
                    portInfo.app = defaultJavaAppPort;
                }
            }
        }

        return portInfo;
    }

    public async resolvePortsFromPod(kubectl: Kubectl, pod: string, container: string): Promise<PortInfo> {
        const portInfo: PortInfo = {
            debug: null,
            app: null
        };
        
        const execCmd = `exec ${pod} ${container ? "-c ${selectedContainer}" : ""} -- ps -ef`;
        const execResult = await kubectl.invokeAsync(execCmd);
        if (execResult.code === 0) {
            /**
             * UID        PID  PPID  C STIME TTY          TIME CMD
             * root         1     0  0 05:49 ?        00:00:00 node --inspect=9229 index.js
             * root        17     0  0 06:44 pts/0    00:00:00 bash
             * root        26    17  0 06:46 pts/0    00:00:00 ps -ef
             */
            const ps = execResult.stdout.split("\n");
            const totalCol = ps[0].trim().split(/\s+/).length;
            for (let i = 1; i < ps.length; i++) {
                const cols = ps[i].trim().split(/\s+/);
                if (cols.length < totalCol) {
                    continue;
                }
                const cmd = cols.slice(totalCol - 1, cols.length).join(" ");
                const matches = cmd.match(fullJavaDebugOptsRegExp);
                if (matches && matches.length === 3) {
                    const addresses = matches[2].split("=")[1].split(":");
                    portInfo.debug = addresses[addresses.length - 1];
                    break;
                }
            }
        }

        if (!portInfo.debug) {
            const input = await vscode.window.showInputBox({
                prompt: `Please specify debug port exposed by the container (e.g. 5005)`,
                placeHolder: defaultJavaDebugPort
            });
            portInfo.debug = (input ? input.trim() : null);
        }

        return portInfo;
    }
}
