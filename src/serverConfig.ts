import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

let vscodeProductJson: any;
async function getVSCodeProductJson() {
    if (!vscodeProductJson) {
        const productJsonStr = await fs.promises.readFile(path.join(vscode.env.appRoot, 'product.json'), 'utf8');
        vscodeProductJson = JSON.parse(productJsonStr);
        console.log('GOT PRODUCT JSON', vscodeProductJson)
    }
    console.log('GOT PRODUCT JSON', vscodeProductJson)

    return vscodeProductJson;
}
getVSCodeProductJson();
export interface IServerConfig {
    version: string;
    commit: string;
    quality: string;
    serverApplicationName: string;
    serverDataFolderName: string;
}

export async function getVSCodeServerConfig(): Promise<IServerConfig> {
    const productJson = await getVSCodeProductJson();

    return {
        commit: productJson.commit,
        version: productJson.version,
        quality: productJson.quality,
        serverApplicationName: productJson.serverApplicationName,
        serverDataFolderName: productJson.serverDataFolderName,
    };
}
