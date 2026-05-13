# Copilot Instructions

## 构建、测试与类型检查

- `npm run typecheck`：运行 TypeScript 无输出类型检查。
- `npm test`：运行完整的 Vitest 测试套件。
- `npx vitest run <file> -t "<test name>"`：运行单个命名测试用例的通用写法。
- `npx vitest run tests/runtime.spec.ts`：运行单个测试文件。
- `npx vitest run tests/engine.spec.ts -t "runs a full tool-assisted loop and preserves assistant-tool adjacency"`：运行单个命名测试用例。
- `npm run build`：将源码编译到 `dist/`。
- `package.json` 中**没有** lint 脚本。
- README 里的快速冒烟命令是 `npm run demo:cli -- "<prompt>"` 和 `npm run demo:min -- "<prompt>"`。这两个命令都会先 build，并通过 `.env.local` 注入 DeepSeek 相关环境变量。

## 已知基线问题

- 这是仓库当前已存在的基线状态，不应默认视为新改动引入的问题。
- `npm run typecheck` 和 `npm run build` 当前会因 `src/engine/agent-engine.ts` 中 `pendingContextInjections` 相关类型漂移而失败。
- `npm test` 当前主要失败在 `tests/engine.spec.ts` 与 `tests/integration.spec.ts`，也与同一批 runtime / session 类型不一致有关。

## 常见改动入口

- 改运行时装配与默认内置工具注册：`src/runtime/create-runtime.ts`
- 改 ReAct 主循环、approval / cancel / intervention 行为：`src/engine/agent-engine.ts`
- 改上下文构造、压缩、summary 注入：`src/engine/context-manager.ts`
- 改 session 只读查询视图：`src/session/session-query.ts`
- 改工具策略、loop guard、结构化工具偏好：`src/tools/policy-engine.ts`
- 改工具执行与输出治理：`src/tools/executor.ts`、`src/tools/execution-backend.ts`、`src/tools/output-processor.ts`
- 改内置工具实现：`src/tools/builtin/`
- 改消息协议与 session/runtime 类型：`src/types/messages.ts`、`src/types/runtime.ts`

## 高层架构

- `src/runtime/create-runtime.ts` 是装配入口。它负责组装 `Observability`、内存版 session/checkpoint/artifact store、`ContextManager`、`ToolExecutor`、`ToolRegistry`、内置工具以及 `AgentEngine`。
- `src/engine/agent-engine.ts` 负责确定性的 ReAct 主循环与 session 生命周期：提交输入、确认回合、驱动模型/工具循环、写 checkpoint、处理 intervention，以及在 approval / cancel 场景下暂停与恢复。
- 运行时主流程是：`submitUserInput()` 先把用户目标写入 session，`confirmTurn()` 把回合切到可执行状态，随后 `runTurn()` 进入 provider -> tool execution -> provider 的 ReAct 循环，直到 assistant 不再返回 `toolCalls`、命中 approval、被取消，或进入错误态。
- `src/engine/context-manager.ts` 负责构造发给 provider 的消息视图：校验 assistant/tool 邻接关系、注入 system goal 与 policy guidance、把较早的 tool result 压缩成 receipt，并在上下文超过软阈值时可选插入 summary model 生成的摘要消息。
- 工具执行链路是分层设计的：`src/tools/policy-engine.ts` 先做 loop guard、approval 和结构化工具偏好判断；随后 executor/backend 真正执行工具；`src/tools/output-processor.ts` 统一处理大输出的截断与 artifact 落盘。
- 如果 assistant 一次返回多条 tool call，而其中前面的调用命中 approval，engine 会先写入 approval 占位与 deferred tool result，保持消息协议闭合；批准后从被拦下的位置继续执行同一批剩余工具，拒绝后则写入拒绝型 tool result 再继续下一轮推理。
- intervention 不是随时直接插入历史。只有当前消息序列处于“安全边界”时才会立即落入 history；否则会先进入 `InterventionQueue`，等未闭合 tool chain 结束后再 flush。
- checkpoint 是主循环的一等产物。`AgentEngine` 会在 `turn_start`、`llm_response`、`turn_end`、`error` 等关键节点写 checkpoint，因此排查运行时问题时，优先结合 checkpoint 视角而不是只看最终 session。
- `src/session/session-query.ts` 是给 CLI 或上层调用方使用的只读查询入口。读取 session 状态、最后消息、pending approvals 时，优先走这个 facade，而不是手动拼装底层 store 数据。
- 默认内置工具集合是 `read_file`、`write_file`、`edit_file`、`list_dir`、`grep_search` 和 `bash`；`tests/` 下的测试也基本按 engine / context / tools / runtime / integration 这些边界组织。

## 状态机关键状态

- `awaiting_confirmation`：用户输入已写入，但当前回合还未确认执行。
- `running`：正在执行 provider/tool 主循环。
- `awaiting_approval`：某个 tool call 被策略拦下，等待批准或拒绝。
- `completed`：本轮 assistant 已结束，且没有未闭合 tool chain。
- `cancelled`：本轮被取消。
- `errored`：运行时错误导致本轮异常结束。

## 关键约定

- 这是一个 Node 20+ 的 ESM TypeScript 项目。即使源码文件是 `.ts`，仓库内部 import 也统一写 `.js` 后缀，新增模块时要保持这个约定。
- **硬规则：绝不要破坏 assistant/tool adjacency invariant。** `src/types/messages.ts` 定义了严格的消息协议：只要 assistant 消息带有 `toolCalls`，后面就必须立刻按顺序跟上对应的 `tool` 消息。不要在一个未闭合的 tool chain 中间插入别的消息。
- `createRuntime()` 当前默认接的是**内存版** stores。除非显式新增别的实现，否则不要假设 session、checkpoint 或 artifact 具备进程重启后的持久化能力。
- approval 和安全策略应当放在工具策略管线里处理，而不是分散写在各个调用点。文件写入和高风险 bash 命令默认应进入 approval；当一批 tool call 中途被 approval 打断时，会通过 deferred tool result 维持协议闭合。
- 优先使用结构化工作区工具，而不是 shell 退化方案。策略层已经把 `cat/head/tail/sed` 视为应优先替换为 `read_file`，`ls/find/tree` 替换为 `list_dir`，`grep/rg` 替换为 `grep_search`。
- 新增工具时，通常要同时检查这些面是否需要同步更新：`ToolRegistry` 注册、provider tool definition 暴露、policy/approval 规则、输出截断与 artifact offload、以及对应的 engine/runtime/integration 测试。
- 输出长度治理集中在 `DefaultToolOutputProcessor`。新增或修改工具时，应沿用“摘要 + artifact offload”的模式，而不是在各个工具里各自手写截断逻辑。
- README 中的 provider 配置约定是“命令层注入”。`.env.local` 与 DeepSeek 相关配置由启动命令注入，runtime 内部默认只消费已经存在的 `process.env`。
