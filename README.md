# Pi Shadow Mind

![Pi Shadow Mind — the main agent builds while Shadow Minds review, verify, and maintain](./assets/shadow-mind-hero-v2.png)

**Configurable cognitive cores for Pi.**

**为 Pi 配置多个独立的认知核心。**

[English](#english) · [中文](#中文)

## English

Pi Shadow Mind runs specialized agents alongside the main agent. Each Shadow Mind owns a persistent responsibility—architecture, correctness, documentation, project grounding, or anything else you define.

While the main agent implements, other minds can independently review decisions, verify claims, maintain related files, and intervene before mistakes become expensive to undo.

> Build and review in the same pass.

### One agent, multiple responsibilities

The main agent keeps moving. Shadow Minds independently protect the parts of the work that matter to you.

| Cognitive core | Responsibility |
|---|---|
| Architecture review | Detect growing god components, misplaced responsibilities, missing module boundaries, and fragile extension points while code is being written |
| Project grounding | Check claims against the actual repository and catch invented APIs, files, constraints, or implementation details |
| Documentation maintenance | Track implementation changes and keep architecture notes, decisions, and usage documentation aligned |
| Completion review | Independently verify that the result satisfies the task before the main agent declares it finished |

These are not temporary tasks delegated by the main agent. They are persistent, user-defined cognitive roles that decide independently when to inspect, act, or report.

### Shadows can review—or work

A Shadow Mind may remain read-only and report findings to the main agent, or receive additional tools and own a parallel line of work.

While the main agent writes code, another Shadow can maintain documentation, update architectural decisions, or work on a separate file. Tool access is configured per Shadow, so each cognitive core receives only the capabilities its responsibility requires.

```text
Main Agent          Architecture Shadow
implements feature  reviews module boundaries

Main Agent          Documentation Shadow
writes code         maintains design documentation
```

Review is only one possible responsibility. A Shadow Mind can observe, verify, maintain, or build.

### Start with an Architecture Shadow

Create `~/.pi/agent/shadow-minds/architecture-review.md`:

```markdown
---
id: architecture-review
name: Architecture review
activation_probability: 0.3
min_rounds_after_end: 2
max_rounds_after_end: 8
active_for_models: ["*"]
tools: [read, grep]
---

Review the main agent's current implementation for architectural drift.

Check whether responsibilities have clear owners, modules have coherent
boundaries, and new behavior uses appropriate extension points. Detect growing
god components, unrelated state or methods accumulating in one module, and
business differences implemented as expanding conditionals.

Report only concrete, actionable issues grounded in the visible trajectory or
repository. If the current work is unrelated, do not intervene.
```

This Shadow is read-only. It reviews the implementation in parallel and reports concrete architectural concerns without taking control of the main task.

### Configure a fallback model

Use `run_with_model` to choose the primary model for a Shadow, and optionally set `fallback_model` for one retry when the primary attempt cannot start or returns an error. The fallback creates a fresh Shadow session; timeouts, external aborts, silent completion, and an already-submitted report do not trigger a fallback retry.

```markdown
---
id: resilient-review
name: Resilient review
run_with_model: openai/gpt-5-mini
thinking_level: high
fallback_model: anthropic/claude-sonnet-4
fallback_model_thinking_level: medium
active_for_models: ["*"]
tools: [read, grep]
---

Review the implementation and report only concrete findings.
```

Model values should use the full `provider/model-id` form and must be available and authenticated in Pi. `fallback_model_thinking_level` is optional; when omitted, the fallback reuses `thinking_level` and then applies the normal thinking-level fallback rules. If `fallback_model` is omitted, the Shadow does not retry with another model.

### How it works

After a main-agent `turn_end` that completed at least one tool call, the extension evaluates a heartbeat. Pure text-only conversation turns are skipped, so ordinary discussion does not wake Shadows. By default, eligible turns fire a heartbeat with probability `1/3`; Shadow Minds then roll independently using their own activation probabilities, with at most two running concurrently.

A Shadow can optionally set `min_rounds_after_end` and/or `max_rounds_after_end`. Eligible tool turns advance the Shadow by the highest configured `turn_weights` value among that turn's tools; multiple tools in one turn are not added together. The first N weighted units are blocked by the minimum; when the maximum is reached, that Shadow bypasses both probability gates and is forced to run. These settings also apply from the beginning of a session, before the Shadow has run once. If all slots are occupied, the forced Shadow remains pending and is started first when a slot is released; it never exceeds the global parallelism limit.

Global `turn_weights` defaults are `read/grep/find/ls: 0.25`, `edit/write: 1`, `bash/shell: 0.5`, and unknown tools: `default: 1`. The weights only affect Shadow min/max progress; normal activation still uses `heartbeat_probability × activation_probability`. A zero-weight tool turn still evaluates heartbeat but does not advance that progress.

Each activation starts a fresh temporary session. It inherits the main agent's unchanged system prompt but receives only a sanitized plain-text trajectory: assistant thinking is removed, while tool calls retain compact, deterministic result summaries.

A Shadow first decides whether the trajectory is relevant to its responsibility. If unrelated, it exits without calling tools or `report_to_main`. When the main agent should receive a concrete result, the Shadow calls `report_to_main`, which immediately ends that run.

Shadow definitions are ordinary Markdown files. They can be created and adjusted by the user or managed by the agent through the extension's tools. Model filters and activation probabilities allow different models to receive different supporting minds.

### Installation

```bash
pi install npm:pi-shadow-mind@0.1.11
```

On the first session start, the extension creates:

```text
~/.pi/agent/shadow-minds/
  config.json
  *.md
  logs/<shadow-id>/*.jsonl   # only when debug: true
```

No default Shadow Mind is created. The global runtime timeout defaults to 300 seconds, and individual Shadows may override it with `timeout_seconds`.

Press `Alt+S` to pause or resume Shadow Mind for the current session. The paused footer reads `🐙 Paused` without a redundant zero count. Use `/shadow` to toggle the status panel, `/shadow status` for a summary, or `/shadow toggle`, `/shadow pause`, and `/shadow resume` for command-based control. Management tools can list, create, update, enable, disable, and delete Shadow Minds, as well as read or update the global configuration. Every write requires user confirmation.

For development:

```powershell
npm install
pi -e ./src/index.ts
```

See [DESIGN.md](./DESIGN.md) for the behavioral contract and [BENCHMARK.md](./BENCHMARK.md) for benchmark methodology and lessons learned.

## 中文

Pi Shadow Mind 让多个专业化认知核心与主 Agent 并行工作。每个 Shadow Mind 都拥有一项持续、稳定的职责，例如架构审阅、正确性检查、文档维护、项目事实核验，或任何由你定义的任务。

主 Agent 负责持续推进，其他认知核心则独立审阅决策、核验事实、维护相关文件，并在错误产生高昂返工成本之前介入。

> 让实现与审阅发生在同一轮工作中。

### 一个 Agent，多项独立职责

| 认知核心 | 职责 |
|---|---|
| 架构审阅 | 在编码过程中发现上帝组件、职责错位、模块边界缺失和脆弱的扩展点 |
| 项目事实核验 | 对照真实仓库检查结论，发现模型编造的 API、文件、约束和实现细节 |
| 文档维护 | 跟踪实现变化，让架构说明、设计决策和使用文档保持同步 |
| 完成度审阅 | 在主 Agent 宣布完成前，独立检查结果是否真正满足任务要求 |

它们不是主 Agent 临时委派的任务，而是由用户定义、持续存在的认知职责，可以独立决定何时检查、行动或汇报。

### Shadow 不只审阅，也可以工作

Shadow Mind 可以保持只读，只向主 Agent 汇报发现；也可以获得额外工具，独立负责另一条任务线。

当主 Agent 编写代码时，另一个 Shadow 可以同步维护文档、更新架构决策，或处理独立文件。工具权限由每个 Shadow 单独配置，因此每个认知核心只获得其职责真正需要的能力。

```text
主 Agent             Architecture Shadow
实现功能              审阅模块边界

主 Agent             Documentation Shadow
编写代码              维护设计文档
```

审阅只是一种职责。Shadow Mind 可以观察、核验、维护，也可以直接构建。

### 从 Architecture Shadow 开始

创建 `~/.pi/agent/shadow-minds/architecture-review.md`：

```markdown
---
id: architecture-review
name: Architecture review
activation_probability: 0.3
min_rounds_after_end: 2
max_rounds_after_end: 8
active_for_models: ["*"]
tools: [read, grep]
---

审阅主 Agent 当前实现是否正在偏离合理架构。

检查每项职责是否有明确所有者、模块边界是否内聚、新能力是否使用了合适的扩展点。
发现不断膨胀的上帝组件、堆积在同一模块中的无关状态与方法，以及用持续增长的条件
分支承载业务差异的实现。

只报告能够从当前轨迹或仓库中得到证据、并且可以采取行动的问题。如果当前工作与该职责
无关，不要介入。
```

这个 Shadow 默认只读。它会在实现过程中并行审阅架构，并向主 Agent 报告具体问题，但不会接管主任务。

### 配置 fallback 模型

使用 `run_with_model` 指定 Shadow 的首选模型，并可通过 `fallback_model` 配置备用模型。当首选模型无法启动或运行返回 `error` 时，插件会使用备用模型重新创建一个 Shadow Session，并且只重试一次。超时、外部中止、静默结束或已经提交报告，都不会触发 fallback 重试。

```markdown
---
id: resilient-review
name: Resilient review
run_with_model: openai/gpt-5-mini
thinking_level: high
fallback_model: anthropic/claude-sonnet-4
fallback_model_thinking_level: medium
active_for_models: ["*"]
tools: [read, grep]
---

审阅当前实现，只报告具体的问题。
```

模型值应使用完整的 `provider/model-id` 格式，并且该模型需要已在 Pi 中可用且完成认证。`fallback_model_thinking_level` 是可选项；省略时，fallback 会继承 `thinking_level`，然后按常规规则回退 thinking level。如果省略 `fallback_model`，Shadow 不会切换到其他模型重试。

### 工作方式

主 Agent 的一次 `turn_end` 只有在该轮至少完成过一个工具调用时，扩展才进行 heartbeat 判断。纯文本对话轮次会被跳过，因此普通讨论不会唤醒 Shadow。符合条件的轮次默认以 `1/3` 的概率触发 heartbeat，Shadow Minds 再按照各自的激活概率独立抽选，默认最多同时运行两个。

Shadow 可以分别设置可选的 `min_rounds_after_end` 和 `max_rounds_after_end`。每个有效工具轮次只取该轮最高的 `turn_weights` 作为进度，不累加同一轮中的多个工具。前 N 个加权单位禁止触发；达到最大进度后绕过两层概率强制触发。会话刚开始、Shadow 尚未运行过时也从第一个有效轮次开始遵守配置。槽位已满时保留强制触发状态，等任意 Shadow 结束释放槽位后优先启动，但不会突破全局并发上限。

全局默认权重为 `read/grep/find/ls: 0.25`、`edit/write: 1`、`bash/shell: 0.5`，未知工具使用 `default: 1`。权重只影响 Shadow 的 min/max 进度，普通调度仍使用 `heartbeat_probability × activation_probability`；权重为 `0` 的工具轮仍会参与 heartbeat，但不推进进度。

每次激活都会创建一个全新的临时 Session。它继承主 Agent 原封不动的 system prompt，但只接收净化后的文本轨迹：思考内容会被移除，工具调用后仅保留简洁、确定性的结果概述。

Shadow 会先判断轨迹是否与自己的职责相关。无关时直接结束，不调用工具或 `report_to_main`；需要向主 Agent 提交具体结果时，通过 `report_to_main` 上报并立即结束本轮。

Shadow 定义只是普通 Markdown 文件，可以由用户创建和调整，也可以由 Agent 通过扩展工具管理。模型过滤和独立激活概率允许不同模型获得不同的辅助认知核心。

### 安装

```bash
pi install npm:pi-shadow-mind@0.1.11
```

首次启动 Session 时，扩展会创建：

```text
~/.pi/agent/shadow-minds/
  config.json
  *.md
  logs/<shadow-id>/*.jsonl   # 仅在 debug: true 时生成
```

扩展不会默认创建 Shadow Mind。全局默认运行超时为 300 秒，单个 Shadow 可以通过 `timeout_seconds` 覆盖。

按 `Alt+S` 可以暂停或恢复当前 Session 的 Shadow Mind。暂停时底部状态显示为 `🐙 Paused`，不再显示没有信息量的零计数。使用 `/shadow` 显示或隐藏状态面板，`/shadow status` 查看摘要，也可以通过 `/shadow toggle`、`/shadow pause` 和 `/shadow resume` 控制状态。管理工具可以查询、创建、更新、启用、禁用和删除 Shadow Mind，以及读取或修改全局配置。所有写操作都需要用户确认。

开发模式：

```powershell
npm install
pi -e ./src/index.ts
```

完整行为约定见 [DESIGN.md](./DESIGN.md)，Benchmark 方法与经验见 [BENCHMARK.md](./BENCHMARK.md)。
