<h1><center>Code Functions</center></h1>

<center>将 Keil IDE 的"函数标签页"体验带到 VS Code 中。</center>
<center>在侧边栏展示工作区所有函数列表，双击即可跳转到定义处。</center>

![Version](https://img.shields.io/badge/version-0.0.1-blue)
![VS Code](https://img.shields.io/badge/vscode-%5E1.120.0-brightgreen)
![AI](https://img.shields.io/badge/built%20with-DeepSeek%20V4%20Pro-6f42c1)

> 🧠 本插件由 **DeepSeek V4 Pro** 辅助构建，以 **Vibe Coding** 方式完成全部代码编写。
> 详见 [`Vibe-coding_instructions.md`](./Vibe-coding_instructions.md)，可指导任意 AI 编码助手复现工程。

---

## 功能特性

### 🎯 核心功能
- **全局函数扫描** — 遍历工作区所有源码文件，提取函数/方法定义
- **侧边栏列表** — 以树形结构展示在独立视图 `Functions` 中
- **双击跳转** — 点击任意函数，编辑器自动打开文件并定位到定义行
- **实时搜索** — 视图标题栏搜索按钮（或 `Ctrl+F`），输入关键字即时过滤

### 🧠 多语言支持

通过 `settings.json` 配置不同语言的解析规则。内置 6 种语言 profile：

| 语言 | 展示模式 | 说明 |
|------|---------|------|
| C | 平铺 (flat) | 正则匹配函数定义 |
| C++ | 平铺 (flat) | 正则匹配函数定义 |
| Java | 结构化 (structured) | 类 → 方法层级树 |
| Python | 平铺 (flat) | 正则匹配 `def` 定义 |
| JavaScript | 平铺 (flat) | 正则匹配函数/箭头函数 |
| TypeScript | 平铺 (flat) | 同 JavaScript |

### 🔌 语言服务器集成

- **优先使用语言服务器** — 调用 `vscode.executeDocumentSymbolProvider` 获取由语言插件（如红帽 Java、Pylance）提供的精确符号信息
- **正则 Fallback** — 当语言服务器不可用时自动回退到正则匹配
- **Java 扩展推荐** — 检测到 Java 文件时，提示安装 "Language Support for Java(TM) by Red Hat"

### 🛠 辅助功能
- 手动刷新按钮
- 文件保存自动刷新
- 可配置排除目录（默认忽略 `node_modules`、`.git` 等）
- 树节点默认折叠，按需展开

---

## 安装

### 从源码构建

```bash
git clone <repo-url>
cd code-functions
npm install
npm run compile
```

然后按 `F5` 启动扩展开发调试。

### 从 VSIX 安装

```bash
npm install -g @vscode/vsce
vsce package
code --install-extension code-functions-0.0.1.vsix
```

---

## 配置

所有配置项均位于 `settings.json` 的 `functionList.*` 命名空间下。

### `functionList.profiles`

定义各语言的解析规则。每个 profile 包含：

```jsonc
{
  "functionList.profiles": {
    "java": {
      "viewMode": "structured",        // "flat" 或 "structured"
      "classPattern": "...",           // 类匹配正则（structured 模式）
      "methodPattern": "...",          // 方法匹配正则（structured 模式）
      "fileExtensions": [".java"]      // 关联的文件扩展名
    },
    "c": {
      "viewMode": "flat",
      "functionPattern": "...",        // 函数匹配正则（flat 模式）
      "fileExtensions": [".c", ".h"]
    }
  }
}
```

### `functionList.exclude`

排除目录/文件的 glob 模式数组。

- **类型**: `string[]`
- **默认值**: `["**/node_modules/**", "**/.git/**", "**/dist/**", "**/out/**", "**/build/**", "**/.vscode/**"]`

### `functionList.enableAutoRefresh`

文件保存后自动刷新函数列表。

- **类型**: `boolean`
- **默认值**: `true`

### `functionList.useLanguageServer`

是否使用语言服务器（LSP）获取函数符号。关闭后仅使用正则匹配。

- **类型**: `boolean`
- **默认值**: `true`

### `functionList.enableRegexFallback`

当 `useLanguageServer` 开启但语言服务器无结果时，是否回退到正则匹配。

- **类型**: `boolean`
- **默认值**: `true`

### `functionList.suggestJavaExtension`

检测到 Java 文件但无语言服务器时，是否推荐安装红帽 Java 扩展。

- **类型**: `boolean`
- **默认值**: `true`

---

## 架构

```
src/
├── extension.ts               # 入口：注册 TreeView、命令、事件监听
├── scanner.ts                 # 核心：工作区函数扫描引擎（LSP + 正则）
├── functionTreeProvider.ts    # 视图：TreeDataProvider 树形展示
```

### 扫描策略

```
scanFile(fileUri)
  ├── useLanguageServer = true
  │   └── vscode.executeDocumentSymbolProvider(uri)
  │       ├── 有结果 → 使用 LSP 符号（精确）
  │       └── 无结果 → 检查 enableRegexFallback
  │           ├── true → 正则匹配
  │           └── false → 返回空
  └── useLanguageServer = false
      └── 正则匹配
```

---

## 开发

```bash
# 安装依赖
npm install

# 编译（开发模式，带 watch）
npm run watch

# 编译（生产模式）
npm run package

# 运行测试
npm test

# 代码检查
npm run lint
```

---

## 许可证

本插件采用 MIT 许可证。

---

## 🧠 Vibe Coding 复现

本插件完全通过 **Vibe Coding** 方式开发，AI 模型为 **DeepSeek V4 Pro**。

若希望用 AI 编码助手复现或改进此插件，请使用 [`Vibe-coding_instructions.md`](./Vibe-coding_instructions.md) 作为 Prompt：
- 包含完整的架构设计、数据流、分步实现指南
- 记录了 4 个关键坑点及解决方案
- 按 6 步清单即可指导 AI 重建工程


