import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { analyze } from '../src/analyzer';
import { encodeIndex, decodeIndex, IndexStorage } from '../src/index-storage';
import { formatDuration } from '../src/view-state';

const file = path.resolve('disk-fixture/child.ts');
const parent = path.resolve('disk-fixture/parent.ts');
const fixture = (): Map<string, string> => new Map([
  [file, `import {Component} from '@angular/core'; @Component({selector:'child-c',template:''}) export class Child {}`],
  [parent, `import {Component} from '@angular/core'; import {Child} from './child'; @Component({imports:[Child],template:'<child-c/>'}) export class Parent {}`]
]);

test('formats milliseconds, seconds and minutes for indexing', () => {
  assert.equal(formatDuration(456), '456 ms');
  assert.equal(formatDuration(48484), '48.5 s');
  assert.equal(formatDuration(125000), '2 min 5 s');
});

test('disk index roundtrip retains owners, diagnostics and exact occurrence navigation without source templates', () => {
  const files = fixture();
  const result = analyze(files);
  const encoded = encodeIndex(files, result);
  assert.equal(encoded.includes("import {Component}"), false);
  const restored = decodeIndex(encoded, files)!;
  assert.ok(restored);
  assert.deepEqual(restored.components.map(c => [c.id, c.name, c.files]), result.components.map(c => [c.id, c.name, c.files]));
  assert.deepEqual(restored.uses.map(u => [u.parent.id, u.child.id, u.file, u.offset, u.end]),
    result.uses.map(u => [u.parent.id, u.child.id, u.file, u.offset, u.end]));
  assert.equal(restored.uses[0].parent, restored.components.find(c => c.name === 'Parent'));
  assert.deepEqual(restored.warnings, result.warnings);
});

test('rejects edited, added, deleted, moved, malformed and old cached inputs', () => {
  const files = fixture();
  const encoded = encodeIndex(files, analyze(files));
  assert.equal(decodeIndex('broken JSON', files), undefined);
  assert.equal(decodeIndex('{}', files), undefined);
  const old = JSON.parse(encoded); old.payload = old.payload.replace('1:', '-1:');
  assert.equal(decodeIndex(JSON.stringify(old), files), undefined);
  for (const changed of [new Map([...files, [parent, 'changed']]), new Map([...files, [path.resolve('new.json'), '{}']]),
    new Map([[file, files.get(file)!]]), new Map([...files].map(([f, text]) => [f + '.moved', text]))]) {
    assert.equal(decodeIndex(encoded, changed), undefined);
  }
  // Enumeration order is not a content change.
  assert.ok(decodeIndex(encoded, new Map([...files].reverse())));
  const corrupt = JSON.parse(encoded); corrupt.payload = corrupt.payload.replace('Parent', 'Changed');
  assert.equal(decodeIndex(JSON.stringify(corrupt), files), undefined);
});

test('persists ordered snapshots across instances, handles missing/corrupt cache and rejects failed writes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'angular-parent-index-'));
  try {
    const cacheFile = path.join(directory, 'storage', 'index.json');
    const storage = new IndexStorage(cacheFile);
    const first = fixture();
    assert.equal(await storage.load(first), undefined);
    const changed = new Map(first); changed.set(parent, first.get(parent)!.replace('<child-c/>', '<div/>'));
    const earlier = storage.save(first, analyze(first));
    const later = storage.save(changed, analyze(changed));
    await Promise.all([earlier, later]);
    const reopened = new IndexStorage(cacheFile);
    assert.equal((await reopened.load(changed))!.uses.length, 0);
    assert.equal(await reopened.load(first), undefined);
    const beforeFailure = await readFile(cacheFile, 'utf8');
    const impossible = new IndexStorage(path.join(cacheFile, 'index.json'));
    await assert.rejects(impossible.save(first, analyze(first)));
    assert.equal(await readFile(cacheFile, 'utf8'), beforeFailure);
    await writeFile(cacheFile, 'corrupt');
    assert.equal(await reopened.load(changed), undefined);
    await reopened.save(first, analyze(first));
    assert.equal((await reopened.load(first))!.uses.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
