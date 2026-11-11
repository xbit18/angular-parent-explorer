import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatMemory, memorySnapshot } from '../src/memory';

test('memory observations expose finite process values and explicit units', () => {
  const snapshot = memorySnapshot();
  for (const value of Object.values(snapshot)) assert.ok(Number.isFinite(value) && value >= 0);
  assert.equal(formatMemory({ rssMiB: 100, heapUsedMiB: 40, externalMiB: 2 }),
    'RSS 100 MiB; heap used 40 MiB; external 2 MiB');
});
