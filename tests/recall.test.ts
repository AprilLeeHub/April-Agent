import { MemoryRecaller, UserPreferences, recalledContextToMessages } from '../src/memory/recall';
import { ProjectContextStore } from '../src/memory/projectContext';
import { KnowledgeEntry, KnowledgeStore } from '../src/memory/knowledge';
import { TokenBudget } from '../src/memory/tokenBudget';

function setup() {
  const projectStore = new ProjectContextStore();
  projectStore.register({
    projectId: 'proj1',
    name: 'TestProject',
    tools: ['retry', 'agent'],
    modules: ['src.retry', 'src.agent'],
  });

  const knowledgeStore = new KnowledgeStore();
  knowledgeStore.add(new KnowledgeEntry({
    id: 'k1',
    content: 'retry module handles exponential backoff',
    projectId: 'proj1',
    confidence: 0.9,
    accessCount: 5,
  }));
  knowledgeStore.add(new KnowledgeEntry({
    id: 'k2',
    content: 'agent module uses ReAct pattern',
    projectId: 'proj1',
    confidence: 0.8,
    accessCount: 3,
  }));

  const budget = new TokenBudget({ total: 10_000, systemPrompt: 0 });
  return { projectStore, knowledgeStore, budget };
}

describe('MemoryRecaller', () => {
  it('should recall project context', () => {
    const { projectStore, knowledgeStore, budget } = setup();
    const recaller = new MemoryRecaller(projectStore, knowledgeStore, budget);
    const result = recaller.recall({ projectId: 'proj1' });
    expect(result.projectContext).not.toBeNull();
    expect(result.projectContext!.name).toBe('TestProject');
  });

  it('should recall user preferences', () => {
    const { projectStore, knowledgeStore, budget } = setup();
    const recaller = new MemoryRecaller(projectStore, knowledgeStore, budget);
    const prefs: UserPreferences = { userId: 'u1', language: 'en' };
    const result = recaller.recall({ projectId: 'proj1', userPrefs: prefs });
    expect(result.userPreferences).not.toBeNull();
    expect(result.userPreferences!.language).toBe('en');
  });

  it('should recall task patterns with similarity', () => {
    const { projectStore, knowledgeStore, budget } = setup();
    const recaller = new MemoryRecaller(projectStore, knowledgeStore, budget);
    const result = recaller.recall({
      projectId: 'proj1',
      firstMessage: 'tell me about retry and backoff',
    });
    expect(result.taskPatterns.length).toBeGreaterThanOrEqual(1);
    const contents = result.taskPatterns.map(e => e.content);
    expect(contents.some(c => c.includes('retry'))).toBe(true);
  });

  it('should respect token budget', () => {
    const { projectStore, knowledgeStore } = setup();
    const tightBudget = new TokenBudget({ total: 200, systemPrompt: 0, memoryRatio: 0.5 });
    const recaller = new MemoryRecaller(projectStore, knowledgeStore, tightBudget);
    const result = recaller.recall({ projectId: 'proj1', firstMessage: 'retry backoff agent' });
    expect(result.totalTokensUsed).toBeLessThanOrEqual(tightBudget.remainingForMemory(0));
  });

  it('should handle missing project', () => {
    const { projectStore, knowledgeStore, budget } = setup();
    const recaller = new MemoryRecaller(projectStore, knowledgeStore, budget);
    const result = recaller.recall({ projectId: 'nonexistent' });
    expect(result.projectContext).toBeNull();
  });

  it('should convert to messages', () => {
    const { projectStore, knowledgeStore, budget } = setup();
    const recaller = new MemoryRecaller(projectStore, knowledgeStore, budget);
    const prefs: UserPreferences = { userId: 'u1' };
    const result = recaller.recall({ projectId: 'proj1', userPrefs: prefs });
    const messages = recalledContextToMessages(result);
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages.every(m => m.role === 'system')).toBe(true);
  });
});
