import { Worker } from 'node:worker_threads';
import type { Progress, Reply, Request, WorkerResult } from './worker-protocol';
import type { Manifest } from './index-storage';

interface Waiter { resolve: (result: WorkerResult) => void; reject: (error: Error) => void; progress?: (event: Progress) => void }

export class WorkerClient {
  private readonly worker: Worker;
  private nextId = 0;
  private active?: { id: number; waiters: Waiter[] };
  private queued?: { changes: Map<string, string>; deleted: Set<string>; initial: boolean; rebuild: boolean; manifest?: Manifest; provisional: boolean; waiters: Waiter[] };
  private failure?: Error;

  constructor(entry: string, private readonly storageFile?: string) {
    this.worker = new Worker(entry);
    this.worker.on('message', (reply: Reply) => {
      if (this.failure || reply.id !== this.active?.id) return;
      const current = this.active;
      if ('progress' in reply) {
        current.waiters.forEach(waiter => waiter.progress?.(reply.progress));
        return;
      }
      this.active = undefined;
      if ('error' in reply) current.waiters.forEach(waiter => waiter.reject(new Error(reply.error)));
      else current.waiters.forEach(waiter => waiter.resolve(reply.result));
      this.flush();
    });
    this.worker.on('error', error => this.fail(error));
    this.worker.on('exit', code => this.fail(new Error(`Analysis worker exited (${code})`)));
  }

  submit(changes: Map<string, string>, deleted: string[], initial: boolean, rebuild = false,
    manifest?: Manifest, provisional = false, progress?: (event: Progress) => void): Promise<WorkerResult> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<WorkerResult>((resolve, reject) => {
      if (!this.queued || initial) this.queued = { changes: new Map(), deleted: new Set(), initial, rebuild,
        manifest, provisional, waiters: this.queued?.waiters ?? [] };
      const pending = this.queued;
      pending.rebuild ||= rebuild;
      pending.manifest = manifest;
      pending.provisional = provisional;
      for (const file of deleted) { pending.changes.delete(file); pending.deleted.add(file); }
      for (const [file, text] of changes) { pending.deleted.delete(file); pending.changes.set(file, text); }
      pending.waiters.push({ resolve, reject, progress });
      this.flush();
    });
  }

  private flush(): void {
    if (this.active || !this.queued || this.failure) return;
    const pending = this.queued;
    this.queued = undefined;
    const id = ++this.nextId;
    this.active = { id, waiters: pending.waiters };
    const request: Request = { id, changes: pending.changes, deleted: [...pending.deleted],
      initial: pending.initial, rebuild: pending.rebuild, storageFile: this.storageFile,
      manifest: pending.manifest, provisional: pending.provisional };
    try { this.worker.postMessage(request); }
    catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.active?.waiters.forEach(waiter => waiter.reject(error));
    this.queued?.waiters.forEach(waiter => waiter.reject(error));
    this.active = undefined; this.queued = undefined;
  }

  dispose(): void { this.fail(new Error('Analysis worker disposed')); void this.worker.terminate(); }
}
