import assert from 'node:assert/strict';
import { test } from 'node:test';
import Module from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { analyze } from '../src/analyzer';
import { IndexStorage } from '../src/index-storage';
import { WorkerClient } from '../src/worker-client';

test('an old background validation cannot replace a newer dirty-editor scan', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'angular-parent-race-'));
  const child = path.join(directory, 'child.ts'), parent = path.join(directory, 'parent.ts');
  const files = new Map([
    [child, `import {Component} from '@angular/core'; @Component({selector:'child-c',template:''}) export class Child {}`],
    [parent, `import {Component} from '@angular/core'; import {Child} from './child'; @Component({imports:[Child],template:'<child-c/>'}) export class Parent {}`],
  ]);
  const manifest = new Map([...files].map(([file, text]) => [file, { size: Buffer.byteLength(text), mtime: 11 }]));
  const uris = [...files.keys()].map(file => ({ fsPath: file, toString: () => file }));
  let unblock!: () => void;
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  let notify!: () => void;
  const entered = new Promise<void>(resolve => { notify = resolve; });
  let firstRead = true;
  const dirty = { uri: uris[1], fileName: parent, isDirty: true, getText: () => files.get(parent)!.replace('<child-c/>', '<div    />') };
  const documents: typeof dirty[] = [];
  const mock = {
    window: { activeTextEditor: { document: { uri: uris[0] } }, createOutputChannel: () => ({ appendLine() {}, clear() {}, dispose() {} }) },
    EventEmitter: class { event = () => undefined; fire() {} dispose() {} },
    TreeItemCollapsibleState: { Collapsed: 1, Expanded: 2 },
    workspace: { findFiles: async () => uris, textDocuments: documents, getWorkspaceFolder: () => ({}),
      fs: { stat: async (uri: {fsPath:string}) => manifest.get(uri.fsPath), readFile: async (uri: {fsPath:string}) => {
        if (firstRead) { firstRead = false; notify(); await blocked; }
        return Buffer.from(files.get(uri.fsPath)!);
      } }, asRelativePath: (file: string) => file },
  };
  const loader = Module as unknown as { _load: (name: string, ...args: unknown[]) => unknown };
  const original = loader._load;
  loader._load = function(name, ...args) { return name === 'vscode' ? mock : original.call(this, name, ...args); };
  let Parents: typeof import('../src/extension').Parents;
  try { Parents = require('../src/extension').Parents; } finally { loader._load = original; }
  const cacheFile = path.join(directory, 'index.json');
  try {
    await new IndexStorage(cacheFile).save(files, analyze(files), manifest);
    const provider = new Parents!(new WorkerClient(path.resolve('dist/analysis-worker.cjs'), cacheFile));
    try {
      const stale = provider.scan(true);
      await entered;
      assert.equal(provider.getChildren().filter(entry => typeof entry !== 'string').length, 1);
      documents.push(dirty);
      provider.update(dirty as never);
      await provider.scan(true);
      assert.equal(provider.getChildren().filter(entry => typeof entry !== 'string').length, 0);
      unblock();
      await stale;
      assert.equal(provider.getChildren().filter(entry => typeof entry !== 'string').length, 0);
    } finally { provider.dispose(); }
  } finally { unblock(); await rm(directory, { recursive: true, force: true }); }
});
