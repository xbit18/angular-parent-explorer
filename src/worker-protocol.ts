import type { Analysis } from './analyzer';
import type { MemorySnapshot } from './memory';
import type { Manifest } from './index-storage';

export interface Location { start: [number, number]; end: [number, number] }
export interface WorkerResult {
  analysis: Analysis;
  locations: Location[];
  restored: boolean;
  provisional?: boolean;
  files: number;
  analysisMs: number;
  before: MemorySnapshot;
  after: MemorySnapshot;
  diskError?: string;
}
export interface Request {
  id: number;
  changes: Map<string, string>;
  deleted: string[];
  initial: boolean;
  rebuild: boolean;
  storageFile?: string;
  manifest?: Manifest;
  provisional?: boolean;
}
export type Progress = { kind: 'progress'; messages: string[] };
export type Reply = { id: number; progress: Progress } | { id: number; result: WorkerResult } | { id: number; error: string };
