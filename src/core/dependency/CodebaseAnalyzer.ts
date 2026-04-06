import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { FlowchartIR, FlowchartNode, FlowchartEdge, NodeType, NodeCategory } from "../../ir/ir";
import { FileCategory, FileTypeClassifier } from "./FileTypeClassifier";

export interface CodebaseModule{
  source: string; // Absolute path to file
  relativePath: string; // Relative path from workspace root
  fileName: string; // Just the filename
  languageId: string;
  fileCategory: FileCategory; // File category for color coding
  dependencies: CodebaseDependency[]; // Files this module imports/requires
  dependents: string[]; // Files that import/require this module
  functions: string[]; // Functions defined in this file
  exports: string[]; // Exported functions/classes
}

export interface CodebaseDependency{
  module: string; // Import path as written in code
  resolved: string | null; // Resolved absolute path (null if not resolvable)
  dependencyTypes: string[]; // e.g., "import", "require", "dynamic"
  valid: boolean; // Whether the dependency could be resolved
}

export class CodebaseAnalyzer {
  private workspaceRoot: string;
  private modules: Map<string, CodebaseModule> = new Map();
  private supportedExtensions: Set<string> = new Set([
    ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
    ".py", ".java", ".cpp", ".c", ".h", ".hpp",
    ".rs", ".go", ".md"
  ]);

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  public async analyzeCodebase(
    selectedPaths?: string[]
  ): Promise<Map<string, CodebaseModule>> {
    this.modules.clear();

    // Get files to analyze
    const filesToAnalyze = selectedPaths 
      ? await this.getFilesFromPaths(selectedPaths)
      : await this.getAllSupportedFiles();

    // Analyze each file
    for (const filePath of filesToAnalyze) {
      try {
        const module = await this.analyzeFile(filePath);
        if (module) {
          this.modules.set(module.source, module);
        }
      } catch (error) {
        console.error(`Error analyzing ${filePath}:`, error);
      }
    }

    // Resolve dependencies and build dependency graph
    this.resolveDependencies();

    return this.modules;
  }

  private async getAllSupportedFiles(): Promise<string[]> {
    const files: string[] = [];

    const walkDir = async (dir: string): Promise<void> => {
      try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);

          // Skip node_modules, .git, dist, build, vendor, target, etc.
          if (
            entry.name.startsWith(".") ||
            entry.name === "node_modules" ||
            entry.name === "dist" ||
            entry.name === "build" ||
            entry.name === ".git" ||
            entry.name === "target" ||   // Rust build output
            entry.name === "vendor"       // Go vendored deps
          ) {
            continue;
          }

          if (entry.isDirectory()) {
            await walkDir(fullPath);
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name);
            if (this.supportedExtensions.has(ext)) {
              files.push(fullPath);
            }
          }
        }
      } catch (error) {
      }
    };

    await walkDir(this.workspaceRoot);
    return files;
  }

  private async getFilesFromPaths(selectedPaths: string[]): Promise<string[]> {
    const files: string[] = [];

    for (const selectedPath of selectedPaths) {
      const stat = await fs.promises.stat(selectedPath);
      
      if (stat.isFile()) {
        files.push(selectedPath);
      } else if (stat.isDirectory()) {
        const dirFiles = await this.getAllSupportedFiles();
        // Filter files that are within the selected directory
        const relativePath = path.relative(this.workspaceRoot, selectedPath);
        const filtered = dirFiles.filter(file => {
          const fileRelative = path.relative(selectedPath, file);
          return !fileRelative.startsWith("..") && !path.isAbsolute(fileRelative);
        });
        files.push(...filtered);
      }
    }

    return [...new Set(files)]; // Remove duplicates
  }

  private async analyzeFile(filePath: string): Promise<CodebaseModule | null> {
    try {
      const content = await fs.promises.readFile(filePath, "utf-8");
      const relativePath = path.relative(this.workspaceRoot, filePath);
      const fileName = path.basename(filePath);
      const ext = path.extname(filePath);
      const languageId = this.getLanguageId(ext);

      // Extract dependencies based on language
      const dependencies = this.extractDependencies(content, filePath, languageId);
      // Extract functions (simplified - could be enhanced)
      const functions = this.extractFunctions(content, languageId);
      // Extract exports
      const exports = this.extractExports(content, languageId);
      // Classify file category for color coding
      const fileCategory = FileTypeClassifier.classifyFile(relativePath, fileName);

      return {
        source: filePath,
        relativePath,
        fileName,
        languageId,
        fileCategory,
        dependencies,
        dependents: [], // Will be filled in resolveDependencies
        functions,
        exports,
      };
    } catch (error){
      console.error(`Error reading file ${filePath}:`, error);
      return null;
    }
  }

  private extractDependencies(
    content: string,
    filePath: string,
    languageId: string
  ): CodebaseDependency[] {
    const dependencies: CodebaseDependency[] = [];

    if (languageId === "typescript" || languageId === "javascript") {
      // Extract ES6 imports
      const importRegex = /import\s+(?:(?:\*\s+as\s+\w+)|(?:\{[^}]*\})|(?:\w+))\s+from\s+['"]([^'"]+)['"]/g;
      let match;
      while ((match = importRegex.exec(content)) !== null) {
        const modulePath = match[1];
        const resolved = this.resolveModulePath(modulePath, filePath);
        dependencies.push({
          module: modulePath,
          resolved,
          dependencyTypes: ["import"],
          valid: resolved !== null,
        });
      }

      // Extract require() calls
      const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
      while ((match = requireRegex.exec(content)) !== null) {
        const modulePath = match[1];
        const resolved = this.resolveModulePath(modulePath, filePath);
        dependencies.push({
          module: modulePath,
          resolved,
          dependencyTypes: ["require"],
          valid: resolved !== null,
        });
      }
    } else if (languageId === "python") {
      const importRegex = /(?:^|\n)\s*(?:import|from)\s+(\S+)/g;
      let match;
      while ((match = importRegex.exec(content)) !== null) {
        const modulePath = match[1].split(" ")[0].split(".")[0];
        const resolved = this.resolvePythonModule(modulePath, filePath);
        dependencies.push({
          module: modulePath,
          resolved,
          dependencyTypes: ["import"],
          valid: resolved !== null,
        });
      }
    } else if (languageId === "java") {
      // Extract: import com.example.ClassName;
      const importRegex = /^\s*import\s+([\w.]+)\s*;/gm;
      let match;
      while ((match = importRegex.exec(content)) !== null) {
        const importPath = match[1];
        // Skip standard library packages
        if (
          importPath.startsWith("java.") ||
          importPath.startsWith("javax.") ||
          importPath.startsWith("android.") ||
          importPath.startsWith("kotlin.")
        ) {
          continue;
        }
        const resolved = this.resolveJavaImport(importPath, filePath);
        dependencies.push({
          module: importPath,
          resolved,
          dependencyTypes: ["import"],
          valid: resolved !== null,
        });
      }
    } else if (languageId === "c" || languageId === "cpp") {
      // Only local includes: #include "file.h"  (skip <system.h>)
      const includeRegex = /^\s*#include\s+"([^"]+)"/gm;
      let match;
      while ((match = includeRegex.exec(content)) !== null) {
        const includePath = match[1];
        const resolved = this.resolveCInclude(includePath, filePath);
        dependencies.push({
          module: includePath,
          resolved,
          dependencyTypes: ["include"],
          valid: resolved !== null,
        });
      }
    } else if (languageId === "rust") {
      let match;
      // mod declarations: mod name;
      const modRegex = /^\s*mod\s+(\w+)\s*;/gm;
      while ((match = modRegex.exec(content)) !== null) {
        const modName = match[1];
        const resolved = this.resolveRustModule(modName, filePath);
        dependencies.push({
          module: modName,
          resolved,
          dependencyTypes: ["mod"],
          valid: resolved !== null,
        });
      }
      // use crate::, super::, self:: paths
      const useRegex = /^\s*use\s+((?:crate|super|self)::[^\s;{]+)/gm;
      while ((match = useRegex.exec(content)) !== null) {
        const usePath = match[1];
        const topName = usePath.split("::")[1];
        if (topName) {
          const resolved = this.resolveRustModule(topName, filePath);
          dependencies.push({
            module: usePath,
            resolved,
            dependencyTypes: ["use"],
            valid: resolved !== null,
          });
        }
      }
    } else if (languageId === "go") {
      let match;
      // Single-line: import "path"
      const singleImportRegex = /^\s*import\s+"([^"]+)"/gm;
      while ((match = singleImportRegex.exec(content)) !== null) {
        const importPath = match[1];
        const resolved = this.resolveGoImport(importPath, filePath);
        if (resolved !== null || this.isLocalGoPackage(importPath)) {
          dependencies.push({
            module: importPath,
            resolved,
            dependencyTypes: ["import"],
            valid: resolved !== null,
          });
        }
      }
      // Block imports: import ( "path" )
      const blockImportRegex = /import\s*\(([\s\S]*?)\)/g;
      while ((match = blockImportRegex.exec(content)) !== null) {
        const block = match[1];
        const pathRegex = /"([^"]+)"/g;
        let pathMatch;
        while ((pathMatch = pathRegex.exec(block)) !== null) {
          const importPath = pathMatch[1];
          const resolved = this.resolveGoImport(importPath, filePath);
          if (resolved !== null || this.isLocalGoPackage(importPath)) {
            dependencies.push({
              module: importPath,
              resolved,
              dependencyTypes: ["import"],
              valid: resolved !== null,
            });
          }
        }
      }
    } else if (languageId === "markdown") {
      // Extract [text](./relative/path.md) links as dependencies
      const linkRegex = /(?<!\!)\[([^\]]*)\]\(([^)\s"#]+)(?:\s+"[^"]*")?\)/g;
      let match;
      while ((match = linkRegex.exec(content)) !== null) {
        const linkTarget = match[2];
        // Only consider relative file links (not http/https/anchor-only)
        if (
          !linkTarget.startsWith("http://") &&
          !linkTarget.startsWith("https://") &&
          !linkTarget.startsWith("#") &&
          !linkTarget.startsWith("mailto:")
        ) {
          const resolved = this.resolveMarkdownLink(linkTarget, filePath);
          dependencies.push({
            module: linkTarget,
            resolved,
            dependencyTypes: ["link"],
            valid: resolved !== null,
          });
        }
      }
    }

    return dependencies;
  }

  private resolveModulePath(modulePath: string, fromFile: string): string | null {
    if (!modulePath.startsWith(".") && !modulePath.startsWith("/")) {
      return null; // External dependency
    }

    const fromDir = path.dirname(fromFile);
    let resolved: string;

    try {
      if (modulePath.startsWith("/")) {
        // Absolute path from workspace root
        resolved = path.join(this.workspaceRoot, modulePath);
      } else {
        // Relative path
        resolved = path.resolve(fromDir, modulePath);
      }

      // Try different extensions
      const extensions = ["", ".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs"];
      for (const ext of extensions) {
        const withExt = resolved + ext;
        if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) {
          return withExt;
        }
      }

      // Try as directory with index file
      const indexExtensions = ["index.js", "index.ts", "index.jsx", "index.tsx"];
      for (const indexExt of indexExtensions) {
        const indexPath = path.join(resolved, indexExt);
        if (fs.existsSync(indexPath)) {
          return indexPath;
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  private resolveMarkdownLink(linkTarget: string, fromFile: string): string | null {
    const fromDir = path.dirname(fromFile);
    try {
      const resolved = path.resolve(fromDir, linkTarget);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        return resolved;
      }
      // Try appending .md if no extension
      if (!path.extname(linkTarget)) {
        const withExt = resolved + ".md";
        if (fs.existsSync(withExt)) {
          return withExt;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  private resolveJavaImport(importPath: string, fromFile: string): string | null {
    // Convert com.example.ClassName → com/example/ClassName.java
    const relativePath = importPath.replace(/\./g, path.sep) + ".java";
    // Search common Java source roots
    const searchRoots = [
      this.workspaceRoot,
      path.join(this.workspaceRoot, "src"),
      path.join(this.workspaceRoot, "src", "main", "java"),
      path.join(this.workspaceRoot, "app", "src", "main", "java"),
    ];
    for (const root of searchRoots) {
      const candidate = path.join(root, relativePath);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  private resolveCInclude(includePath: string, fromFile: string): string | null {
    const fromDir = path.dirname(fromFile);
    // Search order: same dir, workspace root, common include dirs
    const searchDirs = [
      fromDir,
      this.workspaceRoot,
      path.join(this.workspaceRoot, "include"),
      path.join(this.workspaceRoot, "src"),
      path.join(this.workspaceRoot, "headers"),
    ];
    for (const dir of searchDirs) {
      const candidate = path.join(dir, includePath);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    }
    return null;
  }

  private resolveRustModule(modName: string, fromFile: string): string | null {
    const fromDir = path.dirname(fromFile);
    try {
      // Check sibling file: name.rs
      const siblingFile = path.join(fromDir, modName + ".rs");
      if (fs.existsSync(siblingFile)) {
        return siblingFile;
      }
      // Check subdir mod: name/mod.rs
      const modFile = path.join(fromDir, modName, "mod.rs");
      if (fs.existsSync(modFile)) {
        return modFile;
      }
      return null;
    } catch {
      return null;
    }
  }

  private isLocalGoPackage(importPath: string): boolean {
    // A local package has no dot in the first path segment (e.g. "utils/helper")
    const firstSegment = importPath.split("/")[0];
    return !firstSegment.includes(".");
  }

  private resolveGoImport(importPath: string, fromFile: string): string | null {
    // Skip standard library (no dots in first segment) and external packages (have dots)
    const firstSegment = importPath.split("/")[0];
    if (firstSegment.includes(".")) {
      return null; // external package (github.com/..., etc.)
    }

    // Try to find corresponding directory in workspace
    const candidate = path.join(this.workspaceRoot, importPath);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      // Return a representative .go file in that dir
      try {
        const entries = fs.readdirSync(candidate);
        const goFile = entries.find(e => e.endsWith(".go") && !e.endsWith("_test.go"));
        if (goFile) {
          return path.join(candidate, goFile);
        }
      } catch {
        // ignore
      }
      return candidate;
    }
    return null;
  }

  private resolvePythonModule(modulePath: string, fromFile: string): string | null {
    // Skip standard library
    if (!modulePath.includes("/") && !modulePath.includes("\\")) {
      return null;
    }

    const fromDir = path.dirname(fromFile);
    let resolved: string;

    try {
      if (modulePath.startsWith(".")) {
        resolved = path.resolve(fromDir, modulePath.replace(/\./g, path.sep));
      } else {
        resolved = path.resolve(this.workspaceRoot, modulePath.replace(/\./g, path.sep));
      }

      // Try .py extension
      const withExt = resolved + ".py";
      if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) {
        return withExt;
      }

      // Try as directory with __init__.py
      const initPath = path.join(resolved, "__init__.py");
      if (fs.existsSync(initPath)) {
        return initPath;
      }

      return null;
    } catch {
      return null;
    }
  }

  private extractFunctions(content: string, languageId: string): string[] {
    const functions: string[] = [];

    if (languageId === "typescript" || languageId === "javascript") {
      // Function declarations
      const funcDeclRegex = /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g;
      let match;
      while ((match = funcDeclRegex.exec(content)) !== null) {
        functions.push(match[1]);
      }

      // Arrow functions assigned to variables
      const arrowFuncRegex = /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*[:=]\s*(?:async\s*)?\(/g;
      while ((match = arrowFuncRegex.exec(content)) !== null) {
        functions.push(match[1]);
      }

      // Class methods
      const methodRegex = /(?:public\s+|private\s+|protected\s+)?(\w+)\s*\(/g;
      while ((match = methodRegex.exec(content)) !== null) {
        if (!functions.includes(match[1])) {
          functions.push(match[1]);
        }
      }
    } else if (languageId === "python") {
      const funcRegex = /def\s+(\w+)\s*\(/g;
      let match;
      while ((match = funcRegex.exec(content)) !== null) {
        functions.push(match[1]);
      }
    } else if (languageId === "java") {
      // public/private/protected [static] [returnType] methodName(
      const methodRegex = /(?:public|private|protected)\s+(?:static\s+)?(?:\w+[\w<>\[\]]*\s+)?(\w+)\s*\(/g;
      let match;
      while ((match = methodRegex.exec(content)) !== null) {
        if (match[1] !== "if" && match[1] !== "while" && match[1] !== "for" && match[1] !== "switch") {
          functions.push(match[1]);
        }
      }
    } else if (languageId === "c" || languageId === "cpp") {
      // Return type followed by function name and (
      const funcRegex = /^[\w\s*&]+\s+(\w+)\s*\([^;]*\)\s*(?:const\s*)?\{/gm;
      let match;
      while ((match = funcRegex.exec(content)) !== null) {
        const name = match[1];
        if (name && !/^(if|for|while|switch|return)$/.test(name)) {
          functions.push(name);
        }
      }
    } else if (languageId === "rust") {
      const funcRegex = /(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*[(<]/g;
      let match;
      while ((match = funcRegex.exec(content)) !== null) {
        functions.push(match[1]);
      }
    } else if (languageId === "go") {
      // func [receiver] FuncName(
      const funcRegex = /^func\s+(?:\(\w+\s+[\w*]+\)\s+)?(\w+)\s*\(/gm;
      let match;
      while ((match = funcRegex.exec(content)) !== null) {
        functions.push(match[1]);
      }
    }

    return functions;
  }

  private extractExports(content: string, languageId: string): string[] {
    const exports: string[] = [];

    if (languageId === "typescript" || languageId === "javascript") {
      // export function/const/class
      const exportRegex = /export\s+(?:function|const|let|class|async\s+function)\s+(\w+)/g;
      let match;
      while ((match = exportRegex.exec(content)) !== null) {
        exports.push(match[1]);
      }
    } else if (languageId === "python") {
      // __all__ or explicit exports (simplified)
      const allRegex = /__all__\s*=\s*\[([^\]]+)\]/;
      const match = content.match(allRegex);
      if (match) {
        const items = match[1].split(",").map(s => s.trim().replace(/['"]/g, ""));
        exports.push(...items);
      }
    } else if (languageId === "java") {
      // Public top-level types: public class/interface/enum/record Name
      const publicTypeRegex = /\bpublic\s+(?:(?:abstract|final|sealed)\s+)?(?:class|interface|enum|record)\s+(\w+)/g;
      let match;
      while ((match = publicTypeRegex.exec(content)) !== null) {
        exports.push(match[1]);
      }
      // Public methods at top level
      const publicMethodRegex = /\bpublic\s+(?:static\s+)?(?:\w+[\w<>\[\]]*\s+)?(\w+)\s*\(/g;
      while ((match = publicMethodRegex.exec(content)) !== null) {
        const name = match[1];
        if (name && !/^(if|for|while|switch|class|interface|enum|record)$/.test(name)) {
          exports.push(name);
        }
      }
    } else if (languageId === "rust") {
      // pub fn / pub struct / pub enum / pub trait / pub type / pub const / pub mod
      const pubRegex = /\bpub\s+(?:async\s+)?(?:fn|struct|enum|trait|type|const|mod)\s+(\w+)/g;
      let match;
      while ((match = pubRegex.exec(content)) !== null) {
        exports.push(match[1]);
      }
    } else if (languageId === "go") {
      // In Go, exported names start with uppercase: func UpperName(
      const exportedFuncRegex = /^func\s+(?:\(\w+\s+[\w*]+\)\s+)?([A-Z]\w*)\s*\(/gm;
      let match;
      while ((match = exportedFuncRegex.exec(content)) !== null) {
        exports.push(match[1]);
      }
      // Exported types: type UpperName struct/interface
      const exportedTypeRegex = /^type\s+([A-Z]\w*)\s+(?:struct|interface)/gm;
      while ((match = exportedTypeRegex.exec(content)) !== null) {
        exports.push(match[1]);
      }
    }

    return exports;
  }

  private resolveDependencies(): void {
    // Build dependents map (reverse of dependencies)
    for (const [source, module] of this.modules.entries()) {
      for (const dep of module.dependencies) {
        if (dep.resolved && this.modules.has(dep.resolved)) {
          const dependentModule = this.modules.get(dep.resolved)!;
          if (!dependentModule.dependents.includes(source)) {
            dependentModule.dependents.push(source);
          }
        }
      }
    }
  }

  private getLanguageId(ext: string): string {
    const langMap: Record<string, string> = {
      ".js": "javascript",
      ".jsx": "javascript",
      ".mjs": "javascript",
      ".cjs": "javascript",
      ".ts": "typescript",
      ".tsx": "typescript",
      ".py": "python",
      ".java": "java",
      ".cpp": "cpp",
      ".cxx": "cpp",
      ".cc": "cpp",
      ".c": "c",
      ".h": "c",
      ".hpp": "cpp",
      ".rs": "rust",
      ".go": "go",
      ".md": "markdown",
    };
    return langMap[ext] || "unknown";
  }

  public getModules(): Map<string, CodebaseModule> {
    return this.modules;
  }
}

