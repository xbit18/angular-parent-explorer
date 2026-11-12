import { VERSION } from '@angular/compiler';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import type { Analysis, Component, Use } from './analyzer';

// Bump whenever analyzer semantics or the serialized navigation format changes.
const VERSION_KEY = `2:${VERSION.full}:${ts.version}`;
export interface FileStamp { size: number; mtime: number }
export type Manifest = Map<string, FileStamp>;
export interface StoredIndex { analysis: Analysis; locations: { start: [number, number]; end: [number, number] }[] }
function fingerprint(files: Map<string, string>): string {
  const hash = createHash('sha256').update(VERSION_KEY);
  for (const file of [...files.keys()].sort()) hash.update(JSON.stringify([file, files.get(file)]));
  return hash.digest('hex');
}
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(v => typeof v === 'string');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function encodeIndex(files: Map<string, string>, result: Analysis, manifest?: Manifest): string {
  const positions = new Map<string, number[]>();
  const position = (file: string, offset: number): [number, number] => {
    let starts = positions.get(file);
    if (!starts) {
      starts = [0];
      const text = files.get(file) ?? '';
      for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10) starts.push(index + 1);
      positions.set(file, starts);
    }
    let low = 0, high = starts.length;
    while (low + 1 < high) { const middle = (low + high) >>> 1; if (starts[middle] <= offset) low = middle; else high = middle; }
    return [low, offset - starts[low]];
  };
  const payload = JSON.stringify({ version: VERSION_KEY, fingerprint: fingerprint(files),
    manifest: manifest && [...manifest].sort(([a], [b]) => a.localeCompare(b)),
    components: result.components.map(({ id, name, file, files }) => ({ id, name, file, files })),
    uses: result.uses.map(use => [use.parent.id, use.child.id, use.file, use.offset, use.end,
      position(use.file, use.offset), position(use.file, use.end)]),
    warnings: result.warnings, information: result.information });
  return JSON.stringify({ payload, checksum: createHash('sha256').update(payload).digest('hex') });
}

function decode(text: string, files?: Map<string, string>, manifest?: Manifest): StoredIndex | undefined {
  try {
    const envelope: unknown = JSON.parse(text);
    if (!record(envelope) || typeof envelope.payload !== 'string' ||
      envelope.checksum !== createHash('sha256').update(envelope.payload).digest('hex')) return;
    const data: unknown = JSON.parse(envelope.payload);
    if (!record(data) || data.version !== VERSION_KEY || (files && data.fingerprint !== fingerprint(files)) ||
      !Array.isArray(data.components) || !Array.isArray(data.uses) || !strings(data.warnings) || !strings(data.information)) return;
    if (!files) {
      if (!manifest || !Array.isArray(data.manifest) || data.manifest.length !== manifest.size) return;
      const seen = new Set<string>();
      for (const item of data.manifest) {
        if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || !record(item[1]) ||
          seen.has(item[0]) ||
          !Number.isFinite(item[1].size) || !Number.isFinite(item[1].mtime) ||
          manifest.get(item[0])?.size !== item[1].size || manifest.get(item[0])?.mtime !== item[1].mtime) return;
        seen.add(item[0]);
      }
    }
    const known = (file: string) => files ? files.has(file) : manifest!.has(file);
    const components: Component[] = [];
    const byId = new Map<string, Component>();
    for (const item of data.components) {
      if (!record(item) || typeof item.id !== 'string' || typeof item.name !== 'string' ||
        typeof item.file !== 'string' || !known(item.file) || !strings(item.files) ||
        // Stylesheets identify editor owners but are not analysis inputs in the manifest.
        !item.files.every(file => known(file) || /\.(?:css|scss|sass|less|styl)$/i.test(file)) ||
        !item.files.includes(item.file) || item.id !== `${item.file}#${item.name}` || byId.has(item.id)) return;
      const component: Component = { id: item.id, name: item.name, file: item.file, files: item.files,
        selector: '', template: '', templateFile: item.file, templateOffset: 0, imports: [] };
      components.push(component); byId.set(component.id, component);
    }
    const uses: Use[] = [];
    const locations: StoredIndex['locations'] = [];
    for (const item of data.uses) {
      if (!Array.isArray(item) || item.length !== 7) return;
      const [parentId, childId, file, offset, end, start, finish] = item;
      const parent = byId.get(parentId), child = byId.get(childId);
      const validPosition = (value: unknown): value is [number, number] => Array.isArray(value) && value.length === 2 &&
        value.every(n => Number.isSafeInteger(n) && n >= 0);
      if (!parent || !child || typeof file !== 'string' || !parent.files.includes(file) || !known(file) ||
        !Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || offset < 0 || end < offset ||
        (files && end > files.get(file)!.length) || !validPosition(start) || !validPosition(finish) ||
        (files && (JSON.stringify(start) !== JSON.stringify(positionFromText(files.get(file)!, offset)) ||
          JSON.stringify(finish) !== JSON.stringify(positionFromText(files.get(file)!, end))))) return;
      uses.push({ parent, child, file, offset, end });
      locations.push({ start, end: finish });
    }
    return { analysis: { components, uses, warnings: data.warnings, information: data.information }, locations };
  } catch { return; }
}

function positionFromText(text: string, offset: number): [number, number] {
  const prefix = text.slice(0, offset);
  const line = prefix.split('\n').length - 1;
  return [line, offset - (prefix.lastIndexOf('\n') + 1)];
}

export function decodeIndex(text: string, files: Map<string, string>): Analysis | undefined {
  return decode(text, files)?.analysis;
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

  async loadProvisional(manifest: Manifest): Promise<StoredIndex | undefined> {
    try { return decode(await readFile(this.file, 'utf8'), undefined, manifest); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }

  save(files: Map<string, string>, result: Analysis, manifest?: Manifest): Promise<void> {
    const text = encodeIndex(files, result, manifest);
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
