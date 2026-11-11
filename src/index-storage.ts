import { VERSION } from '@angular/compiler';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import type { Analysis, Component, Use } from './analyzer';

// Bump whenever analyzer semantics or the serialized navigation format changes.
const VERSION_KEY = `1:${VERSION.full}:${ts.version}`;
function fingerprint(files: Map<string, string>): string {
  const hash = createHash('sha256').update(VERSION_KEY);
  for (const file of [...files.keys()].sort()) hash.update(JSON.stringify([file, files.get(file)]));
  return hash.digest('hex');
}
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(v => typeof v === 'string');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function encodeIndex(files: Map<string, string>, result: Analysis): string {
  const payload = JSON.stringify({ version: VERSION_KEY, fingerprint: fingerprint(files),
    components: result.components.map(({ id, name, file, files }) => ({ id, name, file, files })),
    uses: result.uses.map(use => [use.parent.id, use.child.id, use.file, use.offset, use.end]),
    warnings: result.warnings, information: result.information });
  return JSON.stringify({ payload, checksum: createHash('sha256').update(payload).digest('hex') });
}

export function decodeIndex(text: string, files: Map<string, string>): Analysis | undefined {
  try {
    const envelope: unknown = JSON.parse(text);
    if (!record(envelope) || typeof envelope.payload !== 'string' ||
      envelope.checksum !== createHash('sha256').update(envelope.payload).digest('hex')) return;
    const data: unknown = JSON.parse(envelope.payload);
    if (!record(data) || data.version !== VERSION_KEY || data.fingerprint !== fingerprint(files) ||
      !Array.isArray(data.components) || !Array.isArray(data.uses) || !strings(data.warnings) || !strings(data.information)) return;
    const components: Component[] = [];
    const byId = new Map<string, Component>();
    for (const item of data.components) {
      if (!record(item) || typeof item.id !== 'string' || typeof item.name !== 'string' ||
        typeof item.file !== 'string' || !files.has(item.file) || !strings(item.files) ||
        !item.files.includes(item.file) || item.id !== `${item.file}#${item.name}` || byId.has(item.id)) return;
      const component: Component = { id: item.id, name: item.name, file: item.file, files: item.files,
        selector: '', template: '', templateFile: item.file, templateOffset: 0, imports: [] };
      components.push(component); byId.set(component.id, component);
    }
    const uses: Use[] = [];
    for (const item of data.uses) {
      if (!Array.isArray(item) || item.length !== 5) return;
      const [parentId, childId, file, offset, end] = item;
      const parent = byId.get(parentId), child = byId.get(childId);
      if (!parent || !child || typeof file !== 'string' || !parent.files.includes(file) || !files.has(file) ||
        !Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || offset < 0 || end < offset || end > files.get(file)!.length) return;
      uses.push({ parent, child, file, offset, end });
    }
    return { components, uses, warnings: data.warnings, information: data.information };
  } catch { return; }
}

/** Serial, atomic replacement: failed writes never replace a previously valid index. */
export class IndexStorage {
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly file: string) {}

  async load(files: Map<string, string>): Promise<Analysis | undefined> {
    try { return decodeIndex(await readFile(this.file, 'utf8'), files); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }

  save(files: Map<string, string>, result: Analysis): Promise<void> {
    const text = encodeIndex(files, result);
    const operation = this.writes.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await writeFile(temporary, text, 'utf8');
      await rename(temporary, this.file);
    });
    this.writes = operation;
    return operation;
  }
}
