export interface MemorySnapshot {
  rssMiB: number;
  heapUsedMiB: number;
  externalMiB: number;
}

/** Process-wide observations, not extension attribution or peak measurements. */
export function memorySnapshot(): MemorySnapshot {
  const memory = process.memoryUsage();
  const mib = (bytes: number): number => Math.round(bytes / 1024 / 1024 * 10) / 10;
  return { rssMiB: mib(memory.rss), heapUsedMiB: mib(memory.heapUsed), externalMiB: mib(memory.external) };
}

export function formatMemory(memory: MemorySnapshot): string {
  return `RSS ${memory.rssMiB} MiB; heap used ${memory.heapUsedMiB} MiB; external ${memory.externalMiB} MiB`;
}
