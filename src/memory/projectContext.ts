/**
 * Project Context Store - L0 Memory Layer (P1 priority).
 *
 * Stores and retrieves project-level metadata that should always be
 * available at session start. This includes tool listings, module
 * structure, and architecture summaries.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface ProjectContext {
  projectId: string;
  name: string;
  description?: string;
  tools?: string[];
  modules?: string[];
  architectureSummary?: string;
  metadata?: Record<string, unknown>;
}

/** Render project context as a string for injection into prompt. */
export function projectContextToString(ctx: ProjectContext): string {
  const parts: string[] = [`Project: ${ctx.name}`];
  if (ctx.description) parts.push(`Description: ${ctx.description}`);
  if (ctx.tools?.length) parts.push(`Available tools: ${ctx.tools.join(', ')}`);
  if (ctx.modules?.length) parts.push(`Modules: ${ctx.modules.join(', ')}`);
  if (ctx.architectureSummary) parts.push(`Architecture: ${ctx.architectureSummary}`);
  return parts.join('\n');
}

export class ProjectContextStore {
  private store: Map<string, ProjectContext> = new Map();
  private readonly storagePath: string | null;

  constructor(storagePath?: string) {
    this.storagePath = storagePath ?? null;
    if (this.storagePath && fs.existsSync(this.storagePath)) {
      this.loadFromFile(this.storagePath);
    }
  }

  private loadFromFile(filePath: string): void {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data: Record<string, Omit<ProjectContext, 'projectId'>> = JSON.parse(raw);
    for (const [projectId, info] of Object.entries(data)) {
      this.store.set(projectId, { projectId, ...info });
    }
  }

  register(context: ProjectContext): void {
    this.store.set(context.projectId, context);
    this.persist();
  }

  get(projectId: string): ProjectContext | undefined {
    return this.store.get(projectId);
  }

  remove(projectId: string): boolean {
    const existed = this.store.delete(projectId);
    if (existed) this.persist();
    return existed;
  }

  listProjects(): string[] {
    return [...this.store.keys()];
  }

  private persist(): void {
    if (!this.storagePath) return;
    const data: Record<string, Omit<ProjectContext, 'projectId'>> = {};
    for (const [id, ctx] of this.store.entries()) {
      const { projectId, ...rest } = ctx;
      data[id] = rest;
    }
    const dir = path.dirname(this.storagePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.storagePath, JSON.stringify(data, null, 2), 'utf-8');
  }
}
