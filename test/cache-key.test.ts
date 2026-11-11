import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { analyze, AnalysisCache } from '../src/analyzer';

test('cache signatures remain compact and invalidate changed templates', () => {
  const file = path.resolve('compact/component.ts');
  const files = new Map([[file, `import {Component} from '@angular/core'; @Component({selector:'app-c',template:'${' '.repeat(10000)}'}) export class C {}`]]);
  const cache = new AnalysisCache();
  const first = analyze(files, cache);
  for (const value of cache.metadata.values()) assert.match(value.external, /^[a-f0-9]{64}$/);
  for (const value of cache.templates.values()) assert.match(value.key, /^[a-f0-9]{64}$/);
  assert.deepEqual(analyze(files, cache), first);
  files.set(file, files.get(file)!.replace("selector:'app-c'", "selector:'app-changed'"));
  assert.equal(analyze(files, cache).components[0].selector, 'app-changed');
});
