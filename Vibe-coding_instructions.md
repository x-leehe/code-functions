# Vibe Coding Instructions — Code Functions VS Code Extension

> 本文档记录 **Code Functions** VS Code 插件的完整开发过程，以便通过 Vibe Coding 方式复现。

---

## 1. 项目概述

**目标**：将 Keil IDE 的"函数标签页"体验移植到 VS Code——在侧边栏列出工作区所有函数，双击跳转到定义。

**技术栈**：TypeScript + VS Code Extension API + Webpack

---

## 2. 项目初始化

### 2.1 脚手架

```bash
npm install -g yo generator-code
yo code
# 选择: New Extension (TypeScript)
# 名称: code-functions
# 显示名: Code Functions
```

### 2.2 依赖安装

```bash
cd code-functions
npm install
```

核心依赖（`package.json` devDependencies）：

```json
{
  "@types/vscode": "^1.120.0",
  "@types/node": "^22.x",
  "typescript": "^5.9.3",
  "webpack": "^5.105.3",
  "webpack-cli": "^6.0.1",
  "ts-loader": "^9.5.4",
  "@types/mocha": "^10.0.10",
  "eslint": "^9.39.3"
}
```

### 2.3 tsconfig.json 关键配置

```json
{
  "compilerOptions": {
    "module": "Node16",
    "moduleResolution": "Node16",
    "target": "ES2022",
    "lib": ["ES2022"],
    "types": ["node", "vscode"],
    "rootDir": "src",
    "strict": true,
    "skipLibCheck": true
  },
  "exclude": ["src/test"]
}
```

> **坑点**：必须配置 `"types": ["node", "vscode"]`，否则 `Buffer`、`path`、`console` 等会报"找不到名称"。

---

## 3. 架构设计

### 3.1 文件结构

```
src/
├── extension.ts               # 入口：注册视图、命令、事件
├── scanner.ts                 # 扫描引擎：LSP + 正则双策略
├── functionTreeProvider.ts    # TreeDataProvider：树形展示
```

### 3.2 数据流

```
用户打开 VS Code
  → extension.ts activate()
    → functionTreeProvider.refresh()
      → scanner.scanWorkspace()
        → findFiles(include, exclude)
          → 对每个文件 scanFile()
            → useLanguageServer? → executeDocumentSymbolProvider()
            → enableRegexFallback? → 正则匹配
        → 聚合为 ScanResult { flat[], structured Map }
      → buildTree() 构建 FunctionTreeItem[]
    → TreeView 渲染
```

---

## 4. 分步实现

### 4.1 Step 1：package.json — 贡献点声明

**视图容器** + **视图**：
```json
{
  "contributes": {
    "viewsContainers": {
      "activitybar": [{
        "id": "functionList",
        "title": "Function List",
        "icon": "$(list-tree)"
      }]
    },
    "views": {
      "functionList": [{
        "id": "functionList",
        "name": "Functions",
        "icon": "$(symbol-function)",
        "enableFindWidget": true
      }]
    }
  }
}
```

**命令**：
| 命令 ID | 用途 |
|---------|------|
| `code-functions.refresh` | 手动刷新 |
| `code-functions.searchFunction` | 搜索函数（QuickPick） |
| `code-functions.jumpToFunction` | 跳转到定义 |

**菜单**（视图标题栏）：
```json
{
  "view/title": [
    { "command": "code-functions.searchFunction", "group": "navigation@1" },
    { "command": "code-functions.refresh", "group": "navigation@2" }
  ]
}
```

### 4.2 Step 2：scanner.ts — 扫描引擎

#### 数据结构

```typescript
interface FunctionDef {
    name: string;           // 函数名
    filePath: string;       // 文件绝对路径
    line: number;           // 定义行号（1-based）
    signature: string;      // 原始行文本
    className?: string;     // 所属类名（structured 模式）
}

interface LanguageProfile {
    viewMode: 'flat' | 'structured';
    functionPattern?: string;
    classPattern?: string;
    methodPattern?: string;
    fileExtensions: string[];
}

interface ScanResult {
    flat: FunctionDef[];
    structured: Map<string, Map<string, FunctionDef[]>>;
}
```

#### 扫描策略（核心）

`scanFile()` 决策树：

```
useLanguageServer == true
  → executeDocumentSymbolProvider(uri)
    → 有符号 → 转 FunctionDef[] 返回
    → 无符号
      → enableRegexFallback == true → 正则匹配
      → enableRegexFallback == false → 返回 []

useLanguageServer == false
  → 正则匹配
```

#### LSP 符号转换

`convertSymbolsToFunctionDefs()` 处理两种返回类型：

- **DocumentSymbol[]**：层次结构（有 children），递归类容器提取方法
- **SymbolInformation[]**：扁平结构（有 containerName），直接提取

> 用 `'children' in sym` 区分类型，而非 instanceof（跨模块边界不可靠）。

#### 正则匹配

```typescript
function scanFileWithPattern(content, pattern, filePath): FunctionDef[] {
    const regex = new RegExp(pattern, 'gm');
    // 遍历匹配，捕获组 [1] 为函数名
    // substring(0, match.index).split('\n').length 计算行号
}
```

structured 模式先扫描类定义确定范围，再归类方法。

#### 工作区扫描

```typescript
async function scanWorkspace(): Promise<ScanResult> {
    // 1. 读取 profiles，收集扩展名
    // 2. findFiles(includePattern, excludePattern, 5000)
    // 3. 分批并发 scanFile()（concurrency=8）
    // 4. 聚合到 flat[] + structured Map
    // 5. 排序
}
```

> **坑点**：excludePattern 空时传 undefined 而非 "{}"，否则 glob 异常。

### 4.3 Step 3：functionTreeProvider.ts — 树形视图

```typescript
class FunctionTreeItem extends vscode.TreeItem {
    nodeType: 'file' | 'class' | 'function';
    functionDef?: FunctionDef;
    children?: FunctionTreeItem[];
    // 函数节点：command 跳转 + tooltip 签名
    // 文件/类节点：图标
}

class FunctionTreeProvider implements vscode.TreeDataProvider<FunctionTreeItem> {
    getChildren(element?) // 根 → 文件列表；元素 → children
    getTreeItem(element)  // 返回自身
}
```

树构建：根据 viewMode 决定 flat（两层）或 structured（三层），默认 Collapsed。

### 4.4 Step 4：extension.ts — 入口集成

- 注册 TreeView、refresh/search/jump 命令
- QuickPick 实时搜索（需 FunctionQuickPickItem 包装）
- 文件保存自动刷新
- Java 扩展推荐（检测 .java + redhat.java 未安装）

---

## 5. 配置设计

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `functionList.profiles` | object | 6种语言 | 解析规则 |
| `functionList.exclude` | string[] | node_modules等 | 排除目录 |
| `functionList.enableAutoRefresh` | boolean | true | 保存时刷新 |
| `functionList.useLanguageServer` | boolean | true | LSP解析 |
| `functionList.enableRegexFallback` | boolean | true | 正则兜底 |
| `functionList.suggestJavaExtension` | boolean | true | Java推荐 |

---

## 6. 关键设计决策

- **TreeView vs WebviewView**：TreeView 原生、轻量、支持 enableFindWidget
- **LSP + 正则双策略**：兼顾精度和覆盖范围
- **默认折叠**：大型工程性能优化

---

## 7. 调试与常见问题

| 问题 | 原因 | 解决 |
|------|------|------|
| 找不到名称"Buffer"/"path" | tsconfig 未声明 node 类型 | `"types": ["node", "vscode"]` |
| QuickPick 类型错误 | FunctionDef 未实现 QuickPickItem | 包装为 FunctionQuickPickItem |
| 排除 pattern 失效 | 空数组构造 "{}" | 空时传 undefined |
| 测试文件被 webpack 编译 | tsconfig 未排除 test | `"exclude": ["src/test"]` |

---

## 8. Vibe Coding 复现清单

1. 创建 VS Code TypeScript 扩展脚手架，配置 webpack + tsconfig
2. package.json：viewsContainers、views、commands、menus、configuration
3. scanner.ts：FunctionDef/LanguageProfile/ScanResult 接口 + 双策略扫描
4. functionTreeProvider.ts：FunctionTreeItem + TreeDataProvider
5. extension.ts：注册视图/命令/事件/推荐
6. README.md：标准格式文档
