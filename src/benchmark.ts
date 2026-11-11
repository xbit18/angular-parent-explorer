import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { analyze, AnalysisCache } from './analyzer';
import { memorySnapshot } from './memory';

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target) throw new Error('Usage: npm run benchmark -- <project-directory>');
  const root = path.resolve(target);
  const files = new Map<string, string>();
  const excluded = new Set(['node_modules', 'dist', 'out', 'coverage', '.git', '.angular', '.codegraph']);
  const started = performance.now();
  const beforeRead = memorySnapshot();
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && !excluded.has(entry.name)) await visit(file);
      else if (entry.isFile() && /\.(ts|html|json)$/.test(entry.name)) files.set(file, await readFile(file, 'utf8'));
    }
  }
  await visit(root);
  const readMs = performance.now() - started;
  const afterRead = memorySnapshot();
  const cache = new AnalysisCache();
  for (const mode of ['cold', 'warm']) {
    const analysisStart = performance.now();
    const beforeAnalysis = memorySnapshot();
    const result = analyze(files, cache);
    const afterAnalysis = memorySnapshot();
    const analysisMs = performance.now() - analysisStart;
    console.log(JSON.stringify({ mode, files: files.size, components: result.components.length,
      occurrences: result.uses.length, warnings: result.warnings.length, information: result.information.length,
      readMs: mode === 'cold' ? readMs : 0, analysisMs,
      totalMs: analysisMs + (mode === 'cold' ? readMs : 0),
      memory: { scope: 'whole benchmark process; samples, not peaks; no forced GC',
        beforeRead, afterRead, beforeAnalysis, afterAnalysis } }));
  }
}

main().catch(error => { console.error(String(error)); process.exitCode = 1; });
