import * as vscode from 'vscode';
import path from 'node:path';
import type { Analysis, Component, Use } from './analyzer';
import { formatDuration, ViewState } from './view-state';
import { formatMemory } from './memory';
import { WorkerClient } from './worker-client';
import type { Location, WorkerResult } from './worker-protocol';
import type { Manifest } from './index-storage';

type Entry = Component | Use | string;
export class Parents implements vscode.TreeDataProvider<Entry>, vscode.Disposable {
  constructor(private readonly worker = new WorkerClient(path.resolve('dist/analysis-worker.cjs'))) {}
  private expansion = vscode.TreeItemCollapsibleState.Collapsed;
  private expansionRevision = 0;
  setExpanded(expanded: boolean): void {
    this.expansion = expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
    ++this.expansionRevision;
    this.refreshView();
  }
  rebuildIndex(): Promise<void> { return this.scan(false, true); }
  private readonly state = new ViewState();
  pin(): void {
    const owners = this.owners();
    this.state.togglePin(owners.length === 1 ? owners[0] : undefined);
    void vscode.commands.executeCommand('setContext', 'angularParents.pinned', !!this.state.pinnedId);
    this.refreshView();
  }
  async filter(): Promise<void> {
    const value = await vscode.window.showInputBox({ title: 'Filter parent components',
      prompt: 'Component name contains (leave empty to clear)', value: this.state.filter });
    if (value === undefined) return;
    this.state.filter = value.trim();
    void vscode.commands.executeCommand('setContext', 'angularParents.filtered', !!this.state.filter);
    this.refreshView();
  }
  clearFilter(): void {
    this.state.filter = '';
    void vscode.commands.executeCommand('setContext', 'angularParents.filtered', false);
    this.refreshView();
  }
  showOutput(): void { this.output.show(true); }
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly known = new Set<string>();
  private readonly pending = new Map<string, string | undefined>();
  private readonly fileRevisions = new Map<string, number>();
  private initialized = false;
  private disposed = false;
  private locations: Location[] = [];
  private readonly consumers = new Map<string, Use[]>();
  private result: Analysis = { components: [], uses: [], warnings: [], information: [] };
  view?: vscode.TreeView<Entry>;
  private duration = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private revision = 0;
  private busy = false;
  private verifying = false;
  private error?: string;
  private readonly output = vscode.window.createOutputChannel('Angular Parents');

  dispose(): void { this.disposed = true; ++this.revision; clearTimeout(this.timer); this.worker.dispose(); this.changed.dispose(); this.output.dispose(); }
  refreshView(): void {
    if (this.view) {
      const owners = this.owners();
      this.view.title = owners.length === 1 ? owners[0].name : 'Angular Parents';
      const uses = owners.length === 1 ? this.consumers.get(owners[0].id) ?? [] : [];
      this.view.description = `${this.state.pinnedId ? 'Pinned · ' : ''}${this.verifying ? 'Verifying…' : this.busy ? 'Updating…' : this.error ? 'Index unavailable' : `Ready · ${formatDuration(this.duration)}`}`;
      this.view.message = [owners.length === 1 ? `${new Set(uses.map(use => use.parent.id)).size} parents · ${uses.length} occurrences` : '',
        this.state.filter ? `Filter: ${this.state.filter}` : '',
        this.error ? 'Index update failed. Previous results shown; see Show Diagnostics.' : ''].filter(Boolean).join('\n') || undefined;
    }
    this.changed.fire();
  }
  schedule(): void {
    ++this.revision;
    this.busy = true; this.refreshView();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flushChanges(); }, 250);
  }
  update(document: vscode.TextDocument): void {
    if (!vscode.workspace.getWorkspaceFolder(document.uri) || !/\.(ts|html|json)$/.test(document.fileName)) return;
    this.fileRevisions.set(document.uri.fsPath, (this.fileRevisions.get(document.uri.fsPath) ?? 0) + 1);
    this.pending.set(document.uri.fsPath, document.getText());
    this.schedule();
  }
  changedFile(uri: vscode.Uri, deleted = false): void {
    const generation = (this.fileRevisions.get(uri.fsPath) ?? 0) + 1;
    this.fileRevisions.set(uri.fsPath, generation);
    if (deleted) this.pending.set(uri.fsPath, undefined);
    else {
      const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
      if (open) this.pending.set(uri.fsPath, open.getText());
      else { void Promise.resolve(vscode.workspace.fs.readFile(uri)).then(data => {
        if (this.disposed || this.fileRevisions.get(uri.fsPath) !== generation) return;
        this.pending.set(uri.fsPath, new TextDecoder().decode(data)); this.schedule();
      }).catch(() => this.scheduleScan()); return; }
    }
    this.schedule();
  }
  async scan(useDisk = false, rebuild = false): Promise<void> {
    if (this.disposed) return;
    const started = performance.now();
    const revision = ++this.revision;
    const current = (): boolean => revision === this.revision && !this.disposed;
    const log = (message: string): void => { if (current()) this.output.appendLine(message); };
    const phase = (label: string): (() => void) => {
      log(`${label}: begin`);
      const start = performance.now();
      return () => log(`${label}: end (${formatDuration(performance.now() - start)})`);
    };
    const diagnostics = new Set<string>();
    const progress = ({ messages }: { messages: string[] }): void => {
      for (const message of messages) {
        // A provisional restore and exact validation may report the same diagnostic.
        const key = message.replace(/^\[cached (info|incomplete)\]/, '[$1]');
        if (!diagnostics.has(key)) { diagnostics.add(key); log(message); }
      }
    };
    this.busy = true; this.verifying = false; this.error = undefined; this.refreshView();
    try {
      const endDiscovery = phase('File discovery');
      let uris: vscode.Uri[];
      try { uris = await vscode.workspace.findFiles('**/*.{ts,html,json}', '**/{node_modules,dist,out,coverage,.git}/**'); }
      finally { endDiscovery(); }
      const manifest: Manifest = new Map();
      if (useDisk && !rebuild) {
        const endManifest = phase('Manifest collection');
        try {
          let cursor = 0;
          let failed: unknown;
          // Bound outstanding metadata operations; all started workers settle before fallback.
          await Promise.all(Array.from({ length: Math.min(8, uris.length) }, async () => {
            while (cursor < uris.length && !failed) {
              const uri = uris[cursor++];
              try {
                const stat = await vscode.workspace.fs.stat(uri);
                manifest.set(uri.fsPath, { size: stat.size, mtime: stat.mtime });
              } catch (error) { failed = error; }
            }
          }));
          if (failed) throw failed;
          endManifest();
          if (current() && !this.initialized && !vscode.workspace.textDocuments.some(doc =>
            uris.some(uri => uri.toString() === doc.uri.toString()) && doc.isDirty)) {
            const endProvisional = phase('Provisional cache request (including worker startup/queue)');
            try {
              const cached = await this.worker.submit(new Map(), [], true, false, manifest, true, progress);
              endProvisional();
              if (current()) {
                log(`First results published (not browser paint): ${formatDuration(performance.now() - started)}`);
                this.publish(cached, performance.now() - started, 'Provisional summary');
                this.verifying = true; this.busy = true; this.refreshView();
              }
            } catch (error) {
              endProvisional();
              log(`Provisional cache skipped: ${String(error)}. Reading workspace files.`);
            }
          }
        } catch (error) {
          endManifest();
          log(`Workspace metadata unavailable: ${String(error)}. Reading workspace files.`);
          manifest.clear();
        }
      }
      const endRead = phase('Workspace read/validation');
      const next = new Map<string, string>();
      const listed = new Set(uris.map(uri => uri.fsPath));
      try {
        for (const uri of uris) {
          if (this.initialized && !rebuild && this.known.has(uri.fsPath) && !this.pending.has(uri.fsPath)) continue;
          const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
          next.set(uri.fsPath, open ? open.getText() : new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
        }
      } finally { endRead(); }
      if (revision !== this.revision || this.disposed) return;
      for (const [file, text] of this.pending) {
        if (text === undefined || !listed.has(file)) next.delete(file);
        else next.set(file, text);
      }
      const removed = [...this.known].filter(file => !listed.has(file));
      this.pending.clear();
      const endAnalysis = phase('Worker analysis/exact restore');
      const result = await this.worker.submit(next, removed, !this.initialized, rebuild || (!useDisk && !this.initialized),
        manifest.size === uris.length ? manifest : undefined, false, progress).finally(endAnalysis);
      if (revision !== this.revision || this.disposed) return;
      this.initialized = true;
      this.known.clear(); for (const file of listed) this.known.add(file);
      this.publish(result, performance.now() - started - result.analysisMs, 'Final summary');
    } catch (error) {
      if (revision === this.revision && !this.disposed) { this.error = String(error); this.output.appendLine(`Exact validation failed: ${this.error}. Rebuild Index to retry.`); }
    } finally {
      if (revision === this.revision && !this.disposed) { this.verifying = false; this.busy = false; this.refreshView(); }
    }
  }
  scheduleScan(): void {
    ++this.revision; clearTimeout(this.timer);
    this.busy = true; this.refreshView();
    this.timer = setTimeout(() => { void this.scan(); }, 250);
  }
  private async flushChanges(): Promise<void> {
    if (this.disposed) return;
    if (!this.initialized) { await this.scan(true); return; }
    const revision = this.revision;
    const changes = new Map<string, string>();
    const deleted: string[] = [];
    for (const [file, text] of this.pending) {
      if (text === undefined) deleted.push(file);
      else changes.set(file, text);
    }
    this.pending.clear();
    if (!changes.size && !deleted.length) { this.busy = false; this.refreshView(); return; }
    try {
      const diagnostics = new Set<string>();
      const result = await this.worker.submit(changes, deleted, false, false, undefined, false, ({ messages }) => {
        if (revision !== this.revision || this.disposed) return;
        for (const message of messages) {
          if (diagnostics.has(message)) continue;
          diagnostics.add(message); this.output.appendLine(message);
        }
      });
      if (revision !== this.revision || this.disposed) return;
      for (const file of deleted) this.known.delete(file);
      for (const file of changes.keys()) this.known.add(file);
      this.publish(result, 0, 'Final summary');
    } catch (error) {
      if (revision === this.revision && !this.disposed) { this.error = String(error); this.output.appendLine(this.error); }
    } finally { if (revision === this.revision && !this.disposed) { this.busy = false; this.refreshView(); } }
  }
  private publish(result: WorkerResult, readMs: number, summary: string): void {
      this.result = result.analysis;
      this.locations = result.locations;
      this.consumers.clear();
      for (const use of this.result.uses) {
        const uses = this.consumers.get(use.child.id) ?? [];
        uses.push(use); this.consumers.set(use.child.id, uses);
      }
      this.error = undefined;
      this.output.appendLine(`${summary}:`);
      this.output.appendLine(`Memory before analysis/restore (process RSS; worker heap): ${formatMemory(result.before)}`);
      this.output.appendLine(`Memory after analysis/restore (process RSS; worker heap): ${formatMemory(result.after)}`);
      this.output.appendLine('RSS is shared by all threads; worker heap is local. Samples are not peaks or extension-only attribution.');
      this.duration = Math.max(0, readMs) + result.analysisMs;
      this.output.appendLine(`Index: ${result.files} files, ${this.result.components.length} components, ${this.result.uses.length} occurrences`);
      this.output.appendLine(`Read/validation: ${formatDuration(Math.max(0, readMs))}; analysis: ${formatDuration(result.analysisMs)}; total: ${formatDuration(this.duration)}`);
      this.output.appendLine(result.provisional ? 'Disk index: provisional; exact content validation pending.' :
        result.restored ? 'Disk index: reused after exact content validation.' : 'Disk index: live analysis (cache missing, changed, bypassed or unavailable).');
      if (result.diskError) this.output.appendLine(`Disk cache unavailable: ${result.diskError}`);
    this.busy = false; this.refreshView();
  }
  getChildren(entry?: Entry): Entry[] {
    if (entry && typeof entry !== 'string' && !('parent' in entry)) {
      const owners = this.owners();
      return owners.flatMap(c => this.consumers.get(c.id) ?? []).filter(use => use.parent.id === entry.id);
    }
    if (entry) return [];
    if (this.busy && !this.result.components.length) return ['Indexing Angular components…'];
    if (this.error && !this.result.components.length) return ['Index unavailable. See Angular Parents output.'];
    const owners = this.owners();
    if (!owners.length) return [this.state.pinnedId ? 'Pinned component is no longer indexed. Unpin to follow the editor.' :
      vscode.window.activeTextEditor ? 'No indexed standalone component owns this file. Open its TypeScript file or check diagnostics.' :
        'Open a standalone component, template or stylesheet.'];
    if (owners.length > 1) return ['Shared file: open the component TypeScript file to choose its owner.'];
    const parents = new Map((this.consumers.get(owners[0].id) ?? []).map(use => [use.parent.id, use.parent]));
    const entries: Entry[] = [...parents.values()].filter(parent => this.state.matches(parent.name)).sort((a, b) => a.name.localeCompare(b.name));
    if (!entries.length) entries.push(parents.size ? 'No parent components match the filter.' : 'No direct parents found.');
    return entries;
  }
  private owners(): Component[] {
    const file = vscode.window.activeTextEditor?.document.uri.fsPath;
    return this.state.owners(this.result.components, file);
  }
  getTreeItem(entry: Entry): vscode.TreeItem {
    if (typeof entry === 'string') {
      const item = new vscode.TreeItem(entry);
      if (/diagnostics|analysis|Workspace:/.test(entry)) {
        item.command = { command: 'angularParents.diagnostics', title: 'Open diagnostics' };
        item.tooltip = 'Diagnostics are attributed to indexed files only; unresolved scopes may affect other components.';
      }
      return item;
    }
    if ('parent' in entry) {
      const index = this.result.uses.indexOf(entry);
      const { start: [line, column], end: [endLine, endColumn] } = this.locations[index] ?? { start: [0, 0], end: [0, 0] };
      const item = new vscode.TreeItem(`${path.basename(entry.file)}:${line + 1}`);
      item.description = vscode.workspace.asRelativePath(path.dirname(entry.file));
      item.resourceUri = vscode.Uri.file(entry.file);
      item.iconPath = vscode.ThemeIcon.File;
      item.tooltip = `${entry.file}:${line + 1}:${column + 1}\n${entry.parent.name} → ${entry.child.name}`;
      item.command = { command: 'vscode.open', title: 'Open usage', arguments: [vscode.Uri.file(entry.file),
        { selection: new vscode.Range(line, column, endLine, endColumn) }] };
      return item;
    }
    const item = new vscode.TreeItem(entry.name, this.expansion);
    item.id = `${this.owners()[0]?.id ?? ''}:${this.expansionRevision}:${entry.id}`;
    item.description = vscode.workspace.asRelativePath(entry.file);
    const occurrences = (this.consumers.get(this.owners()[0]?.id ?? '') ?? []).filter(use => use.parent.id === entry.id).length;
    item.tooltip = `${entry.name}\n${entry.file}\n${occurrences} occurrences`;
    return item;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const storage = context.storageUri?.scheme === 'file' ? path.join(context.storageUri.fsPath, 'index-v1.json') : undefined;
  const provider = new Parents(new WorkerClient(path.join(context.extensionPath, 'dist', 'analysis-worker.cjs'), storage));
  const view = vscode.window.createTreeView('angularParents', { treeDataProvider: provider });
  provider.view = view;
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{ts,html,json}');
  context.subscriptions.push(provider, watcher,
    view,
    vscode.commands.registerCommand('angularParents.refresh', () => provider.rebuildIndex()),
    vscode.commands.registerCommand('angularParents.collapseAll', () => provider.setExpanded(false)),
    vscode.commands.registerCommand('angularParents.expandAll', () => provider.setExpanded(true)),
    vscode.commands.registerCommand('angularParents.pin', () => provider.pin()),
    vscode.commands.registerCommand('angularParents.unpin', () => provider.pin()),
    vscode.commands.registerCommand('angularParents.filter', () => provider.filter()),
    vscode.commands.registerCommand('angularParents.clearFilter', () => provider.clearFilter()),
    vscode.commands.registerCommand('angularParents.diagnostics', () => provider.showOutput()),
    vscode.window.onDidChangeActiveTextEditor(() => provider.refreshView()),
    vscode.workspace.onDidChangeTextDocument(event => provider.update(event.document)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.scheduleScan()),
    watcher.onDidCreate(uri => provider.changedFile(uri)),
    watcher.onDidDelete(uri => provider.changedFile(uri, true)),
    watcher.onDidChange(uri => provider.changedFile(uri)));
  void provider.scan(true);
}
