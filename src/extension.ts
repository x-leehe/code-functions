import * as vscode from 'vscode';
import { FunctionTreeProvider } from './functionTreeProvider';
import { FunctionDef } from './scanner';

/** 红帽 Java 语言支持扩展 ID */
const REDHAT_JAVA_EXTENSION_ID = 'redhat.java';

/** 建议弹窗只显示一次 */
let javaSuggestionShown = false;

/** QuickPick 选项：包装 FunctionDef 以符合 QuickPickItem 接口 */
interface FunctionQuickPickItem extends vscode.QuickPickItem {
    functionDef: FunctionDef;
}

export function activate(context: vscode.ExtensionContext) {
    console.log('Code Functions extension activated');

    // 创建 TreeDataProvider 实例
    const functionTreeProvider = new FunctionTreeProvider();

    // 注册 TreeView
    const treeView = vscode.window.createTreeView('functionList', {
        treeDataProvider: functionTreeProvider,
        showCollapseAll: true,
        canSelectMany: false
    });

    // ---- 搜索命令：QuickPick 实时搜索过滤 ----
    const searchCommand = vscode.commands.registerCommand('code-functions.searchFunction', async () => {
        const allFunctions = functionTreeProvider.getAllFunctions();
        if (allFunctions.length === 0) {
            vscode.window.showInformationMessage('没有扫描到函数，请先刷新列表。');
            return;
        }

        // 将 FunctionDef 转换为 QuickPickItem
        const toItem = (f: FunctionDef): FunctionQuickPickItem => ({
            label: f.className ? `${f.className}.${f.name}` : f.name,
            description: `$(file-code) ${vscode.workspace.asRelativePath(f.filePath)}:${f.line}`,
            detail: f.signature,
            functionDef: f
        });

        const allItems = allFunctions.map(toItem);

        // 用 QuickPick 实现实时搜索
        const quickPick = vscode.window.createQuickPick<FunctionQuickPickItem>();
        quickPick.title = '搜索函数';
        quickPick.placeholder = '输入关键字过滤函数名...';
        quickPick.matchOnDescription = true;
        quickPick.matchOnDetail = true;
        quickPick.canSelectMany = false;

        // 实时过滤
        quickPick.onDidChangeValue((value) => {
            if (!value) {
                quickPick.items = allItems.slice(0, 50);
                return;
            }
            const lower = value.toLowerCase();
            const filtered = allItems.filter(item =>
                item.label.toLowerCase().includes(lower) ||
                (item.description && item.description.toLowerCase().includes(lower)) ||
                (item.detail && item.detail.toLowerCase().includes(lower))
            );
            quickPick.items = filtered.slice(0, 100);
        });

        // 初始仅显示前 50 个
        quickPick.items = allItems.slice(0, 50);

        quickPick.onDidAccept(() => {
            const selected = quickPick.selectedItems[0];
            if (selected) {
                quickPick.hide();
                jumpToFunction(selected.functionDef);
            }
        });

        quickPick.onDidHide(() => quickPick.dispose());
        quickPick.show();
    });

    // ---- 刷新命令 ----
    const refreshCommand = vscode.commands.registerCommand('code-functions.refresh', async () => {
        vscode.window.showInformationMessage('正在扫描工程函数列表...');
        await functionTreeProvider.refresh();
        vscode.window.showInformationMessage('函数列表刷新完成');

        // 检查是否需要建议安装 Java 扩展
        await suggestJavaExtension(functionTreeProvider);
    });

    // ---- 跳转命令 ----
    const jumpCommand = vscode.commands.registerCommand(
        'code-functions.jumpToFunction',
        async (functionDef: FunctionDef) => {
            await jumpToFunction(functionDef);
        }
    );

    // ---- 文件保存自动刷新 ----
    const config = vscode.workspace.getConfiguration('functionList');
    const enableAutoRefresh = config.get<boolean>('enableAutoRefresh', true);

    let saveListener: vscode.Disposable | undefined;
    if (enableAutoRefresh) {
        saveListener = vscode.workspace.onDidSaveTextDocument(async (document) => {
            await functionTreeProvider.refreshFile(document.fileName);
        });
    }

    // ---- 配置变更监听 ----
    const configListener = vscode.workspace.onDidChangeConfiguration(async (e) => {
        if (e.affectsConfiguration('functionList')) {
            await functionTreeProvider.refresh();
        }
    });

    // ---- 首次激活时自动扫描 ----
    functionTreeProvider.refresh().then(() => {
        suggestJavaExtension(functionTreeProvider);
    });

    // ---- 注册所有 disposable ----
    context.subscriptions.push(treeView);
    context.subscriptions.push(searchCommand);
    context.subscriptions.push(refreshCommand);
    context.subscriptions.push(jumpCommand);
    context.subscriptions.push(configListener);
    if (saveListener) {
        context.subscriptions.push(saveListener);
    }
}

/**
 * 跳转到函数定义
 */
async function jumpToFunction(functionDef: FunctionDef): Promise<void> {
    if (!functionDef) {
        return;
    }

    const uri = vscode.Uri.file(functionDef.filePath);

    try {
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document, {
            viewColumn: vscode.ViewColumn.Active,
            preserveFocus: false,
            selection: new vscode.Range(
                functionDef.line - 1, 0,
                functionDef.line - 1, 0
            )
        });

        const position = new vscode.Position(functionDef.line - 1, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(
            new vscode.Range(position, position),
            vscode.TextEditorRevealType.InCenter
        );
    } catch (err) {
        vscode.window.showErrorMessage(`无法打开文件: ${functionDef.filePath}`);
        console.error('Jump to function error:', err);
    }
}

/**
 * 检测 Java 文件并建议安装红帽 Java 扩展
 */
async function suggestJavaExtension(provider: FunctionTreeProvider): Promise<void> {
    if (javaSuggestionShown) {
        return;
    }

    const config = vscode.workspace.getConfiguration('functionList');
    const suggestJava = config.get<boolean>('suggestJavaExtension', true);
    if (!suggestJava) {
        return;
    }

    // 检查红帽 Java 扩展是否已安装
    const javaExt = vscode.extensions.getExtension(REDHAT_JAVA_EXTENSION_ID);
    if (javaExt) {
        return; // 已安装
    }

    // 检查工作区是否有 Java 文件
    const allFunctions = provider.getAllFunctions();
    if (allFunctions.length === 0) {
        return;
    }

    const hasJavaFiles = allFunctions.some(f =>
        f.filePath.endsWith('.java')
    );

    if (!hasJavaFiles) {
        return;
    }

    javaSuggestionShown = true;

    const choice = await vscode.window.showInformationMessage(
        '检测到 Java 文件。推荐安装 "Language Support for Java(TM) by Red Hat" 以获得精确的函数/类解析（支持类层次结构、方法签名等）。',
        '安装扩展',
        '不再提示'
    );

    if (choice === '安装扩展') {
        await vscode.commands.executeCommand(
            'workbench.extensions.installExtension',
            REDHAT_JAVA_EXTENSION_ID
        );
    } else if (choice === '不再提示') {
        // 在 settings.json 中禁用建议
        await config.update('suggestJavaExtension', false, vscode.ConfigurationTarget.Global);
    }
}

export function deactivate() {
    console.log('Code Functions extension deactivated');
}
