import type { Analysis } from './analyzer';
import type { MemorySnapshot } from './memory';

export interface Location { start: [number, number]; end: [number, number] }
export interface WorkerResult {
  analysis: Analysis;
  locations: Location[];
  restored: boolean;
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
}
export type Reply = { id: number; result: WorkerResult } | { id: number; error: string };
