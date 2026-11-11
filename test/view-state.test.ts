import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ViewState } from '../src/view-state';
import { Component } from '../src/analyzer';

const component = (name: string): Component => ({ id: name, name, file: `${name}.ts`,
  files: [`${name}.ts`, `${name}.html`], selector: '', template: '', templateFile: `${name}.html`, templateOffset: 0, imports: [] });

test('pin follows stable identity across updates, ignores navigation and unpin follows editor', () => {
  const state = new ViewState();
  const a = component('A'), b = component('B');
  assert.deepEqual(state.owners([a, b], 'A.html'), [a]);
  state.togglePin(a);
  const updated = { ...a, template: 'updated' };
  assert.deepEqual(state.owners([updated, b], 'B.ts'), [updated]);
  assert.deepEqual(state.owners([b], 'B.ts'), []);
  state.togglePin();
  assert.deepEqual(state.owners([updated, b], 'B.ts'), [b]);
});

test('parent filter is trimmed case-insensitive substring and clearing restores names', () => {
  const state = new ViewState();
  state.filter = ' paginator ';
  assert.equal(state.matches('LongPaginatorComponent'), true);
  assert.equal(state.matches('OtherComponent'), false);
  state.filter = '';
  assert.equal(state.matches('OtherComponent'), true);
});

test('context warnings include owner and resolved parents, not unrelated workspace files', () => {
  const state = new ViewState();
  assert.deepEqual(state.contextualWarnings(['A.ts: unsupported', 'B.html: parse errors', 'Other.ts: unresolved'],
    component('A'), [component('B')]), ['A.ts: unsupported', 'B.html: parse errors']);
});
