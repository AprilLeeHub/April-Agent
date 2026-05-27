import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ProjectContextStore, ProjectContext, projectContextToString } from '../src/memory/projectContext';

describe('projectContextToString', () => {
  it('should render project context', () => {
    const ctx: ProjectContext = {
      projectId: 'test',
      name: 'TestProject',
      tools: ['retry', 'agent'],
      modules: ['src.retry', 'src.agent'],
    };
    const result = projectContextToString(ctx);
    expect(result).toContain('TestProject');
    expect(result).toContain('retry');
    expect(result).toContain('agent');
  });
});

describe('ProjectContextStore', () => {
  it('should register and get', () => {
    const store = new ProjectContextStore();
    const ctx: ProjectContext = { projectId: 'p1', name: 'Project1', tools: ['tool_a'] };
    store.register(ctx);
    const retrieved = store.get('p1');
    expect(retrieved).toBeDefined();
    expect(retrieved!.name).toBe('Project1');
    expect(retrieved!.tools).toEqual(['tool_a']);
  });

  it('should return undefined for missing project', () => {
    const store = new ProjectContextStore();
    expect(store.get('nonexistent')).toBeUndefined();
  });

  it('should remove', () => {
    const store = new ProjectContextStore();
    store.register({ projectId: 'p1', name: 'P1' });
    expect(store.remove('p1')).toBe(true);
    expect(store.get('p1')).toBeUndefined();
    expect(store.remove('p1')).toBe(false);
  });

  it('should persist and reload', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'april-test-'));
    const filePath = path.join(tmpDir, 'projects.json');
    try {
      const store = new ProjectContextStore(filePath);
      store.register({ projectId: 'p1', name: 'Persisted', tools: ['t1'] });

      const store2 = new ProjectContextStore(filePath);
      const ctx = store2.get('p1');
      expect(ctx).toBeDefined();
      expect(ctx!.name).toBe('Persisted');
      expect(ctx!.tools).toEqual(['t1']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('should list projects', () => {
    const store = new ProjectContextStore();
    store.register({ projectId: 'a', name: 'A' });
    store.register({ projectId: 'b', name: 'B' });
    expect(store.listProjects().sort()).toEqual(['a', 'b']);
  });
});
