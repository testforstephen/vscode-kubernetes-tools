import * as vscode from 'vscode';
import * as shell from './shell';
import { Kubectl } from './kubectl';
import { Host } from './host';
import * as kuberesources from './kuberesources';
import { kubectl } from 'k8s';
import * as path from 'path';

export function create(kubectl : Kubectl, host : Host) : KubernetesExplorer {
    return new KubernetesExplorer(kubectl, host);
}

export interface ResourceNode {
    readonly id : string;
    readonly resourceId : string;
    readonly metadata?: any;
}

export class KubernetesExplorer implements vscode.TreeDataProvider<KubernetesObject> {
	private _onDidChangeTreeData: vscode.EventEmitter<KubernetesObject | undefined> = new vscode.EventEmitter<KubernetesObject | undefined>();
	readonly onDidChangeTreeData: vscode.Event<KubernetesObject | undefined> = this._onDidChangeTreeData.event;

    constructor(private readonly kubectl : Kubectl, private readonly host : Host) {}

    getTreeItem(element: KubernetesObject) : vscode.TreeItem | Thenable<vscode.TreeItem> {
        if (element instanceof VirtualKubernetesResource) {
            return element.getTreeItem();
        }
        const collapsibleState = isKind(element) ? vscode.TreeItemCollapsibleState.Collapsed: vscode.TreeItemCollapsibleState.None;
        const label = isKind(element) ? element.kind.pluralDisplayName : element.id;
        let treeItem = new vscode.TreeItem(label, collapsibleState);
        treeItem.iconPath = vscode.Uri.file(path.join(__dirname, "../../images/kubernetes.svg"));
        if (isResource(element)) {
            treeItem.command = {
                command: "extension.vsKubernetesLoad",
                title: "Load",
                arguments: [ element ]
            };
            treeItem.contextValue = "vsKubernetes.resource";
            if (element.resourceId.startsWith('pod')) {
                treeItem.contextValue = "vsKubernetes.resource.pod";
            } else if (element.resourceId.startsWith('service')) {
                treeItem.contextValue = "vsKubernetes.resource.service";
            }
        }
        return treeItem;
    }

    getChildren(parent? : KubernetesObject) : vscode.ProviderResult<KubernetesObject[]> {
        if (parent instanceof VirtualKubernetesResource) {
            return parent.getChildren();
        } else if (parent) {
            return getChildren(parent, this.kubectl, this.host);
        }
        return getClusters(this.kubectl, this.host);
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

}

function getClusters(kubectl: Kubectl, host: Host) : Promise<KubernetesObject[]> {
    return new Promise((resolve, reject) => {
        kubectl.invoke("config view -o json", (code, stdout, stderr) => {
            if (code !== 0) {
                resolve([]);
            } else {
                const configJson = JSON.parse(stdout);
                const currentContext = configJson["current-context"];
                const contexts = configJson.contexts;
                resolve(contexts.map((c) => new VirtualKubernetesResource(c.context.cluster, 'cluster', {
                    context: c.name,
                    active: c.name === currentContext
                })));
            }
        });
    });
}

function isKind(obj: KubernetesObject) : obj is KubernetesKind {
    return !!(<KubernetesKind>obj).kind;
}

function isResource(obj: KubernetesObject) : obj is KubernetesResource {
    return !!(<KubernetesResource>obj).resourceId;
}

async function getChildren(parent : KubernetesObject, kubectl: Kubectl, host: Host) : Promise<KubernetesObject[]> {
    if (isKind(parent)) {
        const childrenLines = await kubectl.asLines("get " + parent.kind.abbreviation);
        if (shell.isShellResult(childrenLines)) {
            host.showErrorMessage(childrenLines.stderr);
            return [ { id: "Error" } ];
        }
        return childrenLines.map((l) => parse(parent.kind, l));
    }
    return [];
}

function parse(kind : kuberesources.ResourceKind, kubeLine : string) : KubernetesObject {
    const bits = kubeLine.split(' ');
    return new KubernetesResource(kind, bits[0]);
}

interface KubernetesObject {
    readonly id : string;
}

class VirtualKubernetesResource implements KubernetesObject, ResourceNode {
    readonly resourceId: string;

    constructor (readonly id : string, readonly kind : string, readonly metadata?: any) {
        this.resourceId = kind + "/" + id;
    }

    getChildren() : vscode.ProviderResult<KubernetesObject[]> {
        if (this.kind === 'cluster') {
            return [
                new KubernetesKind(kuberesources.allKinds.node),
                new VirtualKubernetesResource('Workloads', 'workload'),
                new KubernetesKind(kuberesources.allKinds.service)
            ];
        } else if (this.kind === 'workload') {
            return [
                new KubernetesKind(kuberesources.allKinds.deployment),
                new KubernetesKind(kuberesources.allKinds.job),
                new KubernetesKind(kuberesources.allKinds.pod)
            ];
        }
        return [];
    }

    getTreeItem() : vscode.TreeItem | Thenable<vscode.TreeItem> {
        const treeItem = new vscode.TreeItem(this.id, vscode.TreeItemCollapsibleState.Collapsed);
        treeItem.iconPath = vscode.Uri.file(path.join(__dirname, "../../images/kubernetes.svg"));
        treeItem.contextValue = null;
        if (this.kind === 'cluster' && !this.metadata.active) {
            treeItem.collapsibleState = vscode.TreeItemCollapsibleState.None;
            treeItem.contextValue = "vsKubernetes.resource.cluster";
        }
        return treeItem;
    }
}

class KubernetesKind implements KubernetesObject {
    readonly id: string;
    constructor(readonly kind: kuberesources.ResourceKind) {
        this.id = kind.abbreviation;
    }
}

class KubernetesResource implements KubernetesObject, ResourceNode {
    readonly resourceId: string;
    constructor(kind: kuberesources.ResourceKind, readonly id: string) {
        this.resourceId = kind.abbreviation + '/' + id;
    }
}