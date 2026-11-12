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
  const old = JSON.parse(encoded); old.payload = old.payload.replace('2:', '-1:');
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

test('external stylesheet ownership survives exact and provisional cache restoration', async () => {
  const files = fixture();
  files.set(parent, files.get(parent)!.replace("imports:[Child]", "styleUrl:'./parent.scss',styleUrls:['./extra.css'],imports:[Child]"));
  const result = analyze(files);
  const manifest = new Map([...files].map(([name, text]) => [name, { size: Buffer.byteLength(text), mtime: 1 }]));
  const encoded = encodeIndex(files, result, manifest);
  const exact = decodeIndex(encoded, files);
  assert.ok(exact, 'stylesheet ownership must not invalidate the cache');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'angular-parent-styles-'));
  try {
    const cacheFile = path.join(directory, 'index.json');
    await writeFile(cacheFile, encoded);
    const provisional = await new IndexStorage(cacheFile).loadProvisional(manifest);
    assert.ok(provisional);
    for (const restored of [exact, provisional.analysis]) {
      assert.deepEqual(restored.components.find(c => c.name === 'Parent')!.files,
        result.components.find(c => c.name === 'Parent')!.files);
      assert.equal(restored.uses.length, 1);
      assert.equal(restored.uses[0].offset, result.uses[0].offset);
    }
    const missingSource = new Map(manifest); missingSource.delete(parent);
    assert.equal(await new IndexStorage(cacheFile).loadProvisional(missingSource), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
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

test('provisional manifest enforces inventory and metadata, preserves exact stored positions, rejects old and corrupt envelopes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'angular-parent-manifest-'));
  const files = fixture();
  const manifest = new Map([...files].map(([name, text]) => [name, { size: Buffer.byteLength(text), mtime: 17 }]));
  const storageFile = path.join(directory, 'index.json');
  const storage = new IndexStorage(storageFile);
  try {
    await storage.save(files, analyze(files), manifest);
    const cached = await storage.loadProvisional(manifest);
    assert.equal(cached?.analysis.uses.length, 1);
    const offset = cached!.analysis.uses[0].offset;
    assert.deepEqual(cached?.locations[0].start, [0, offset]);
    for (const changed of [new Map([...manifest, [path.join(directory, 'added.ts'), { size: 1, mtime: 17 }]]),
      new Map([[file, manifest.get(file)!]]),
      new Map([...manifest].map(([name, stamp]) => [name, { ...stamp, mtime: 19 }])),
      new Map([...manifest].map(([name, stamp]) => [name, { ...stamp, size: stamp.size + 1 }]))]) {
      assert.equal(await storage.loadProvisional(changed), undefined);
    }
    await writeFile(storageFile, 'corrupt');
    assert.equal(await storage.loadProvisional(manifest), undefined);
    await storage.save(files, analyze(files));
    assert.equal(await storage.loadProvisional(manifest), undefined, 'legacy/no-manifest snapshot falls back');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
