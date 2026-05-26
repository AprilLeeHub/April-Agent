# 记忆系统架构 Review 与优化建议

## 概述

本文档针对 April-Agent 的记忆/缓存系统设计，结合 Gemini 设计的 plan，对以下四个核心问题进行 review 并给出优化建议。

---

## 问题一：缓存机制设计

### 问题分析

> 在有长期知识库支持下，对于用户遗忘的内容（如"替我查一下当前项目有哪些可用工具？"），如果没有记忆支持会执行一次 runtime loop，浪费 token。如果在 session 一开始就能查询记忆，能节省大量 token。

### 优化建议

**引入两级缓存架构：**

```
┌─────────────────────────────────────────────────┐
│              Session Hot Cache (L1)              │
│  - 当前会话高频查询结果                            │
│  - TTL: session 生命周期                          │
│  - 存储: 内存 dict / LRU                          │
└─────────────────────┬───────────────────────────┘
                      │ cache miss
┌─────────────────────▼───────────────────────────┐
│           Cross-Session Warm Cache (L2)          │
│  - 跨会话的常用知识片段                            │
│  - TTL: 可配置（默认 7 天）                        │
│  - 存储: 本地 SQLite / Redis                      │
│  - 索引: query embedding → cached answer         │
└─────────────────────┬───────────────────────────┘
                      │ cache miss
┌─────────────────────▼───────────────────────────┐
│         Long-term Knowledge Store (L3)           │
│  - 持久化知识库                                   │
│  - 向量检索 + 关键词混合搜索                       │
└─────────────────────────────────────────────────┘
```

**关键设计点：**

1. **Session 预热（Pre-warm）**：新会话启动时，根据用户身份 + 项目上下文，主动从 L2 缓存加载高频 query 的答案，注入 system prompt 或作为初始 context。
2. **缓存键设计**：使用 `(user_id, project_id, query_embedding)` 三元组作为缓存键，避免跨项目污染。
3. **缓存失效策略**：
   - 项目文件变更时，相关缓存标记为 stale
   - 用户显式纠正答案时，立即失效对应缓存
   - TTL 过期自动清理

**实现优先级：** 中。应在 context compression 稳定后再引入，避免缓存了压缩前的冗余内容。

---

## 问题二：会话整合服务与 Context Compression 的协作

### 问题分析

> 压缩的优先级应该高于记忆系统搭建，这是保证当前任务不走偏的基础。

### 优化建议

**完全同意：Context Compression 优先级 > 记忆系统。** 原因：

1. 压缩保证当前 session 的 token 预算内容量最大化 → 直接影响任务完成质量
2. 记忆系统是"锦上添花"，压缩是"生存必需"

**协作架构（建议执行顺序）：**

```
新会话/新消息到达
       │
       ▼
┌──────────────────┐
│ 1. Context       │  ← 最高优先级
│    Compression   │     压缩历史对话，保留关键信息
│    (必须先执行)   │     输出: compressed_context
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ 2. Memory Recall │  ← 在压缩后的剩余 token 空间内
│    (可选执行)     │     根据 available_tokens 决定召回量
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ 3. Session       │  ← 最低优先级
│    Consolidation │     将多轮对话整合为结构化摘要
│    (异步执行)     │     不阻塞主流程
└──────────────────┘
```

**Token 预算分配建议：**

```python
@dataclass
class TokenBudget:
    total: int = 128000          # 模型 context window
    system_prompt: int = 2000    # 固定系统提示
    compression_reserved: int    # 压缩后的历史 = total * 0.4
    memory_recall: int           # 记忆召回 = total * 0.1
    current_task: int            # 当前任务空间 = total * 0.4
    buffer: int                  # 缓冲 = total * 0.1
```

**核心原则：**
- 压缩结果决定记忆召回的配额（先压缩，再看剩多少空间给记忆）
- Session consolidation 异步执行，产出写入 L2/L3 缓存，不影响实时响应
- 若压缩后 token 紧张，记忆召回可降级或跳过

---

## 问题三：新会话记忆召回策略

### 问题分析

> 在新会话开始时，是否执行召回记忆？召回哪一层合适？都不合适是否要再加一层？

### 优化建议

**建议：是，但要分层召回，且新增一个"项目上下文层"。**

**改进后的记忆层级：**

| 层级 | 名称 | 内容 | 召回时机 | 示例 |
|------|------|------|----------|------|
| L0 | **Project Context**（新增） | 项目元信息、工具列表、架构概要 | 每次新会话必定召回 | "当前项目有 retry, agent 两个模块" |
| L1 | **User Preferences** | 用户个人偏好、习惯 | 每次新会话召回 | "用户偏好中文回复" |
| L2 | **Task Patterns** | 历史任务模式、常见问答 | 按相似度召回 | "上次问过类似问题，答案是..." |
| L3 | **Deep Knowledge** | 深度学习到的领域知识 | 仅显式触发或高匹配度 | 复杂架构决策记录 |

**为什么需要新增 L0 层：**

- 原有层级都是"学来的知识"，缺少"当前事实"层
- 项目工具列表、文件结构等是高频查询但变化可跟踪的内容
- 这类内容不需要 embedding 匹配，直接按 project_id 拉取即可
- 解决问题一中"查一下当前项目有哪些可用工具"的场景

**召回决策流程：**

```python
async def session_start_recall(session: Session) -> RecalledContext:
    """新会话启动时的记忆召回"""
    recalled = RecalledContext()

    # L0: 始终召回 - 成本低，价值高
    recalled.project_context = await load_project_context(session.project_id)

    # L1: 始终召回 - 用户偏好影响所有交互
    recalled.user_prefs = await load_user_preferences(session.user_id)

    # L2: 条件召回 - 根据用户首条消息的意图判断
    if session.first_message:
        relevance = await compute_relevance(
            session.first_message, 
            task_pattern_index
        )
        if relevance > RECALL_THRESHOLD:
            recalled.task_patterns = await recall_task_patterns(
                session.first_message, top_k=3
            )

    # L3: 不在启动时召回，等需要时再触发
    return recalled
```

---

## 问题四：长期知识清理机制

### 问题分析

> 长期知识除了学习机制，还需要清理机制。

### 优化建议

**设计一套"知识生命周期管理"系统：**

### 4.1 知识衰减模型

```python
@dataclass
class KnowledgeEntry:
    content: str
    created_at: datetime
    last_accessed: datetime
    access_count: int
    confidence: float        # 0.0 ~ 1.0
    source: str              # "user_correction" | "auto_learned" | "imported"
    decay_rate: float = 0.05 # 每天衰减

    @property
    def current_value(self) -> float:
        """计算当前知识价值分数"""
        days_since_access = (now() - self.last_accessed).days
        recency_score = math.exp(-self.decay_rate * days_since_access)
        frequency_score = min(self.access_count / 10.0, 1.0)
        return self.confidence * recency_score * frequency_score
```

### 4.2 清理策略

| 策略 | 触发条件 | 动作 |
|------|----------|------|
| **自动衰减** | `current_value < 0.1` | 标记为 archived |
| **矛盾检测** | 新知识与旧知识冲突 | 保留高置信度版本，低置信度标记 deprecated |
| **容量上限** | 知识条目数超过阈值 | 按 value 排序，尾部批量归档 |
| **用户反馈** | 用户标记"过时"或纠正 | 立即更新/删除 |
| **来源失效** | 关联的文件/项目被删除 | 级联标记为 stale |

### 4.3 清理执行流程

```
┌─────────────────────────────────────────────┐
│           定期清理 Job（每日/每周）           │
├─────────────────────────────────────────────┤
│ 1. 扫描所有 current_value < threshold 的条目 │
│ 2. 检测矛盾知识对                            │
│ 3. 检查来源有效性                            │
│ 4. 执行归档/删除                             │
│ 5. 生成清理报告（可选通知用户）               │
└─────────────────────────────────────────────┘
```

### 4.4 安全机制

- **软删除优先**：先归档（不参与召回），30 天后才真正删除
- **用户确认**：高置信度知识的删除需要用户确认
- **审计日志**：所有清理操作可追溯

---

## 整体架构建议总结

### 实现优先级排序

```
P0 (立即) : Context Compression → 保证当前任务质量
P1 (短期) : L0 Project Context 层 → 解决高频无记忆查询
P2 (中期) : 记忆召回机制 (L1/L2) → 提升跨会话体验
P3 (长期) : 知识清理 + 完整生命周期管理 → 系统可持续性
P4 (长期) : L2 缓存层 → token 优化
```

### 与 Gemini Plan 的关键差异建议

1. **增加 L0 层**：Gemini plan 可能没有区分"项目事实"和"学来的知识"，建议显式分离
2. **压缩前置**：确保 context compression 模块独立于记忆系统，作为所有流程的前置步骤
3. **异步整合**：session consolidation 不应阻塞主对话流，改为异步 + 事件驱动
4. **预算感知**：所有记忆/缓存操作都应该 token-budget-aware，而非固定配额

---

## 下一步行动项

- [ ] 实现 `ContextCompressor` 基类，定义压缩接口
- [ ] 实现 `ProjectContextStore`（L0 层），支持按 project_id 加载
- [ ] 定义 `TokenBudget` 配置，集成到 `AgentConfig`
- [ ] 设计 `KnowledgeEntry` 数据模型，支持生命周期字段
- [ ] 实现定期清理 job 的调度框架
