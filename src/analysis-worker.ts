import { parentPort } from 'node:worker_threads';
import { analyze, AnalysisCache, type Analysis } from './analyzer';
import { IndexStorage } from './index-storage';
import { memorySnapshot } from './memory';
import type { Request, Reply, Location } from './worker-protocol';

const files = new Map<string, string>();
const cache = new AnalysisCache();
let storage: IndexStorage | undefined;
let storagePath: string | undefined;

function location(starts: number[], offset: number): [number, number] {
  let low = 0, high = starts.length;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (starts[middle] <= offset) low = middle;
    else high = middle;
  }
  return [low, offset - starts[low]];
}

async function handle(request: Request): Promise<Reply> {
  try {
    if (request.initial) files.clear();
    for (const file of request.deleted) files.delete(file);
    for (const [file, source] of request.changes) files.set(file, source);
    if (request.storageFile !== storagePath) {
      storagePath = request.storageFile;
      storage = storagePath ? new IndexStorage(storagePath) : undefined;
    }
    if (request.rebuild) { cache.metadata.clear(); cache.templates.clear(); }
    const before = memorySnapshot();
    const start = performance.now();
    let restored: Analysis | undefined;
    let diskError: string | undefined;
    if (request.initial && !request.rebuild && storage) {
      try { restored = await storage.load(files); }
      catch (error) { diskError = String(error); }
    }
    const analysis = restored ?? analyze(files, cache);
    const lines = new Map<string, number[]>();
    const locations: Location[] = analysis.uses.map(use => {
      let starts = lines.get(use.file);
      if (!starts) {
        starts = [0];
        const text = files.get(use.file) ?? '';
        for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10) starts.push(index + 1);
        lines.set(use.file, starts);
      }
      return { start: location(starts, use.offset), end: location(starts, use.end) };
    });
    const compactComponents = analysis.components.map(({ id, name, file, files }) => ({
      id, name, file, files, selector: '', template: '', templateFile: file, templateOffset: 0, imports: [],
    }));
    const byId = new Map(compactComponents.map(component => [component.id, component]));
    const compact: Analysis = { ...analysis, components: compactComponents, uses: analysis.uses.map(use => ({
      parent: byId.get(use.parent.id)!, child: byId.get(use.child.id)!, file: use.file, offset: use.offset, end: use.end,
    })) };
    const analysisMs = performance.now() - start;
    const after = memorySnapshot();
    if (!restored && storage) {
      try { await storage.save(files, analysis); }
      catch (error) { diskError = String(error); }
    }
    return { id: request.id, result: { analysis: compact, locations, restored: !!restored,
      files: files.size, analysisMs, before, after, diskError } };
  } catch (error) { return { id: request.id, error: String(error) }; }
}

// Serial processing keeps updates in order even while disk I/O yields to the event loop.
let chain = Promise.resolve();
parentPort?.on('message', (request: Request) => {
  chain = chain.then(async () => { parentPort?.postMessage(await handle(request)); });
});
