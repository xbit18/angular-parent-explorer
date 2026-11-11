import assert from 'node:assert/strict';
import { test } from 'node:test';
import Module from 'node:module';
import path from 'node:path';

test('older failed scan does not replace a newer successful result', async () => {
  const file = path.resolve('stale-scan/child.ts');
  const source = `import {Component} from '@angular/core'; @Component({selector:'child-c',template:''}) export class Child {}`;
  const parent = path.resolve('stale-scan/parent.ts');
  const parentSource = `import {Component} from '@angular/core'; import {Child} from './child'; @Component({imports:[Child],template:'<child-c/>'}) export class Parent {}`;
  let rejectOld!: (reason: Error) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const old = new Promise<never>((_, reject) => { rejectOld = reject; });
  let calls = 0;
  const uri = { fsPath: file, toString: () => file };
  const mock = {
    window: { activeTextEditor: { document: { uri } }, createOutputChannel: () => ({ appendLine() {}, clear() {}, dispose() {} }) },
    EventEmitter: class { event = () => undefined; fire() {} dispose() {} },
    TreeItemCollapsibleState: { Collapsed: 1, Expanded: 2 },
    workspace: { findFiles: () => { if (++calls === 1) { entered(); return old; } return Promise.resolve([uri, { fsPath: parent, toString: () => parent }]); },
      textDocuments: [], fs: { readFile: async (u: {fsPath:string}) => Buffer.from(u.fsPath === file ? source : parentSource) }, asRelativePath: (p: string) => p },
  };
  const loader = Module as unknown as { _load: (name: string, ...args: unknown[]) => unknown };
  const original = loader._load;
  loader._load = function(name, ...args) { return name === 'vscode' ? mock : original.call(this, name, ...args); };
  let Parents: typeof import('../src/extension').Parents;
  try { Parents = require('../src/extension').Parents; }
  finally { loader._load = original; }
  const provider = new Parents!();
  try {
    const stale = provider.scan();
    await started;
    await provider.scan();
    assert.ok(provider.getChildren().some(e => typeof e !== 'string'), 'new scan publishes component');
    rejectOld(new Error('old scan read failure'));
    await stale;
    assert.ok(provider.getChildren().some(e => typeof e !== 'string'), 'old scan error must not hide new result');
  } finally { provider.dispose(); }
});
