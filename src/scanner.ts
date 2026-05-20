import * as vscode from 'vscode';
import * as path from 'path';

/**
 * 表示一个扫描到的函数/方法定义
 */
export interface FunctionDef {
    /** 函数名 */
    name: string;
    /** 所在文件路径 */
    filePath: string;
    /** 定义所在行号（1-based） */
    line: number;
    /** 简易签名（原始匹配行） */
    signature: string;
    /** 所属类名（structured 模式） */
    className?: string;
}

/**
 * 语言配置 Profile
 */
export interface LanguageProfile {
    viewMode: 'flat' | 'structured';
    functionPattern?: string;
    classPattern?: string;
    methodPattern?: string;
    fileExtensions: string[];
}

/**
 * 扫描结果：flat 模式的函数列表，或 structured 模式的分类结果
 */
export interface ScanResult {
    flat: FunctionDef[];
    structured: Map<string, Map<string, FunctionDef[]>>; // filePath -> className -> methods
}

/**
 * 根据文件扩展名匹配 profile
 */
function matchProfile(filePath: string): { profile: LanguageProfile; languageId: string } | undefined {
    const config = vscode.workspace.getConfiguration('functionList');
    const profiles = config.get<Record<string, LanguageProfile>>('profiles', {});
    const ext = path.extname(filePath).toLowerCase();

    for (const [langId, profile] of Object.entries(profiles)) {
        if (profile.fileExtensions && profile.fileExtensions.includes(ext)) {
            return { profile, languageId: langId };
        }
    }
    return undefined;
}

/**
 * 使用正则表达式扫描单个文件中的函数定义
 */
function scanFileWithPattern(
    content: string,
    pattern: string,
    filePath: string
): FunctionDef[] {
    const results: FunctionDef[] = [];
    const regex = new RegExp(pattern, 'gm');
    const lines = content.split('\n');

    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
        // 获取函数名（正则的第一个捕获组）
        const funcName = match[1];
        if (!funcName) {
            continue;
        }

        // 计算行号
        const pos = match.index;
        const beforeMatch = content.substring(0, pos);
        const line = beforeMatch.split('\n').length;

        // 提取签名（该行内容，去除首尾空白）
        const lineContent = lines[line - 1]?.trim() || match[0].trim();

        results.push({
            name: funcName,
            filePath,
            line,
            signature: lineContent
        });
    }

    return results;
}

/**
 * 扫描 structured 模式的文件（如 Java），提取类和方法
 */
function scanStructuredFile(
    content: string,
    profile: LanguageProfile,
    filePath: string
): FunctionDef[] {
    const results: FunctionDef[] = [];
    const lines = content.split('\n');

    if (!profile.classPattern || !profile.methodPattern) {
        return results;
    }

    // 先找到所有类定义
    const classRegex = new RegExp(profile.classPattern, 'gm');
    const classRanges: { name: string; startLine: number; endLine: number }[] = [];
    let classMatch: RegExpExecArray | null;

    while ((classMatch = classRegex.exec(content)) !== null) {
        const className = classMatch[1];
        if (!className) {
            continue;
        }
        const startLine = content.substring(0, classMatch.index).split('\n').length;
        classRanges.push({ name: className, startLine, endLine: Infinity });
    }

    // 设置每个 class 的结束行
    for (let i = 0; i < classRanges.length; i++) {
        if (i < classRanges.length - 1) {
            classRanges[i].endLine = classRanges[i + 1].startLine - 1;
        } else {
            classRanges[i].endLine = lines.length;
        }
    }

    // 扫描所有方法
    const methodRegex = new RegExp(profile.methodPattern, 'gm');
    let methodMatch: RegExpExecArray | null;

    while ((methodMatch = methodRegex.exec(content)) !== null) {
        const methodName = methodMatch[1];
        if (!methodName) {
            continue;
        }

        const pos = methodMatch.index;
        const line = content.substring(0, pos).split('\n').length;

        // 确定该方法属于哪个类
        let className = '';
        for (const cr of classRanges) {
            if (line >= cr.startLine && line <= cr.endLine) {
                className = cr.name;
                break;
            }
        }

        const lineContent = lines[line - 1]?.trim() || methodMatch[0].trim();

        results.push({
            name: methodName,
            filePath,
            line,
            signature: lineContent,
            className: className || undefined
        });
    }

    return results;
}

/**
 * 使用 VS Code 语言服务器（DocumentSymbolProvider）扫描单个文件
 * 这可以读取第三方插件（如 "Language Support for Java"）提供的精确符号信息
 */
async function scanFileWithLanguageServer(
    fileUri: vscode.Uri
): Promise<FunctionDef[]> {
    try {
        // 调用 VS Code 内置的 DocumentSymbolProvider 命令
        // 这会使用当前已安装的语言插件（Java、Python、TS 等）提供的符号解析
        const symbols = await vscode.commands.executeCommand<
            (vscode.DocumentSymbol | vscode.SymbolInformation)[]
        >('vscode.executeDocumentSymbolProvider', fileUri);

        if (!symbols || symbols.length === 0) {
            return [];
        }

        return convertSymbolsToFunctionDefs(symbols, fileUri.fsPath);
    } catch {
        // 语言服务器不可用时静默返回空，后续 fallback 到正则
        return [];
    }
}

/**
 * 将 VS Code 符号转换为 FunctionDef 列表
 * 支持 DocumentSymbol（层次结构）和 SymbolInformation（扁平结构）两种返回类型
 */
function convertSymbolsToFunctionDefs(
    symbols: (vscode.DocumentSymbol | vscode.SymbolInformation)[],
    filePath: string,
    parentClassName?: string
): FunctionDef[] {
    const results: FunctionDef[] = [];

    for (const sym of symbols) {
        // DocumentSymbol 有 children 属性
        if ('children' in sym && sym.children) {
            const ds = sym as vscode.DocumentSymbol;

            // 如果是类/接口/命名空间等容器，递归提取其子符号
            if (
                ds.kind === vscode.SymbolKind.Class ||
                ds.kind === vscode.SymbolKind.Interface ||
                ds.kind === vscode.SymbolKind.Struct ||
                ds.kind === vscode.SymbolKind.Namespace ||
                ds.kind === vscode.SymbolKind.Module ||
                ds.kind === vscode.SymbolKind.Enum
            ) {
                // 递归处理类内部的成员
                const childFuncs = convertSymbolsToFunctionDefs(
                    ds.children as vscode.DocumentSymbol[],
                    filePath,
                    ds.name
                );
                results.push(...childFuncs);
            }

            // 如果是函数/方法，直接添加
            if (
                ds.kind === vscode.SymbolKind.Function ||
                ds.kind === vscode.SymbolKind.Method ||
                ds.kind === vscode.SymbolKind.Constructor
            ) {
                const line = ds.range.start.line + 1; // 转为 1-based
                const signature = ds.detail || ds.name;
                results.push({
                    name: ds.name,
                    filePath,
                    line,
                    signature,
                    className: parentClassName
                });
            }

            // 仍然递归处理子符号（有些语言服务器会把函数嵌套返回）
            if (
                ds.kind !== vscode.SymbolKind.Class &&
                ds.kind !== vscode.SymbolKind.Interface &&
                ds.kind !== vscode.SymbolKind.Struct &&
                ds.kind !== vscode.SymbolKind.Namespace &&
                ds.kind !== vscode.SymbolKind.Module &&
                ds.kind !== vscode.SymbolKind.Enum
            ) {
                const childFuncs = convertSymbolsToFunctionDefs(
                    ds.children as vscode.DocumentSymbol[],
                    filePath,
                    parentClassName
                );
                results.push(...childFuncs);
            }
        } else {
            // SymbolInformation（扁平结构）
            const si = sym as vscode.SymbolInformation;
            if (
                si.kind === vscode.SymbolKind.Function ||
                si.kind === vscode.SymbolKind.Method ||
                si.kind === vscode.SymbolKind.Constructor
            ) {
                const line = si.location.range.start.line + 1;
                results.push({
                    name: si.name,
                    filePath,
                    line,
                    signature: si.name,
                    className: si.containerName || parentClassName
                });
            }
        }
    }

    return results;
}

/**
 * 扫描单个文件
 * 策略：根据配置决定使用语言服务器和/或正则匹配
 */
async function scanFile(
    fileUri: vscode.Uri
): Promise<FunctionDef[]> {
    const filePath = fileUri.fsPath;
    const config = vscode.workspace.getConfiguration('functionList');
    const useLanguageServer = config.get<boolean>('useLanguageServer', true);
    const enableRegexFallback = config.get<boolean>('enableRegexFallback', true);

    // 策略1：使用语言服务器（精确解析，支持 Java/TS/Python 等所有有 LSP 的语言）
    if (useLanguageServer) {
        const lsResults = await scanFileWithLanguageServer(fileUri);
        if (lsResults.length > 0) {
            return lsResults;
        }
        // 语言服务器无结果
        if (!enableRegexFallback) {
            return []; // 不 fallback，仅依赖语言服务器
        }
        // fallback 到正则继续
    }

    // 策略2：正则匹配（作为 fallback 或主策略）
    const matched = matchProfile(filePath);
    if (!matched) {
        return [];
    }

    const { profile } = matched;

    try {
        const rawContent = await vscode.workspace.fs.readFile(fileUri);
        const content = Buffer.from(rawContent).toString('utf-8');

        if (profile.viewMode === 'structured') {
            return scanStructuredFile(content, profile, filePath);
        } else if (profile.functionPattern) {
            return scanFileWithPattern(content, profile.functionPattern, filePath);
        }
    } catch (err) {
        console.error(`Error scanning file ${filePath}:`, err);
    }

    return [];
}

/**
 * 扫描工作区所有文件
 */
export async function scanWorkspace(): Promise<ScanResult> {
    const config = vscode.workspace.getConfiguration('functionList');
    const excludePatterns = config.get<string[]>('exclude', [
        '**/node_modules/**',
        '**/.git/**',
        '**/dist/**',
        '**/out/**',
        '**/build/**'
    ]);

    const profiles = config.get<Record<string, LanguageProfile>>('profiles', {});

    // 收集所有需要扫描的扩展名
    const allExtensions: string[] = [];
    for (const profile of Object.values(profiles)) {
        if (profile.fileExtensions) {
            allExtensions.push(...profile.fileExtensions);
        }
    }

    if (allExtensions.length === 0) {
        return { flat: [], structured: new Map() };
    }

    // 构建 include glob pattern：匹配所有配置的扩展名
    const includePattern = `**/*{${allExtensions.join(',')}}`;

    // 构建 exclude glob pattern：仅当有排除项时才构建
    const excludePattern = excludePatterns.length > 0
        ? `{${excludePatterns.join(',')}}`
        : undefined;

    // 使用 vscode.workspace.findFiles 获取文件列表
    const files = await vscode.workspace.findFiles(
        includePattern,
        excludePattern,
        5000
    );

    const allFunctions: FunctionDef[] = [];
    const structured: Map<string, Map<string, FunctionDef[]>> = new Map();

    // 并行扫描，但限制并发数避免 I/O 压力
    const concurrency = 8;
    for (let i = 0; i < files.length; i += concurrency) {
        const batch = files.slice(i, i + concurrency);
        const batchResults = await Promise.all(batch.map(scanFile));
        for (const funcs of batchResults) {
            allFunctions.push(...funcs);
        }
    }

    // 构建结构化数据
    for (const func of allFunctions) {
        if (!structured.has(func.filePath)) {
            structured.set(func.filePath, new Map());
        }
        const fileMap = structured.get(func.filePath)!;
        const className = func.className || '(global)';
        if (!fileMap.has(className)) {
            fileMap.set(className, []);
        }
        fileMap.get(className)!.push(func);
    }

    // 对每个分类内的函数排序
    for (const [, classMap] of structured) {
        for (const [, funcs] of classMap) {
            funcs.sort((a, b) => a.name.localeCompare(b.name));
        }
    }

    // flat 列表排序：先按文件名，再按函数名
    allFunctions.sort((a, b) => {
        const fileCmp = path.basename(a.filePath).localeCompare(path.basename(b.filePath));
        if (fileCmp !== 0) {
            return fileCmp;
        }
        return a.name.localeCompare(b.name);
    });

    return { flat: allFunctions, structured };
}
