import { Component } from './analyzer';

export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60000) return `${(milliseconds / 1000).toFixed(1)} s`;
  const seconds = Math.round(milliseconds / 1000);
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/** Session-only navigation state; pinned identities are resolved against each fresh index. */
export class ViewState {
  pinnedId?: string;
  filter = '';

  owners(components: Component[], activeFile?: string): Component[] {
    return components.filter(component => this.pinnedId
      ? component.id === this.pinnedId : component.files.includes(activeFile ?? ''));
  }

  togglePin(owner?: Component): void {
    this.pinnedId = this.pinnedId ? undefined : owner?.id;
  }

  matches(name: string): boolean {
    return name.toLowerCase().includes(this.filter.trim().toLowerCase());
  }

  contextualWarnings(warnings: string[], owner: Component, parents: Component[]): string[] {
    const files = new Set([owner, ...parents].flatMap(component => component.files));
    return warnings.filter(warning => [...files].some(file => warning.startsWith(`${file}:`)));
  }
}
