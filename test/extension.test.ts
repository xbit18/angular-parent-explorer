import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import { test } from 'node:test';

test('native parent expansion commands preserve occurrence selection, pin and filtering', async () => {
  const f = (name: string) => path.resolve('ui-fixture', name);
  const files = new Map([
    [f('child.ts'), `import {Component} from '@angular/core'; @Component({selector:'child-c',template:''}) export class Child {}`],
    [f('parent.ts'), `import {Component} from '@angular/core'; import {Child} from './child'; @Component({imports:[Child],templateUrl:'./parent.html'}) export class Parent {}`],
    [f('parent.html'), '<child-c/>']
  ]);
  const uri = (file: string) => ({ fsPath: file, toString: () => file });
  const window = { activeTextEditor: { document: { uri: uri(f('child.ts')) } },
    createOutputChannel: () => ({ appendLine() {}, clear() {}, show() {}, dispose() {} }),
    showInputBox: async () => 'not-found' };
  class TreeItem { constructor(readonly label: string, readonly collapsibleState?: number) {} }
  class Range { constructor(readonly startLine: number, readonly startColumn: number, readonly endLine: number, readonly endColumn: number) {} }
  const mock = { window, TreeItem, Range,
    EventEmitter: class { event = () => undefined; fire() {} dispose() {} },
    TreeItemCollapsibleState: { Collapsed: 1, Expanded: 2 }, ThemeIcon: { File: 'file-icon' }, Uri: { file: uri },
    commands: { executeCommand: async () => undefined },
    workspace: { findFiles: async () => [...files.keys()].map(uri), textDocuments: [],
      fs: { readFile: async (u: { fsPath: string }) => Buffer.from(files.get(u.fsPath)!) }, asRelativePath: (p: string) => p } };
  const loader = Module as unknown as { _load: (name: string, ...args: unknown[]) => unknown };
  const original = loader._load;
  loader._load = function(name, ...args) { return name === 'vscode' ? mock : original.call(this, name, ...args); };
  let Parents: typeof import('../src/extension').Parents;
  try { Parents = require('../src/extension').Parents; }
  finally { loader._load = original; }
  const provider = new Parents!();
  try {
    await provider.scan();
    const parent = provider.getChildren().find(e => typeof e !== 'string' && !('parent' in e))!;
    const collapsed = provider.getTreeItem(parent);
    assert.equal(collapsed.collapsibleState, 1);
    provider.setExpanded(true);
    const expanded = provider.getTreeItem(parent);
    assert.equal(expanded.collapsibleState, 2);
    assert.notEqual(expanded.id, collapsed.id);
    provider.setExpanded(false);
    assert.equal(provider.getTreeItem(parent).collapsibleState, 1);
    const use = provider.getChildren(parent)[0];
    const item = provider.getTreeItem(use);
    assert.equal(item.iconPath, 'file-icon');
    assert.equal(item.command?.command, 'vscode.open');
    const args = item.command!.arguments!;
    assert.equal(args[0].fsPath, f('parent.html'));
    assert.deepEqual(args[1].selection, new Range(0, 0, 0, 10));
    provider.pin();
    window.activeTextEditor.document.uri = uri(f('parent.ts'));
    assert.equal(provider.getChildren(parent).length, 1);
    await provider.filter();
    assert.match(String(provider.getChildren()[0]), /match the filter/);
    provider.clearFilter();
    assert.equal(provider.getChildren(parent).length, 1);
  } finally { provider.dispose(); }
});
