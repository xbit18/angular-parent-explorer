import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { WorkerClient } from '../src/worker-client';

test('real bundled worker indexes changes, exact ranges, rebuild and disk restore', async () => {
  const scratch = path.join(os.tmpdir(), 'opencode');
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(path.join(scratch, 'angular-parents-worker-'));
  const child = path.join(directory, 'child.ts'), parent = path.join(directory, 'parent.ts');
  const html = path.join(directory, 'parent.html');
  const source = `import {Component} from '@angular/core'; @Component({selector:'child-c',template:''}) export class Child {}`;
  const owner = `import {Component} from '@angular/core'; import {Child} from './child'; @Component({imports:[Child],templateUrl:'./parent.html'}) export class Parent {}`;
  const entry = path.resolve('dist/analysis-worker.cjs');
  const client = new WorkerClient(entry, path.join(directory, 'index.json'));
  try {
    const first = await client.submit(new Map([[child, source], [parent, owner], [html, 'first\n<child-c/>']]), [], true);
    assert.equal(first.analysis.uses.length, 1);
    assert.deepEqual(first.locations[0].start, [1, 0]);
    assert.deepEqual(first.locations[0].end, [1, 10]);
    assert.equal(first.restored, false);
    await client.submit(new Map([[html, 'no usage']]), [], false);
    assert.equal((await client.submit(new Map([[html, '<child-c/>']]), [], false)).analysis.uses.length, 1);
    assert.equal((await client.submit(new Map(), [html], false)).analysis.uses.length, 0);
    assert.equal((await client.submit(new Map([[html, '<child-c/>']]), [], false)).analysis.uses.length, 1);
    assert.equal((await client.submit(new Map(), [], false, true)).restored, false);
  } finally { client.dispose(); }
  const restored = new WorkerClient(entry, path.join(directory, 'index.json'));
  try {
    const next = await restored.submit(new Map([[child, source], [parent, owner], [html, '<child-c/>']]), [], true);
    assert.equal(next.restored, true);
    assert.deepEqual(next.locations[0].start, [0, 0]);
  } finally { restored.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('worker exit and disposal settle every outstanding request', async () => {
  const client = new WorkerClient(path.resolve('dist/analysis-worker.cjs'));
  const pending = client.submit(new Map([['bad', 'data']]), [], true);
  const queued = client.submit(new Map([['bad', 'new']]), [], false);
  client.dispose();
  await assert.rejects(pending);
  await assert.rejects(queued);
  await assert.rejects(client.submit(new Map(), [], false));
});

test('worker startup error rejects active and queued requests without hanging', async () => {
  const client = new WorkerClient(path.resolve('dist/missing-worker.cjs'));
  const first = client.submit(new Map([['a', 'source']]), [], true);
  const second = client.submit(new Map([['a', 'new']]), [], false);
  try {
    await assert.rejects(first);
    await assert.rejects(second);
    await assert.rejects(client.submit(new Map(), [], false));
  } finally { client.dispose(); }
});

test('progress reaches only its active request, does not settle it, and ignores stale ids', async () => {
  const client = new WorkerClient(path.resolve('dist/analysis-worker.cjs'));
  const events: string[] = [];
  let settled = false;
  try {
    const pending = client.submit(new Map(), [], true, false, undefined, false, event => events.push(...event.messages.map(message => `first: ${message}`)));
    void pending.then(() => { settled = true; }, () => { settled = true; });
    const queued = client.submit(new Map(), [], false, false, undefined, false, event => events.push(...event.messages.map(message => `second: ${message}`)));
    const worker = (client as unknown as { worker: { emit: (name: string, event: unknown) => void } }).worker;
    worker.emit('message', { id: 2, progress: { kind: 'progress', messages: ['stale'] } });
    worker.emit('message', { id: 1, progress: { kind: 'progress', messages: ['live'] } });
    assert.deepEqual(events, ['first: live']);
    assert.equal(settled, false);
    await pending;
    await queued;
  } finally { client.dispose(); }
});

test('real worker streams diagnostics before the result and labels restored diagnostics as cached', async () => {
  const client = new WorkerClient(path.resolve('dist/analysis-worker.cjs'));
  const root = path.resolve('worker-progress');
  const source = `import {Component} from '@angular/core'; import {NgIf} from '@angular/common'; @Component({imports:[NgIf],template:''}) export class Parent {}`;
  const events: string[] = [];
  try {
    let completed = false;
    const result = await client.submit(new Map([[path.join(root, 'parent.ts'), source]]), [], true, false, undefined, false,
      event => { assert.equal(completed, false); events.push(...event.messages); }).then(value => { completed = true; return value; });
    assert.equal(result.analysis.information.length, 1);
    assert.ok(events.some(message => message.includes('excluded from workspace component matching')));
    const cached: string[] = [];
    await client.submit(new Map(), [], false, false, undefined, false, event => cached.push(...event.messages));
    assert.ok(cached.some(message => message.startsWith('[cached info]') && message.includes('excluded from workspace component matching')));
  } finally { client.dispose(); }
});

test('queued updates coalesce to the newest state after an in-flight request', async () => {
  const client = new WorkerClient(path.resolve('dist/analysis-worker.cjs'));
  const root = path.resolve('worker-coalescing');
  const child = path.join(root, 'child.ts'), parent = path.join(root, 'parent.ts');
  try {
    const initial = client.submit(new Map([
      [child, `import {Component} from '@angular/core'; @Component({selector:'child-c',template:''}) export class Child {}`],
      [parent, `import {Component} from '@angular/core'; import {Child} from './child'; @Component({imports:[Child],template:'<child-c/>'}) export class Parent {}`],
    ]), [], true);
    const old = client.submit(new Map([[parent, `import {Component} from '@angular/core'; @Component({template:'none'}) export class Parent {}`]]), [], false);
    const latest = client.submit(new Map([[parent, `import {Component} from '@angular/core'; import {Child} from './child'; @Component({imports:[Child],template:'<child-c/>'}) export class Parent {}`]]), [], false);
    assert.equal((await initial).analysis.uses.length, 1);
    assert.equal((await old).analysis.uses.length, 1);
    assert.equal((await latest).analysis.uses.length, 1);
  } finally { client.dispose(); }
});

test('real worker serves saved positions provisionally without sources and full rebuild bypasses cache', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'angular-parent-worker-manifest-'));
  const child = path.join(directory, 'child.ts'), parent = path.join(directory, 'parent.ts');
  const files = new Map([
    [child, `import {Component} from '@angular/core'; @Component({selector:'child-c',template:''}) export class Child {}`],
    [parent, `import {Component} from '@angular/core'; import {Child} from './child';\n@Component({imports:[Child],template:'<child-c/>'}) export class Parent {}`],
  ]);
  const manifest = new Map([...files].map(([name, text]) => [name, { size: Buffer.byteLength(text), mtime: 27 }]));
  const entry = path.resolve('dist/analysis-worker.cjs');
  const storageFile = path.join(directory, 'index.json');
  const first = new WorkerClient(entry, storageFile);
  try { await first.submit(files, [], true, false, manifest); } finally { first.dispose(); }
  const next = new WorkerClient(entry, storageFile);
  try {
    const provisional = await next.submit(new Map(), [], true, false, manifest, true);
    assert.equal(provisional.provisional, true);
    assert.deepEqual(provisional.locations[0].start, [1, 38]);
    assert.equal(provisional.analysis.uses.length, 1);
    const changed = new Map(files); changed.set(parent, files.get(parent)!.replace('<child-c/>', '<div    />'));
    const rebuilt = await next.submit(changed, [], true, true, manifest);
    assert.equal(rebuilt.provisional, undefined);
    assert.equal(rebuilt.restored, false);
    assert.equal(rebuilt.analysis.uses.length, 0);
  } finally { next.dispose(); await rm(directory, { recursive: true, force: true }); }
});
