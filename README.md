# Angular Parent Explorer

## Private VSIX evaluation

Run `npm ci`, `npm test`, `npm run check`, then `npm run package:private`.
Packaging uses pinned VSCE 4.1.0 through npm's tool cache and may require network access.
It builds both runtime bundles, includes dependency notices and excludes sources, tests and local indexes.
This command creates a local VSIX; it does not publish, authenticate or change versions.

Install using **Extensions → Install from VSIX…** in a disposable VS Code profile.
Test first startup, restored startup, unsaved templates, branch changes, deletions,
pin/filter controls, navigation and Rebuild Index. Record failures before wider distribution.
The private preview retains the local publisher placeholder and does not select an extension license.
Public distribution still requires an explicit license and publisher decision.

Compatibility is not yet established across the declared VS Code range: the bundled Angular compiler
requires Node 20.19+, 22.12+ or 24+, while older extension hosts may use an earlier runtime.
The local packaging/install check is not an Extension Host execution test or Angular version matrix.
Workspace Trust behavior and worker recovery also remain pre-release checks.

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

Use **Rebuild Index** to force a full refresh. Unsupported metadata and parsing problems appear in the **Angular Parents** output channel.

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

Unchanged templates reuse cached matches. Selector/import changes invalidate dependent keys. TypeScript/configuration edits conservatively invalidate metadata to avoid stale barrel resolution. After the initial workspace read, editor and filesystem changes send only changed file contents to a bundled Node worker. The worker owns analysis, source text and disk index validation/writes; the host owns discovery, TreeView and compact occurrence positions. A workspace-folder rescan discovers new and deleted paths. A navigation index is persisted on disk. Startup can show provisional cached results before reading every file; this does not promise lower process RSS.

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

On startup, file inventory and size/mtime metadata can admit the versioned,
checksummed cache as **provisional**. Stored line/column positions permit accurate
navigation for that snapshot without retaining template source in the cache. The
view says **Verifying…** while all workspace contents are read and exactly checked;
only then can it say **Ready**. A same-size/same-mtime edit is detected by this
background validation. Dirty open documents use their actual text, never the
provisional disk snapshot. Added/deleted files, metadata changes, missing/old/corrupt
caches, or unavailable metadata fall back to the full read and analysis. Failed exact
validation retains the previous result and reports a diagnostic; use **Rebuild Index**
to retry. Saves are serialized and atomically replace the last index; write failures
leave the in-memory view usable. **Rebuild Index** bypasses the disk index and clears
the in-memory analyzer caches. After an incremental editor update, the saved snapshot
has no trustworthy file manifest, so a subsequent restart uses the cold path.
When VS Code has no local workspace storage, indexing remains memory-only.

This permits earlier provisional navigation on an unchanged restart, not elimination of initial file reads;
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

Open **Output → Angular Parents** for chronological phase begin/end events, analysis
diagnostics as files are processed, and separate provisional/final summaries with
file/component/occurrence counts and durations. Logs are appended, never cleared on
publication. Cached diagnostics are labeled as cached; a restored snapshot is not
presented as fresh analysis. Editor-only updates report zero read time.
Known imported Angular common/forms/router dependencies are informational: they are
excluded from workspace component matching, NOT excluded files from the scan. Unresolved local imports,
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

Startup phase events separate File discovery, Manifest collection (up to eight concurrent
metadata requests), Provisional cache request, Workspace read/validation, and worker
analysis/exact restore. First results published measures provider availability, not
VS Code rendering. Phase events remain in their original position after final validation.

