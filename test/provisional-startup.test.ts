import assert from 'node:assert/strict';
import { test } from 'node:test';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { analyze } from '../src/analyzer';
import { IndexStorage } from '../src/index-storage';
import { WorkerClient } from '../src/worker-client';

test('cached navigation is provisional before full read completes and validation detects hidden edits', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'angular-parent-provisional-'));
  const child = path.join(directory, 'child.ts'), parent = path.join(directory, 'parent.ts');
  const sources = new Map([
    [child, `import {Component} from '@angular/core'; @Component({selector:'child-c',template:''}) export class Child {}`],
    [parent, `import {Component} from '@angular/core'; import {Child} from './child';\n@Component({imports:[Child],template:'<child-c/>'}) export class Parent {}`],
  ]);
  const metadata = new Map([...sources.keys()].map(file => [file, { size: Buffer.byteLength(sources.get(file)!), mtime: 100 }]));
  const originalParent = sources.get(parent)!;
  const uris = [...sources.keys()].map(file => ({ fsPath: file, toString: () => file }));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let reading!: () => void;
  const started = new Promise<void>(resolve => { reading = resolve; });
  const output: string[] = [];
  const openDocuments: { uri: typeof uris[number]; isDirty: boolean; getText: () => string }[] = [];
  const mock = {
    window: { activeTextEditor: { document: { uri: uris[0] } }, createOutputChannel: () => ({ appendLine: (line: string) => output.push(line), clear() { output.length = 0; }, dispose() {} }) },
    EventEmitter: class { event = () => undefined; fire() {} dispose() {} },
    TreeItemCollapsibleState: { Collapsed: 1, Expanded: 2 },
    workspace: { findFiles: async () => uris, textDocuments: openDocuments, getWorkspaceFolder: () => ({}),
      fs: { stat: async (uri: {fsPath:string}) => metadata.get(uri.fsPath), readFile: async (uri: {fsPath:string}) => { reading(); await gate; return Buffer.from(sources.get(uri.fsPath)!); } },
      asRelativePath: (value: string) => value },
  };
  const loader = Module as unknown as { _load: (name: string, ...args: unknown[]) => unknown };
  const original = loader._load;
  loader._load = function(name, ...args) { return name === 'vscode' ? mock : original.call(this, name, ...args); };
  let Parents: typeof import('../src/extension').Parents;
  try { Parents = require('../src/extension').Parents; } finally { loader._load = original; }
  const cacheFile = path.join(directory, 'index.json');
  try {
    await new IndexStorage(cacheFile).save(sources, analyze(sources), metadata);
    const provider = new Parents!(new WorkerClient(path.resolve('dist/analysis-worker.cjs'), cacheFile));
    const view = { title: '', description: '', message: '' };
    provider.view = view as typeof provider.view;
    try {
      const scan = provider.scan(true);
      await started;
      assert.match(view.description, /Verifying/);
      assert.match(output.join('\n'), /File discovery: begin[\s\S]*File discovery: end/);
      assert.match(output.join('\n'), /Workspace read\/validation: begin/);
      const initialTiming = output.filter(line => /^(File discovery|Manifest collection|Provisional cache request|First results published)/.test(line));
      assert.equal(initialTiming.length, 7);
      assert.ok(provider.getChildren().some(entry => typeof entry !== 'string'), JSON.stringify({ children: provider.getChildren(), output }));
      sources.set(parent, sources.get(parent)!.replace('<child-c/>', '<div    />'));
      release();
      await scan;
      assert.match(view.description, /Ready/);
      assert.match(output.join('\n'), /live analysis/);
      assert.deepEqual(output.filter(line => /^(File discovery|Manifest collection|Provisional cache request|First results published)/.test(line)), initialTiming,
        'final output never replays provisional publication timings');
      assert.equal(output.filter(line => line.startsWith('File discovery: begin')).length, 1, 'output is never cleared and replayed');
      assert.ok(output.findIndex(line => line.includes('Workspace read/validation: end')) < output.findIndex(line => line.includes('Final summary:')));
    } finally { provider.dispose(); }
    openDocuments.push({ uri: uris[1], isDirty: true, getText: () => originalParent });
    const dirtyProvider = new Parents!(new WorkerClient(path.resolve('dist/analysis-worker.cjs'), cacheFile));
    try {
      const dirtyStart = output.length;
      await dirtyProvider.scan(true);
      assert.equal(dirtyProvider.getChildren().filter(entry => typeof entry !== 'string').length, 1,
        'dirty editor contents override the saved snapshot');
      assert.doesNotMatch(output.slice(dirtyStart).join('\n'), /provisional/i, 'dirty documents bypass provisional navigation');
      assert.equal(output.slice(dirtyStart).filter(line => line.startsWith('First results published')).length, 0);
    } finally { dirtyProvider.dispose(); }
  } finally { release(); await rm(directory, { recursive: true, force: true }); }
});

test('manifest metadata requests overlap with a bounded cap and failed stats fall back to full analysis', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'angular-parent-metadata-'));
  const uris = Array.from({ length: 24 }, (_, index) => ({ fsPath: path.join(directory, `${index}.ts`), toString() { return this.fsPath; } }));
  let active = 0, peak = 0;
  const releases: (() => void)[] = [];
  const output: string[] = [];
  const mock = {
    window: { createOutputChannel: () => ({ appendLine: (line: string) => output.push(line), clear() { throw new Error('output must not clear'); }, dispose() {} }) },
    EventEmitter: class { event = () => undefined; fire() {} dispose() {} },
    TreeItemCollapsibleState: { Collapsed: 1, Expanded: 2 },
    workspace: { findFiles: async () => uris, textDocuments: [],
      fs: { stat: async () => { active++; peak = Math.max(peak, active); await new Promise<void>(resolve => releases.push(resolve)); active--; throw new Error('stat failed'); },
        readFile: async () => Buffer.from('') }, asRelativePath: (value: string) => value },
  };
  const loader = Module as unknown as { _load: (name: string, ...args: unknown[]) => unknown };
  const original = loader._load;
  loader._load = function(name, ...args) { return name === 'vscode' ? mock : original.call(this, name, ...args); };
  let Parents: typeof import('../src/extension').Parents;
  try { delete require.cache[require.resolve('../src/extension')]; Parents = require('../src/extension').Parents; } finally { loader._load = original; }
  const provider = new Parents!(new WorkerClient(path.resolve('dist/analysis-worker.cjs')));
  try {
    const scan = provider.scan(true);
    for (let turn = 0; turn < 100 && peak < 2; turn++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(peak > 1 && peak <= 8, `expected overlap within cap, saw ${peak}`);
    while (releases.length) releases.shift()!();
    await scan;
    assert.match(output.join('\n'), /Workspace metadata unavailable: Error: stat failed/);
    assert.match(output.join('\n'), /Final summary:/);
  } finally { releases.forEach(release => release()); provider.dispose(); await rm(directory, { recursive: true, force: true }); }
});
