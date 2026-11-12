import { CssSelector, parseTemplate, SelectorMatcher } from '@angular/compiler';
import path from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { createResolver } from './resolver';

/** Length-framed values streamed into SHA-256, without serializing source text. */
function signature(value: unknown): string {
  const hash = createHash('sha256');
  const visit = (item: unknown): void => {
    if (typeof item === 'string') { hash.update(`s${Buffer.byteLength(item)}:`); hash.update(item); }
    else if (Array.isArray(item)) { hash.update(`a${item.length}:`); for (const entry of item) visit(entry); }
    else if (item !== null && typeof item === 'object') {
      const entries = Object.entries(item);
      hash.update(`o${entries.length}:`);
      for (const [key, entry] of entries) { visit(key); visit(entry); }
    } else { hash.update(`${typeof item}:${String(item)};`); }
  };
  visit(value);
  return hash.digest('hex');
}

export interface Component {
  id: string; name: string; file: string; files: string[]; selector: string;
  template: string; templateFile: string; templateOffset: number;
  imports: string[];
}
export interface Use { parent: Component; child: Component; file: string; offset: number; end: number }
export interface Analysis { components: Component[]; uses: Use[]; warnings: string[]; information: string[] }
export class AnalysisCache {
  readonly metadata = new Map<string, { text: string; external: string; components: Component[]; warnings: string[]; information: string[] }>();
  readonly templates = new Map<string, { key: string; uses: Use[]; warnings: string[] }>();
}

/** Static standalone subset. Unsupported metadata is reported, never evaluated. */
export function analyze(files: Map<string, string>, cache = new AnalysisCache(), report?: (messages: string[]) => void): Analysis {
  const components: Component[] = [];
  const warnings: string[] = [];
  const information: string[] = [];
  const inventory = signature([...files.keys()].sort());
  const resolutionKey = signature([...files].filter(([file]) => file.endsWith('.ts') || file.endsWith('.json')));
  const resolve = createResolver(files);
  for (const file of cache.metadata.keys()) if (!files.has(file)) cache.metadata.delete(file);
  for (const [file, text] of files) {
    if (!file.endsWith('.ts') || file.endsWith('.d.ts')) continue;
    const previous = cache.metadata.get(file);
    const external = signature([inventory, resolutionKey, previous?.components.map(c => [c.templateFile, files.get(c.templateFile)]) ?? []]);
    if (previous?.text === text && previous.external === external) {
      components.push(...previous.components); warnings.push(...previous.warnings); information.push(...previous.information);
      if (previous.information.length || previous.warnings.length) report?.([
        ...previous.information.map(info => `[cached info] ${info}`),
        ...previous.warnings.map(warning => `[cached incomplete] ${warning}`),
      ]);
      continue;
    }
    const componentStart = components.length;
    const warningStart = warnings.length;
    const informationStart = information.length;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const angularNames = new Set<string>();
    const imported = new Map<string, string>();
    const modules = new Map<string, string>();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const module = statement.moduleSpecifier.text;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const item of bindings.elements) {
        modules.set(item.name.text, module);
        const original = item.propertyName?.text ?? item.name.text;
        if (module === '@angular/core' && original === 'Component') angularNames.add(item.name.text);
        if (!module.startsWith('@angular/')) {
          const resolved = resolve(module, file, original);
          if (resolved) imported.set(item.name.text, resolved);
        }
      }
    }
    for (const node of source.statements) {
      if (!ts.isClassDeclaration(node) || !node.name) continue;
      for (const decorator of ts.getDecorators(node) ?? []) {
        const call = decorator.expression;
        if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || !angularNames.has(call.expression.text)) continue;
        const metadata = call.arguments[0];
        if (!metadata || !ts.isObjectLiteralExpression(metadata)) { warnings.push(`${file}: non-literal component metadata`); continue; }
        const props = new Map<string, ts.Expression>();
        for (const property of metadata.properties) {
          if (ts.isPropertyAssignment(property)) props.set(property.name.getText(source).replace(/['"]/g, ''), property.initializer);
        }
        if (props.get('standalone')?.kind === ts.SyntaxKind.FalseKeyword) continue;
        const literal = (key: string): string | undefined => {
          const value = props.get(key);
          return value && ts.isStringLiteralLike(value) ? value.text : undefined;
        };
        const external = literal('templateUrl');
        const templateNode = props.get('template');
        const templateFile = external ? path.resolve(path.dirname(file), external) : file;
        const template = external ? files.get(templateFile) : literal('template');
        if (template === undefined) { warnings.push(`${file}: unresolved template`); continue; }
        // Escaped inline literals need a decoded-to-source offset map; reject until supported.
        if (!external && templateNode && text.slice(templateNode.getStart(source) + 1, templateNode.end - 1) !== template) {
          warnings.push(`${file}: escaped inline template is not supported`); continue;
        }
        const dependencies: string[] = [];
        const imports = props.get('imports');
        if (imports && ts.isArrayLiteralExpression(imports)) {
          for (const entry of imports.elements) {
            if (ts.isIdentifier(entry) && imported.has(entry.text)) dependencies.push(imported.get(entry.text)!);
            else {
              const name = entry.getText(source);
              const module = ts.isIdentifier(entry) ? modules.get(entry.text) : undefined;
              // These framework imports cannot re-export workspace components.
              if (module === '@angular/common' || module === '@angular/forms' || module === '@angular/router') {
                information.push(`${file}: imported framework dependency ${name} (${module}); excluded from workspace component matching`);
              } else if (module && !module.startsWith('.') && !module.startsWith('@/')) {
                warnings.push(`${file}: uninspected external dependency ${name} (${module}); component scope may be incomplete`);
              } else warnings.push(`${file}: unresolved local import ${name}; component scope may be incomplete`);
            }
          }
        } else if (imports) warnings.push(`${file}: non-literal imports are not supported`);
        const styles: string[] = [];
        const style = literal('styleUrl');
        if (style) styles.push(path.resolve(path.dirname(file), style));
        const styleUrls = props.get('styleUrls');
        if (styleUrls && ts.isArrayLiteralExpression(styleUrls)) for (const entry of styleUrls.elements) {
          if (ts.isStringLiteralLike(entry)) styles.push(path.resolve(path.dirname(file), entry.text));
        }
        components.push({ id: `${file}#${node.name.text}`, name: node.name.text, file,
          files: [...new Set([file, templateFile, ...styles])], selector: literal('selector') ?? '',
          template, templateFile, templateOffset: external ? 0 : templateNode!.getStart(source) + 1, imports: dependencies });
      }
    }
    const extracted = components.slice(componentStart);
    cache.metadata.set(file, { text, external: signature([inventory, resolutionKey, extracted.map(c => [c.templateFile, files.get(c.templateFile)])]),
      components: extracted, warnings: warnings.slice(warningStart), information: information.slice(informationStart) });
    const batch = [...information.slice(informationStart).map(info => `[info] ${info}`),
      ...warnings.slice(warningStart).map(warning => `[incomplete] ${warning}`)];
    if (batch.length) report?.(batch);
  }
  const uses: Use[] = [];
  const byId = new Map(components.map(c => [c.id, c]));
  for (const id of cache.templates.keys()) if (!byId.has(id)) cache.templates.delete(id);
  for (const parent of components) {
    const key = signature([parent, parent.imports.map(id => byId.get(id))]);
    const previous = cache.templates.get(parent.id);
    if (previous?.key === key) {
      uses.push(...previous.uses); warnings.push(...previous.warnings);
      if (previous.warnings.length) report?.(previous.warnings.map(warning => `[cached incomplete] ${warning}`));
      continue;
    }
    const useStart = uses.length;
    const warningStart = warnings.length;
    const matcher = new SelectorMatcher<Component>();
    for (const id of parent.imports) {
      const child = byId.get(id);
      if (child?.selector) {
        try { matcher.addSelectables(CssSelector.parse(child.selector), child); }
        catch { warnings.push(`${child.file}: invalid selector`); }
      }
    }
    const parsed = parseTemplate(parent.template, parent.templateFile);
    if (parsed.errors?.length) {
      const warning = `${parent.templateFile}: template parse errors`;
      warnings.push(warning);
      report?.([`[incomplete] ${warning}`]);
      continue;
    }
    const visit = (nodes: readonly any[]): void => {
      for (const node of nodes) {
        if (typeof node.name === 'string' && node.startSourceSpan) {
          const selector = new CssSelector();
          selector.setElement(node.name);
          for (const attr of [...(node.attributes ?? []), ...(node.inputs ?? []), ...(node.outputs ?? [])]) {
            selector.addAttribute(attr.name, typeof attr.value === 'string' ? attr.value : '');
            if (attr.name === 'class' && typeof attr.value === 'string') for (const name of attr.value.split(/\s+/).filter(Boolean)) selector.addClassName(name);
          }
          const matched = new Set<string>();
          matcher.match(selector, (_selector, child) => {
            if (matched.has(child.id)) return;
            matched.add(child.id);
            uses.push({ parent, child, file: parent.templateFile,
              offset: parent.templateOffset + node.startSourceSpan.start.offset,
              end: parent.templateOffset + node.startSourceSpan.end.offset });
          });
        }
        for (const key of ['children', 'branches', 'cases']) if (Array.isArray(node[key])) visit(node[key]);
        if (node.empty) visit([node.empty]);
      }
    };
    visit(parsed.nodes);
    cache.templates.set(parent.id, { key, uses: uses.slice(useStart), warnings: warnings.slice(warningStart) });
    if (warnings.length > warningStart) report?.(warnings.slice(warningStart).map(warning => `[incomplete] ${warning}`));
  }
  return { components, uses, warnings, information };
}
