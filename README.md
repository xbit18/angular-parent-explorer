# Angular Parent Explorer

### Memory observations

Analyzer cache signatures are compact SHA-256 hashes. Values are streamed into the hash with type/length framing rather than serializing whole components and templates into retained keys. Source contents and analyzer caches remain in the worker heap; the host retains compact navigation results. This is not a disk-only index.

The Angular Parents Output reports process-wide RSS and worker-local JavaScript heap/external memory before/after analysis or restoration. These are samples, not peak measurements or extension-only attribution. Garbage collection can affect comparisons.

`npm run benchmark -- <project-directory>` also reports memory before/after reading files and each cold/warm analysis in its JSON output. The benchmark runs in a separate process and does not force garbage collection. Use identical inputs and runtime versions for comparisons. No cache behavior is changed by this instrumentation.

A local-development VS Code extension showing direct template consumers of standalone Angular components. This is an initial prototype, not a complete Angular 19+ compatibility release.

## Run it

1. Run `npm ci`, then `npm run check` and `npm run build`.
2. Open this folder in VS Code and press **F5** (Run Angular Parent Explorer).
3. In the Extension Development Host, open an Angular workspace.
4. Open a component `.ts`, `.html` or stylesheet and expand **Angular Parents** in Explorer.
5. Click an occurrence to open its parent template. The view follows that parent automatically.

Use **Angular Parents: Rebuild Index** to force a refresh. Unsupported metadata and parsing problems appear in the **Angular Parents** output channel.

## Current support

- Standalone components with literal `@Component` metadata and default Angular 19+ standalone semantics.
- Named component imports, including TypeScript path aliases and renamed imports.
- Wildcard and named barrel re-exports, with cycle protection; nearest `tsconfig.json` options and inherited configuration.
- Literal `imports` arrays; external and unescaped inline templates.
- Angular selector matching for elements, static attributes and bound attribute names.
- Direct consumer grouping and exact opening-tag navigation.
- Worker-owned in-memory metadata/template caches, reverse consumer lookup, debounced dirty-document updates and filesystem refresh.
- External `styleUrl` and `styleUrls` ownership, including shared-file ambiguity reporting.

## Boundaries

Default/namespace imports, local component references, spread imports, computed metadata, NgModule scopes, dynamic creation and escaped inline templates are not yet resolved. Local export lists without a module specifier and ambiguous wildcard exports are not fully supported. Configuration must be present inside the scanned workspace; external configuration packages are not loaded. Results can be incomplete; the view is not proof of absence of usages. No project code is executed.

The bundled parser is Angular compiler 21.2.26 or a compatible patched version. Parsing Angular 19 syntax is covered only by the fixture tests so far; a real version matrix and Extension Host integration tests remain pending. Projects do not need to install this parser themselves.

Unchanged templates reuse cached matches. Selector/import changes invalidate dependent keys. TypeScript/configuration edits conservatively invalidate metadata to avoid stale barrel resolution. After the initial workspace read, editor and filesystem changes send only changed file contents to a bundled Node worker. The worker owns analysis, source text and disk index validation/writes; the host owns discovery, TreeView and compact occurrence positions. A workspace-folder rescan discovers new and deleted paths. A validated navigation index is persisted on disk. This does not promise lower startup time or process RSS.

## Checks

```sh
npm test
npm run check
npm run build
npm audit
```

Tests cover direct uses versus unused imports, aliases, external templates, attribute selectors, non-standalone exclusion, diagnostic classification, cache invalidation and a real bundled worker. The latest native UI changes still require visual confirmation in the Extension Host. The benchmark exercises the standalone analyzer, not worker transport or Extension Host responsiveness.

## Index diagnostics and timing

### Native view controls

The **…** menu contains **Collapse All** and **Expand All**, acting on parent rows
without opening files. Indexing durations use milliseconds below one second,
seconds below one minute, then minutes and seconds (for example `48.5 s`).

### Disk index

The extension automatically saves `index-v1.json` under VS Code's per-workspace
extension storage, outside the project. It stores component names, paths, ownership,
occurrence ranges and diagnostics, not template source. Treat it as local project
metadata. No index is uploaded or added to the repository.

On startup it rereads workspace files (preferring unsaved editor contents) and checks
a full-content fingerprint, schema/parser versions and integrity checksum before
reusing navigation data. Added, deleted, edited or moved files invalidate the cache.
Cache corruption or I/O failure falls back to live analysis. Saves are serialized
and atomically replace the last index; write failures leave the in-memory view usable.
**Rebuild Index** bypasses the disk index and rebuilds the in-memory analyzer caches.
When VS Code has no local workspace storage, indexing remains memory-only.

This avoids repeated analysis on an unchanged restart, not the initial file reads;
it does not persist fine-grained analyzer caches. Analysis and storage hashing run off the host thread.
Disk write time is not part of the displayed read/analysis duration.

Parents start collapsed; expand one to see its occurrences. Counts are in the
parent tooltip, not appended to component names. Occurrences use the active file
icon theme (including Material Icon Theme); inline templates retain TypeScript icons.

Use the toolbar pin to keep the current component while navigating. Unpin to
follow the editor again. Pin and filter are session-only. Search opens a native
input field and applies a case-insensitive component-name substring filter;
cancel leaves the filter unchanged, and **Clear Filter** restores all parents.
The view message shows the active filter; overall counts remain unfiltered.

Existing results remain visible during updates. Related diagnostics are attributed
to the current component and its resolved parents by indexed file path. Other
workspace diagnostics are separate, not a guarantee that unresolved scopes cannot
affect this component. Click diagnostic rows or use **Show Diagnostics** in the
view menu. Empty states distinguish an unrecognized file, no resolved parents,
an incomplete related analysis, and a filter without matches.

The native view shows the active component, direct-parent and occurrence counts,
update state, last indexing duration, and compact occurrence labels with full-path tooltips.
Restart the Extension Development Host after rebuilding to load these changes.

Open **Output → Angular Parents** for file/component/occurrence counts and
discovery/read, analysis, and total durations. Editor-only updates report zero read time.
Known Angular common/forms/router imports are informational; unresolved local imports,
uninspected external dependencies, and unsupported metadata/templates still mark the
workspace analysis incomplete. This warning is workspace-wide, not proof that the active
component has missing parents. External packages are not inspected or executed.

Run a read-only benchmark:

```sh
npm run benchmark -- <project-directory>
```

It prints JSON for cold analysis (including discovery/read time) and warm analysis
of the same unchanged in-memory files/cache (no reread). It does not measure edit
latency, Extension Host rendering, or guarantee complete Angular coverage.
Symlinks and dependency/build/cache directories are skipped.
