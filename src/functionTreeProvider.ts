import * as vscode from 'vscode';
import * as path from 'path';
import { FunctionDef, ScanResult, scanWorkspace, LanguageProfile } from './scanner';

/**
 * TreeItem 类型标识
 */
type TreeNodeType = 'file' | 'class' | 'function';

/**
 * 自定义 TreeItem，携带跳转所需信息
 */
class FunctionTreeItem extends vscode.TreeItem {
    /** 节点类型 */
    nodeType: TreeNodeType;
    /** 函数定义信息（仅 function 类型有效） */
    functionDef?: FunctionDef;
    /** 子节点（file/class 类型） */
    children?: FunctionTreeItem[];

    constructor(
        label: string,
        nodeType: TreeNodeType,
        collapsibleState: vscode.TreeItemCollapsibleState,
        functionDef?: FunctionDef
    ) {
        super(label, collapsibleState);
        this.nodeType = nodeType;
        this.functionDef = functionDef;

        if (functionDef) {
            // 函数节点：配置跳转
            this.command = {
                command: 'code-functions.jumpToFunction',
                title: 'Jump to Function',
                arguments: [functionDef]
            };
            this.iconPath = new vscode.ThemeIcon('symbol-function');
            // tooltip 显示文件路径和签名
            const fileName = path.basename(functionDef.filePath);
            this.tooltip = `${fileName}:${functionDef.line}\n${functionDef.signature}`;
            this.description = `:${functionDef.line}`;
        } else if (nodeType === 'class') {
            this.iconPath = new vscode.ThemeIcon('symbol-class');
            this.tooltip = label;
        } else if (nodeType === 'file') {
            this.iconPath = new vscode.ThemeIcon('file-code');
            this.tooltip = label;
        }
    }
}

/**
 * 根据文件扩展名确定该文件所属 profile 的 viewMode
 */
function getViewModeForFile(filePath: string): 'flat' | 'structured' {
    const config = vscode.workspace.getConfiguration('functionList');
    const profiles = config.get<Record<string, LanguageProfile>>('profiles', {});
    const ext = path.extname(filePath).toLowerCase();

    for (const profile of Object.values(profiles)) {
        if (profile.fileExtensions && profile.fileExtensions.includes(ext)) {
            return profile.viewMode || 'flat';
        }
    }
    return 'flat';
}

/**
 * Function List TreeDataProvider
 */
export class FunctionTreeProvider implements vscode.TreeDataProvider<FunctionTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<FunctionTreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    /** 树节点缓存 */
    private treeItems: FunctionTreeItem[] = [];
    /** 当前扫描结果 */
    private scanResult: ScanResult | null = null;

    constructor() {
        // 初始化为空
    }

    /**
     * 刷新整个树
     */
    async refresh(): Promise<void> {
        this.scanResult = await scanWorkspace();
        this.treeItems = this.buildTree(this.scanResult);
        this._onDidChangeTreeData.fire();
    }

    /**
     * 获取当前扫描结果（供搜索和外部检测使用）
     */
    getScanResult(): ScanResult | null {
        return this.scanResult;
    }

    /**
     * 获取所有函数的平铺列表
     */
    getAllFunctions(): FunctionDef[] {
        return this.scanResult?.flat ?? [];
    }

    /**
     * 刷新单个文件（用于文件保存时增量更新）
     */
    async refreshFile(filePath: string): Promise<void> {
        if (!this.scanResult) {
            await this.refresh();
            return;
        }
        // 简化实现：全量刷新
        // 增量更新较复杂，全量刷新在合理文件数量下性能足够
        await this.refresh();
    }

    /**
     * 构建统一的树，根据每个文件的 profile 决定 flat 或 structured 展示
     */
    private buildTree(result: ScanResult): FunctionTreeItem[] {
        // 使用 structured map 来按文件组织，同时保留 viewMode 信息
        const items: FunctionTreeItem[] = [];

        // 从 structured map 构建（它已经按 filePath -> className -> methods 组织）
        const sortedFiles = [...result.structured.entries()].sort((a, b) =>
            path.basename(a[0]).localeCompare(path.basename(b[0]))
        );

        for (const [filePath, classMap] of sortedFiles) {
            const fileName = path.basename(filePath);
            const viewMode = getViewModeForFile(filePath);

            const fileItem = new FunctionTreeItem(
                fileName,
                'file',
                vscode.TreeItemCollapsibleState.Collapsed
            );
            fileItem.tooltip = filePath;

            if (viewMode === 'structured') {
                // 结构化模式：文件 -> 类 -> 方法
                const sortedClasses = [...classMap.entries()].sort((a, b) =>
                    a[0].localeCompare(b[0])
                );

                fileItem.children = [];
                for (const [className, methods] of sortedClasses) {
                    const classItem = new FunctionTreeItem(
                        className === '(global)' ? `(global in ${fileName})` : className,
                        'class',
                        vscode.TreeItemCollapsibleState.Collapsed
                    );

                    classItem.children = methods.map(m => {
                        const label = className === '(global)' ? m.name : `${className}.${m.name}`;
                        return new FunctionTreeItem(
                            label,
                            'function',
                            vscode.TreeItemCollapsibleState.None,
                            m
                        );
                    });

                    fileItem.children.push(classItem);
                }
            } else {
                // 平铺模式：文件 -> 直接列出函数
                const allFuncs: FunctionDef[] = [];
                for (const methods of classMap.values()) {
                    allFuncs.push(...methods);
                }
                allFuncs.sort((a, b) => a.name.localeCompare(b.name));

                fileItem.children = allFuncs.map(f => {
                    const label = f.className ? `${f.className}.${f.name}` : f.name;
                    return new FunctionTreeItem(
                        label,
                        'function',
                        vscode.TreeItemCollapsibleState.None,
                        f
                    );
                });
            }

            items.push(fileItem);
        }

        return items;
    }

    /**
     * TreeDataProvider: 获取子节点
     */
    getChildren(element?: FunctionTreeItem): vscode.ProviderResult<FunctionTreeItem[]> {
        if (!element) {
            // 根节点：返回所有顶层节点
            return this.treeItems;
        }

        // 返回 element 的子节点
        if (element.children) {
            return element.children;
        }

        return [];
    }

    /**
     * TreeDataProvider: 获取 TreeItem
     */
    getTreeItem(element: FunctionTreeItem): vscode.TreeItem {
        return element;
    }

    /**
     * 获取父节点
     */
    getParent(element: FunctionTreeItem): vscode.ProviderResult<FunctionTreeItem> {
        return undefined;
    }
}
