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
