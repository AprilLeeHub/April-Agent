# Tools Architecture

`src/tools` 是 runtime 的工具控制面和执行面汇合处。它负责三件事：

1. 把 provider 返回的 tool call 映射到本地可执行工具。
2. 在真正执行前跑一层策略中间件，决定 allow / review / deny。
3. 在执行后统一治理输出，把摘要、截断和 artifact offload 从具体工具实现里剥离出来。

## Flow

```mermaid
flowchart LR
  LLM[LLM ToolCall] --> Registry[ToolRegistry]
  Registry --> Executor[ToolExecutor]
  Executor --> Policy[ToolPolicyEngine]
  Policy --> Loop[LoopGuardPolicy]
  Policy --> Risk[RiskScorerPolicy]
  Policy --> Prefer[StructuredToolPreferencePolicy]
  Policy --> Approval[ApprovalPolicy]
  Policy --> Backend[DefaultToolExecutionBackend]
  Backend --> Builtin[Built-in Tool execute()]
  Builtin --> Shell[ShellExecutor]
  Backend --> Output[DefaultToolOutputProcessor]
  Output --> Artifact[ArtifactStore]
  Policy --> Obs[Observability]
  Backend --> Obs
  Output --> Obs
```

## Responsibility Split

- `executor.ts`
  调度入口。负责查找工具、运行策略链、调用 backend、处理输出治理，并把结果转成 `ToolExecutionResult`。

- `policy-engine.ts`
  Claude 风格策略中间件。当前内置：
  - `LoopGuardPolicy`：阻止短窗口内同一 `tool name + stable input hash` 的重复调用。
  - `RiskScorerPolicy`：给工具调用打低/中/高风险分，并产出 matched rules。
  - `StructuredToolPreferencePolicy`：识别可被结构化工具替代的 bash 读/搜/列目录操作。
  - `ApprovalPolicy`：把需要人工确认的调用路由到 review。

- `execution-backend.ts`
  默认执行后端。当前实现只是调用 `tool.execute()`，但这里是未来切换到系统 shell backend 或安全沙箱 backend 的主要 seam。

- `output-processor.ts`
  统一输出治理。负责摘要、截断、大结果落到 artifact store，并把元数据附加回 tool message。

- `shell-executor.ts`
  真实系统命令执行层。只关心怎么拉起子进程，不关心 session、approval 或 tool message。

- `tool-utils.ts`
  策略和执行阶段共享的稳定序列化、摘要和 tool-call 签名工具。

## Design Notes

- Fail-safe default
  新策略应优先显式决定 allow / review / deny，而不是把风险判断散落到各个工具实现。

- Stateless policy engine
  `ToolPolicyEngine` 不持有会话状态。所有上下文都通过 `ToolPolicyContext` 传入，便于测试和后续扩展。

- Backend seam first
  shell 执行细节不应反向污染策略层。策略输出的是决策和约束，backend 决定怎么执行。

- Output governance stays centralized
  摘要、截断、artifact offload、未来的 sanitize 都应该留在 `output-processor.ts`，而不是各工具各自实现。

## Current Extension Points

- 新策略
  在 `policy-engine.ts` 中新增实现 `ToolExecutionPolicy` 的类，并在 `ToolExecutor` 的默认 policy list 中注册。

- 新 backend
  实现 `ToolExecutionBackend`，再通过 `ToolExecutorOptions.backend` 注入。

- 新 output policy
  实现 `ToolOutputProcessor`，再通过 `ToolExecutorOptions.outputProcessor` 注入。

- 安全沙箱
  当前只保留 `SandboxConstraints` 和 backend seam。未来如果接容器、系统级沙箱或远程 executor，优先替换 backend，不要把逻辑堆回 bash tool。