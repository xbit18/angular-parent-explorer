import path from 'node:path';
import ts from 'typescript';

/** Virtual filesystem only: never executes or loads workspace dependencies. */
export function createResolver(files: Map<string, string>): (specifier: string, from: string, name: string) => string | undefined {
  const sources = new Map<string, ts.SourceFile>();
  const configs = new Map<string, ts.CompilerOptions>();
  const directories = new Set<string>();
  for (const file of files.keys()) {
    let directory = path.dirname(file);
    while (!directories.has(directory)) {
      directories.add(directory);
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  const moduleCache = ts.createModuleResolutionCache(process.cwd(), file => file);
  const host: ts.ModuleResolutionHost = {
    fileExists: file => files.has(path.resolve(file)),
    readFile: file => files.get(path.resolve(file)),
    directoryExists: directory => directories.has(path.resolve(directory)),
    getCurrentDirectory: () => process.cwd(),
  };
  const configHost: ts.ParseConfigHost = { ...host, useCaseSensitiveFileNames: true, readDirectory: () => [] };
  const options = (from: string): ts.CompilerOptions => {
    let directory = path.dirname(from);
    while (true) {
      const file = path.join(directory, 'tsconfig.json');
      if (files.has(file)) {
        let result = configs.get(file);
        if (!result) {
          result = ts.getParsedCommandLineOfConfigFile(file, {}, {
            ...configHost, getCurrentDirectory: () => directory,
            onUnRecoverableConfigFileDiagnostic: () => undefined,
            fileExists: host.fileExists, readFile: host.readFile,
          })?.options ?? {};
          configs.set(file, result);
        }
        return { ...result, moduleResolution: result.moduleResolution ?? ts.ModuleResolutionKind.Node10 };
      }
      const parent = path.dirname(directory);
      if (parent === directory) return { moduleResolution: ts.ModuleResolutionKind.Node10 };
      directory = parent;
    }
  };
  const resolveFile = (specifier: string, from: string): string | undefined => {
    const resolved = ts.resolveModuleName(specifier, from, options(from), host, moduleCache).resolvedModule?.resolvedFileName;
    return resolved && path.resolve(resolved);
  };
  const symbol = (file: string, name: string, visiting: Set<string>): string | undefined => {
    const id = `${file}#${name}`;
    if (visiting.has(id)) return undefined;
    const next = new Set(visiting).add(id);
    const text = files.get(file);
    if (text === undefined) return undefined;
    let source = sources.get(file);
    if (!source) { source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true); sources.set(file, source); }
    for (const statement of source.statements) {
      if (ts.isClassDeclaration(statement) && statement.name && statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
        const exportedName = statement.modifiers.some(m => m.kind === ts.SyntaxKind.DefaultKeyword) ? 'default' : statement.name.text;
        if (exportedName === name) return `${file}#${statement.name.text}`;
      }
      if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const target = resolveFile(statement.moduleSpecifier.text, file);
      if (!target) continue;
      if (!statement.exportClause && name !== 'default') {
        const found = symbol(target, name, next);
        if (found) return found;
      } else if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const entry of statement.exportClause.elements) if (entry.name.text === name) {
          const found = symbol(target, entry.propertyName?.text ?? entry.name.text, next);
          if (found) return found;
        }
      }
    }
    return undefined;
  };
  return (specifier, from, name) => {
    const file = resolveFile(specifier, from);
    return file ? symbol(file, name, new Set()) : undefined;
  };
}
