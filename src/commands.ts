import * as vscode from 'vscode';
import * as fs from 'fs';
import { createConnectTransport } from '@bufbuild/connect-node'
import { getRemoteAuthority } from './authResolver';
import SSHConfiguration, { getSSHConfigPath } from './ssh/sshConfig';
import { exists as fileExists } from './common/files';
import SSHDestination from './ssh/sshDestination';
import { Interceptor, createPromiseClient } from '@bufbuild/connect';
import { AiService } from './proto/aiserver/v1/aiserver_connectweb';
import { SshConfigPromptProps } from './proto/aiserver/v1/aiserver_pb';
import { GHOST_MODE_HEADER_NAME, enhancedObfuscate, ghostModeHeaderValue } from './gen/reactiveStorageTypes';
import { randomUUID } from 'crypto';

export async function promptOpenRemoteSSHWindow(reuseWindow: boolean, context: vscode.ExtensionContext) {

    const quickPick = vscode.window.createQuickPick();


    const hostsItems: {
        current: vscode.QuickPickItem[]
    } = {
        current: []
    };

    const typingItem: {
        current: vscode.QuickPickItem | undefined
    } = {
        current: undefined
    };

    const alwaysItems: vscode.QuickPickItem[] = [
        {
            label: "$(add) Add New SSH Host...",
            alwaysShow: true,
        },
        {
            label: "Configure SSH Hosts...",
            alwaysShow: true,
        },
    ];

    const updateItems = () => {
        quickPick.items = [...hostsItems.current, ...alwaysItems, ...(typingItem.current ? [typingItem.current] : [])];
    };

    SSHConfiguration.loadFromFS().then(sshConfigFile => {
        const hosts = sshConfigFile.getAllConfiguredHosts();
        hostsItems.current = hosts.map(hostname => ({ label: hostname }));
        updateItems();
    });

    quickPick.placeholder = 'e.g. ubuntu@ec2-3-106-99.amazonaws.com, or named host below';
    quickPick.title = 'Select configured SSH host or enter user@host';
    updateItems();

    context.subscriptions.push(quickPick.onDidChangeValue((value) => {
        if (value.length > 0) {
            typingItem.current = { label: `➤ ${value}`, alwaysShow: true };
        } else {
            typingItem.current = undefined;
        }
        updateItems();
    }));

    quickPick.show();

    quickPick.onDidAccept(async () => {
        const selected = quickPick.selectedItems[0];
        if (!selected) {
            return;
        }

        if (selected.label === alwaysItems[0].label) {
            await addNewHost();
            quickPick.hide();
            return;
        }

        if (selected.label === alwaysItems[1].label) {
            await openSSHConfigFile();
            quickPick.hide();
            return;
        }

        if (typingItem.current?.label === selected.label) {
            const sshDest = new SSHDestination(typingItem.current.label.substr(2).trim());
            openRemoteSSHWindow(sshDest.toEncodedString(), reuseWindow);
        } else {
            const sshDest = new SSHDestination(selected.label);
            openRemoteSSHWindow(sshDest.toEncodedString(), reuseWindow);
        }
        quickPick.hide();

    });
}

export function openRemoteSSHWindow(host: string, reuseWindow: boolean) {
    vscode.commands.executeCommand('vscode.newWindow', { remoteAuthority: getRemoteAuthority(host), reuseWindow });
}

export function openRemoteSSHLocationWindow(host: string, path: string, reuseWindow: boolean) {
    vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.from({ scheme: 'vscode-remote', authority: getRemoteAuthority(host), path }), { forceNewWindow: !reuseWindow });
}

export async function addNewHost() {

    const sshString = await vscode.window.showInputBox({
        title: "Enter SSH Connection Command",
        placeHolder: 'e.g. ssh -i "secret-key.pem" ubuntu@ec2-3-87-25.amazonaws.com',
    });

    if (!sshString) {
        return;
    }

    const client = await createAiServerClient();

    const props = new SshConfigPromptProps({
        sshString,
    })

    const stream = client.streamPriomptPrompt({
        promptProps: JSON.stringify(props),
        promptPropsTypeName: SshConfigPromptProps.typeName,
        skipLoginCheck: true,
        modelDetails: {
            modelName: 'gpt-3.5-turbo'
        }
    })


    const sshConfigPath = getSSHConfigPath();
    if (!await fileExists(sshConfigPath)) {
        await fs.promises.appendFile(sshConfigPath, '');
    }

    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(sshConfigPath), { preview: false });

    const textEditor = vscode.window.activeTextEditor;
    if (textEditor?.document.uri.fsPath !== sshConfigPath) {
        return;
    }

    let position = new vscode.Position(0, 0);
    await textEditor.edit((editBuilder: vscode.TextEditorEdit) => {
        editBuilder.insert(position, '\n\n');
    });
    let total = "";
    for await (const response of stream) {
        const sshConfig = response.text;
        total += sshConfig;
        await textEditor.edit((editBuilder: vscode.TextEditorEdit) => {
            editBuilder.insert(position, sshConfig);
            position = position.translate(sshConfig.split('\n').length - 1, sshConfig.length);
        });
    }

    const sshConfigLines = total.split('\n');
    let hostName = '';
    for (let i = 0; i < sshConfigLines.length; i++) {
        if (sshConfigLines[i].startsWith('Host')) {
            hostName = sshConfigLines[i].slice(4).trim();
            break;
        }
    }

    await vscode.commands.executeCommand('workbench.action.files.save');

    const sshDest = new SSHDestination(hostName);
    const v = sshDest.toEncodedString();

    const connectButton = {
        title: `Connect`,
    };

    const c = await vscode.window.showInformationMessage('Host added!', connectButton);
    if (c) {
        openRemoteSSHWindow(v, false);
    }
}

export async function openSSHConfigFile() {
    const sshConfigPath = getSSHConfigPath();
    if (!await fileExists(sshConfigPath)) {
        await fs.promises.appendFile(sshConfigPath, '');
    }
    vscode.commands.executeCommand('vscode.open', vscode.Uri.file(sshConfigPath));
}


async function createAiServerClient() {
    const authToken = vscode.cursor.getCursorAuthToken();
    const backendUrl = vscode.cursor.getCursorCreds()?.backendUrl;
    if (!backendUrl) {
        throw new Error('No backend URL found');
    }

    const bearerTokenInterceptor: Interceptor = (next) => async (req) => {
        req.header.set("Authorization", `Bearer ${authToken}`);
        return await next(req);
    };
    const addHeaders: Interceptor = (next: any) => async (req: any) => {
        vscode.cursor.getAllRequestHeadersExceptAccessToken({ req: req, backupRequestId: randomUUID() })

        return await next(req);
    };

    const transport = createConnectTransport({
        httpVersion: "1.1",
        baseUrl: backendUrl,
        interceptors: [bearerTokenInterceptor, addHeaders],
        jsonOptions: {
            ignoreUnknownFields: true,
        }
    });

    return createPromiseClient(AiService, transport);
}
