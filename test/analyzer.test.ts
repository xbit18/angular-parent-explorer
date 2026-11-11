import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { analyze, AnalysisCache } from '../src/analyzer';

test('separates known Angular dependencies from unresolved local and external imports', () => {
  const file = path.resolve('diagnostics/parent.ts');
  const files = new Map([[file, `import {Component} from '@angular/core';
    import {CommonModule} from '@angular/common'; import {Missing} from './missing';
    import {Library} from 'some-library';
    @Component({imports:[CommonModule,Missing,Library],template:''}) export class Parent {}`]]);
  const cache = new AnalysisCache();
  const result = analyze(files, cache);
  assert.equal(result.information.length, 1);
  assert.match(result.information[0], /CommonModule/);
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings.join('\n'), /Missing/);
  assert.match(result.warnings.join('\n'), /external dependency.*Library/);
  assert.deepEqual(analyze(files, cache), result);
});

test('finds actual imported standalone uses, not imports or unrelated selectors', () => {
  const root = path.resolve('fixture');
  const file = (name: string) => path.join(root, name);
  const files = new Map([
    [file('child.ts'), `import {Component} from '@angular/core'; @Component({selector:'app-child',template:''}) export class Child {}`],
    [file('parent.ts'), `import {Component} from '@angular/core'; import {Child} from './child'; @Component({imports:[Child],template:'<app-child/><app-child/>'}) export class Parent {}`],
    [file('unused.ts'), `import {Component} from '@angular/core'; import {Child} from './child'; @Component({imports:[Child],template:'<div/>'}) export class Unused {}`],
    [file('outside.ts'), `import {Component} from '@angular/core'; @Component({template:'<app-child/>'}) export class Outside {}`]
  ]);
  const result = analyze(files);
  assert.equal(result.components.length, 4);
  assert.equal(result.uses.length, 2);
  assert.ok(result.uses.every(use => use.parent.name === 'Parent' && use.child.name === 'Child'));
  assert.equal(files.get(file('parent.ts'))!.slice(result.uses[0].offset).startsWith('<app-child'), true);
});

test('invalidates cached external templates and selectors and removes deleted parents', () => {
  const f = (name: string) => path.resolve('incremental', name);
  const child = `import {Component} from '@angular/core'; @Component({selector:'app-child',template:''}) export class Child {}`;
  const files = new Map([
    [f('child.ts'), child],
    [f('parent.ts'), `import {Component} from '@angular/core'; import {Child} from './child'; @Component({imports:[Child],templateUrl:'./parent.html'}) export class Parent {}`],
    [f('parent.html'), '<app-child/>']
  ]);
  const cache = new AnalysisCache();
  assert.equal(analyze(files, cache).uses.length, 1);
  const cached = cache.templates.get(f('parent.ts') + '#Parent');
  assert.equal(analyze(files, cache).uses.length, 1);
  assert.equal(cache.templates.get(f('parent.ts') + '#Parent'), cached);
  files.set(f('parent.html'), '<div/>');
  assert.equal(analyze(files, cache).uses.length, 0);
  files.set(f('parent.html'), '<app-child/>');
  files.set(f('child.ts'), child.replace('app-child', 'other-child'));
  assert.equal(analyze(files, cache).uses.length, 0);
  files.delete(f('parent.ts'));
  assert.equal(analyze(files, cache).components.length, 1);
});

test('resolves tsconfig paths and renamed barrel re-exports; invalidates changed barrels', () => {
  const f = (name: string) => path.resolve('aliases', name);
  const files = new Map([
    [f('tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } })],
    [f('src/child.ts'), `import {Component} from '@angular/core'; @Component({selector:'adr-paginator',template:''}) export class Child {}`],
    [f('src/public/index.ts'), `export { Child as Paginator } from '../child';`],
    [f('src/parent.ts'), `import {Component} from '@angular/core'; import {Paginator} from '@/public'; @Component({imports:[Paginator],template:'<adr-paginator/>'}) export class Parent {}`]
  ]);
  const cache = new AnalysisCache();
  const result = analyze(files, cache);
  assert.equal(result.uses.length, 1);
  assert.equal(result.uses[0].child.name, 'Child');
  files.set(f('src/public/index.ts'), 'export {};');
  assert.equal(analyze(files, cache).uses.length, 0);
});

test('supports external templates, attribute selectors, aliases, and rejects explicit non-standalone components', () => {
  const root = path.resolve('fixture');
  const f = (name: string) => path.join(root, name);
  const result = analyze(new Map([
    [f('child.ts'), `import {Component} from '@angular/core'; @Component({selector:'button[child]',template:''}) export class Child {}`],
    [f('parent.ts'), `import {Component as C} from '@angular/core'; import {Child as Alias} from './child'; @C({imports:[Alias],templateUrl:'./parent.html',styleUrl:'./parent.scss'}) export class Parent {}`],
    [f('parent.html'), '<button child></button><div child></div>'],
    [f('legacy.ts'), `import {Component} from '@angular/core'; @Component({standalone:false,selector:'legacy',template:''}) export class Legacy {}`]
  ]));
  assert.equal(result.uses.length, 1);
  assert.equal(result.uses[0].file, f('parent.html'));
  assert.equal(result.components.length, 2);
  assert.ok(result.components.find(c => c.name === 'Parent')!.files.includes(f('parent.scss')));
});
