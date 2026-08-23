# Shadow Mind：Pi 并行认知运行时设计

## 1. 目标

Shadow Mind 是一个运行在 Pi 主 Agent 旁边的通用并行认知运行时。

主 Agent 继续正常推理和执行任务；插件以 heartbeat 随机唤醒多个 Shadow Mind，让它们沿各自的职责独立观察或推进任务。Shadow 既可以检查 Main，也可以承担文档维护等并行工作，并在有结果需要同步时向主 Agent 注入消息。

第一版要验证的核心假设是：

> 不引入复杂的智能调度，仅通过随机唤醒多个具有持久职责的异步 Agent，能否让一个 Pi Session 稳定推进多条相互补充的认知与任务线。

纠错、事实核查和约束检查只是典型场景；Shadow 也可以探索替代路线、维护文档或承担其他长期职责。“多核”和“章鱼”可用于解释和后续产品表达，但不是运行时的技术定义。

## 2. 核心结构

```text
Main Agent
    │
    ├── model call / message / tool events
    │
    ▼
Trajectory Builder
    │  生成净化后的行为轨迹
    ▼
Heartbeat Scheduler
    │  按 heartbeat_probability 随机触发
    │  每个 Shadow 按自己的概率独立参与
    │  并行数量受 max_parallel_shadows 限制
    ▼
Shadow Runtime × N
    │  独立推理、独立使用工具
    │
    └── 有重要发现 ──→ steer / follow-up ──→ Main Agent
```

Shadow 的持久化定义与运行实例相互分离：

- Shadow Mind 的定义是用户可阅读、可编辑的 Markdown 实体。
- 第一版只维护全局 Shadow registry，不提供项目级 Shadow。
- 每次激活产生全新的临时 AgentSession。
- 插件负责发现实体、筛选、随机调度、构造上下文和回收结果。

Shadow 的 Markdown 定义持久存在，但运行实例不保留长期记忆。每次激活只接收当时的净化轨迹和自身定义；运行结束或超时后立即销毁，不继承上一次激活的消息历史。

每个实例同时快照激活时 Main 的当前工作目录，并在整个临时 AgentSession 中保持不变。Shadow 的工具都以该目录为 `cwd`；Main 后续切换目录只影响新激活的 Shadow。

## 3. Shadow Mind 实体

每个 Shadow Mind 使用一个 Markdown 文件描述。用户可以创建和调整它，主 Agent 也可以通过插件工具创建和调整它。

第一版统一从全局目录加载定义：

```text
~/.pi/agent/shadow-minds/
├── config.json
├── grounded-reviewer.md
├── requirement-keeper.md
└── logs/
    └── grounded-reviewer/
        └── <debug session logs>
```

该目录属于用户数据，不放入插件安装目录，也不随当前项目切换。插件级配置保存在 `config.json`；registry 只扫描目录顶层的 `.md` 文件，不读取 `config.json`，也不递归读取 `logs/`。

`config.json` 保存默认 Shadow 模型、`default_thinking_level`、`heartbeat_probability`、`max_parallel_shadows`、`default_shadow_timeout_seconds`、`result_batch_window_ms` 和 `turn_weights` 等全局调度配置。`default_shadow_model` 省略时，插件使用激活时的当前 Main 模型；用户也可以配置一个固定默认模型。`default_thinking_level` 的内置默认值为 `low`。`turn_weights` 按 Main 工具名配置有效轮次权重；默认 `read`、`grep`、`find`、`ls` 为 `0.25`，`edit`、`write` 为 `1`，`bash`、`shell` 为 `0.5`，未知工具使用 `default: 1`。权重允许为 `0`。

每次符合调度条件的 Main `turn_end` 进行 heartbeat 判断前，插件检查并重新加载发生变化的 `config.json`。纯文本轮次不会进入 heartbeat。新配置只影响后续调度和新建实例；已经运行的 Shadow 继续使用启动时取得的配置快照。

`config.json` 使用 last-known-good 策略。解析失败或字段无效时，插件继续使用最后一次有效配置，在界面及 `/shadow status` 中持续显示错误和当前实际生效值。只有首次加载就不存在有效配置时才使用内置默认值；插件不会自动用默认内容覆盖用户的无效文件。

首次启动时，插件创建该目录及带默认值的 `config.json`，但不自动创建任何 Shadow Markdown。registry 为空时只显示简短引导，用户可以手动创建定义或让 AI 提议创建；所有实际参与调度的 Shadow 都必须是目录中可见的实体。

示例：

```md
---
id: grounded-reviewer
name: 项目事实检查者
enabled: true
debug: false
activation_probability: 0.6
run_with_model: openai/gpt-5-mini
thinking_level: low
fallback_model: openai/gpt-5-mini
fallback_model_thinking_level: low
timeout_seconds: 120
tools:
  - read
  - search
active_for_models:
  - anthropic/claude-sonnet-4
  - anthropic/claude-opus-4.1
---

检查主 Agent 在分析和编写方案时，是否把未经项目证据支持的推测描述成事实。

重点关注不存在的模块、接口、现有能力和技术前提。需要时使用自己的工具独立核实；没有值得介入的问题时保持沉默。
```

第一版 frontmatter 包含以下运行字段：

| 字段 | 含义 |
| --- | --- |
| `id` | Shadow 的稳定标识；省略时使用 Markdown 文件名（不含扩展名） |
| `name` | 展示名称；省略时使用最终解析出的 `id` |
| `enabled` | 是否参与调度；默认 `true` |
| `debug` | 是否保存完整 Shadow Session 日志；默认 `false` |
| `activation_probability` | 每次 heartbeat 时独立激活的概率，范围为 `0` 到 `1`；默认 `0.3` |
| `active_for_models` | 适用于哪些 Main 模型；`"*"` 表示全部模型，省略时默认 `["*"]` |
| `run_with_model` | Shadow 首次运行使用的模型；省略时使用插件默认模型 |
| `thinking_level` | Shadow 首次运行使用的 thinking level；省略时使用插件默认值，再回退到 Main 会话当前生效等级 |
| `fallback_model` | 首次运行返回 `error` 时重试使用的模型；省略时不重试 |
| `fallback_model_thinking_level` | fallback 重试使用的 thinking level；省略时继承 `thinking_level`，再按常规候选回退 |
| `min_rounds_after_end` | Shadow 上次运行结束后，前 N 个符合条件的 Main 工具轮次禁止再次触发；省略时不启用最小间隔 |
| `max_rounds_after_end` | Shadow 上次运行结束后，达到第 N 个符合条件的 Main 工具轮次仍未触发时强制触发；省略时不启用截止触发 |
| `timeout_seconds` | Shadow 单次运行超时；省略时使用插件默认超时 |
| `tools` | 在 Pi SDK `readOnlyTools` 之上追加的工具白名单；默认 `[]` |

Shadow 的可选轮次策略只统计包含 Main 工具结果的 eligible `turn_end`。`min_rounds_after_end` 和 `max_rounds_after_end` 可以分别省略，也可以只配置其中一个；如果同时配置，`max_rounds_after_end` 必须大于 `min_rounds_after_end`。会话开始时没有历史运行实例也从第一个 eligible 轮次开始计数，因此 `min_rounds_after_end: 2` 会禁止前两轮、从第三轮开始恢复普通概率，`max_rounds_after_end: 8` 会在第八轮强制触发。

`active_for_models` 绑定的是被观察的 Main 模型，`run_with_model` 则指定 Shadow 首次运行时使用的模型。匹配前由 Pi 将 Main 的别名或简写解析为完整 `provider/model-id`；第一版只支持该完整 ID 和精确值 `"*"`，不引入其他通配、正则、标签或复杂条件。首次运行的模型选择优先级为：Shadow 的 `run_with_model` → 插件的 `default_shadow_model` → 激活时的当前 Main 模型。

如果配置的首次运行模型不存在、未认证、上下文不足、thinking level 不支持或运行过程中返回 `error`，且配置了 `fallback_model`，插件会使用 fallback 模型重新创建 Shadow Session 并重试一次。Shadow Session 不继承 Main 会话的自动重试策略：会关闭 AgentSession retry、provider retry，并排除 `pi-retry` 扩展；这些覆盖只作用于 Shadow，不改变 Main 会话。`timeout`、外部 `abort`、静默结束和已经提交报告都不会触发重试；没有配置 fallback，或 fallback 本身失败时，本次激活结束并记录最终原因。

首次运行的 `thinking_level` 选择优先级为：Shadow 自身配置 → 插件的 `default_thinking_level` → 激活时 Main 会话当前生效的 thinking level。fallback 重试则优先使用 `fallback_model_thinking_level`，省略时继承 Shadow 的 `thinking_level`，再按同一候选顺序回退。所选模型不支持当前候选等级时，依序尝试下一个候选；全部候选都不支持时本次尝试失败并记录原因。实际生效的等级记录在 run-end 事件中。

每个 Shadow 的最终工具集合由三部分组成：

```text
Pi SDK readOnlyTools
+ 当前可用的 tools 追加项
+ 内置 report_to_main
```

默认名称集合包含 `read`、`grep`、`find` 和 `ls`。激活时插件按名称从当前 Main Session 的最终工具 registry 解析实际实现，因此会继承其他插件对同名工具的覆盖以及当前环境适配。这里的 `readOnlyTools` 表示默认名称约定，不保证被覆盖后的实现仍然没有副作用。

`tools` 是在该集合之上追加的显式白名单，省略时视为 `[]`。例如 `tools: [write]` 会获得当前 registry 中的默认四个工具、`write` 和内置 `report_to_main`。

Pi 的通用 `ToolDefinition` 没有可供插件查询的只读属性，因此自定义工具不会被自动归类或加入；编辑文件、执行 Shell 或其他能力也不会被隐式继承自 Main。配置的追加工具在当前 Session 不存在时，插件忽略该项、写入轻量运行事件，其余工具继续正常提供。

`tools` 白名单本身就是用户对该 Shadow 的执行授权。列入白名单的写入、Shell 或其他工具可以由后台 Shadow 直接调用，插件不增加逐次确认层。

### 写入并发边界

第一版不包装或替换 Main、Pi 内置工具及第三方插件工具，也不承诺文件级写入互斥。Pi 允许插件覆盖和新增工具，而任意工具可能产生无法预先声明的文件副作用；不完整的锁机制会形成错误的安全保证。

当用户把写入、Shell 或其他有副作用的工具加入 Shadow 白名单时，即表示接受它与 Main 或其他 Shadow 并发执行产生冲突的风险。可以在 Shadow Markdown 中约定职责范围，例如文档 Shadow 只维护 `docs/`，但这属于模型行为约束，不是运行时强制隔离。

未来可以提供自愿接入的协作式锁协议，让能够声明目标文件的工具主动参与协调；未知工具仍不能被视为受保护。该协议不属于第一版。

每个 Shadow 运行实例还会固定获得内置工具 `report_to_main`。该工具用于提交一条值得 Main 注意的发现，不属于普通工具白名单，也不能被移除。它是终止型工具：一旦调用，当前 Shadow Agent loop 立即结束，运行实例随即回收，因此一次激活最多上报一条意见。Shadow 正常结束且未调用该工具时，运行结果视为“保持沉默”。

“保持沉默”不代表 Shadow 没有执行工作。即使运行中成功调用过写入或其他有副作用的工具，Shadow 仍可不调用 `report_to_main` 而正常结束；插件不强制生成工作报告。此类行为只通过轻量运行事件和可选的 debug Session 日志追踪。

第一版 `report_to_main` 只接受一个 `content` 参数。它不包含严重度、类别或固定的报告结构；不同 Shadow 的表达要求由各自 Markdown 正文定义。

`content` 不设置硬性长度上限，也不在运行时截断。公共协议只要求报告清楚、简洁，具体详略由对应 Shadow 定义控制。

```text
report_to_main({ content: "..." })
```

插件提供默认运行超时，内置默认值为 `300s`。单个 Shadow 可以通过 `timeout_seconds` 覆盖。超时后插件终止该运行实例、释放并发槽位，并丢弃未完成结果，不向 Main 注入消息。

第一版不设置单次 model call 数或工具调用次数上限。运行资源只通过 heartbeat 概率、Shadow 激活概率、最大并发数和时间超时控制。

所有 Shadow 都记录轻量运行事件，包括激活、沉默、上报、超时、中止、耗时、执行模型以及工具使用摘要。工具摘要只记录工具名、调用次数和成功/失败统计，不保存参数或结果。事件作为自定义 entries 写入当前 Main Session，随会话持久化和恢复，但不参与 Main 的模型上下文。

每次 Main `turn_end` 都会写入一条轻量调度事件。没有工具活动的纯文本轮次记录为跳过；符合条件的轮次记录 heartbeat 随机值与是否触发，触发后再记录候选 Shadow、各自随机值、概率命中项、模型过滤、运行中排除、并发槽位裁剪和最终激活项。事件不保存 Main 或 Shadow 上下文，用于完整复盘调度决策。

`/shadow` 打开统一状态面板，展示当前 Session 的暂停状态、有效与无效 Shadow、正在运行的实例、最近事件和实际生效配置；`/shadow status` 提供对应的摘要视图。第一版面板以观察为主，不内置完整 Markdown 编辑器。

Pi 主界面常驻一个紧凑状态指示，例如 `🐙 2`，数字表示当前运行的 Shadow 实例数。产生报告、超时或错误时指示器短暂改变状态，不弹出逐次通知；详细信息统一进入 `/shadow` 面板。

只有设置 `debug: true` 的 Shadow 才保存完整的临时 AgentSession 日志，存入 `~/.pi/agent/shadow-minds/logs/<shadow-id>/`。

每次 Shadow 激活对应一个独立日志文件。文件覆盖该次临时 AgentSession 从创建到结束的完整生命周期；沉默、上报、超时和中止都会正常收口并记录最终状态。因此目录中的文件数量可以直接反映 `debug` 开启期间该 Shadow 的激活次数。

日志使用 Pi 原生 Session JSONL 格式，并在运行过程中增量写入。每个文件同时标记 Shadow ID、所属 epoch 和最终状态，以便复用 Pi 的会话查看能力并在异常退出时保留已有记录。

完整调试日志默认永久保留，不自动轮转或删除。任何日志清理都必须由用户显式执行，避免目录文件数失去累计激活次数的含义。

完整日志包含 Shadow 实际收到的净化轨迹、Shadow thinking、自己的工具调用和工具结果，可能包含其独立读取到的项目内容，因此 `debug` 默认关闭。

建议提供以下工具，使用户与 AI 操作同一套实体：

```text
create_shadow
update_shadow
delete_shadow
list_shadows
enable_shadow
disable_shadow
```

`list_shadows` 是只读操作，可以直接执行。AI 发起的 `create_shadow`、`update_shadow`、`enable_shadow`、`disable_shadow` 以及删除操作都会持久影响全局 registry，执行写入前必须向用户展示变更并取得确认。用户直接手动编辑 Markdown 不经过插件确认流程。

`create_shadow` 和 `update_shadow` 接收结构化配置字段与单独的 Markdown `body`，不接收一整段未经解析的文件文本。插件负责校验字段并统一序列化 frontmatter；确认界面展示字段级差异和正文差异。用户手动编辑时仍直接操作普通 Markdown 文件。

AI 调用 `create_shadow` 时必须显式提供 `id`，文件保存为 `<id>.md`。如果目标文件名或 registry 中的最终 ID 已存在，创建失败，不自动改名。用户手动创建的 Markdown 仍可省略 `id` 并由文件名派生。

`update_shadow` 不允许修改 `id`。需要更换身份时必须创建新 Shadow，再删除旧实体；插件不自动迁移日志、事件或正在运行实例。

`delete_shadow` 只删除 Markdown 定义，不删除 `logs/<shadow-id>/`。历史调试 Session 继续保留，日志清理必须由用户另行显式执行。

插件同时提供读取和修改全局配置的工具。读取 `config.json` 无需确认；AI 请求修改时必须向用户展示配置差异并取得确认，不能静默改变 heartbeat 概率、并发上限、默认模型或其他调度行为。

插件不应把“事实检查者”“替代路线探索者”等类型写进主流程。新的认知视角通过新增 Markdown 实体扩展。

registry 加载时逐文件校验 frontmatter。无效 Markdown 只会使对应 Shadow 被跳过，不影响其他实体和插件启动。插件在启动时显示文件路径及具体错误，并在 `/shadow status` 中持续标记；不会自动修正或改写用户定义。

`id` 省略时取 Markdown 文件名去掉扩展名；显式填写可让文件重命名后仍保持同一身份。registry 校验解析后的 ID 在全局目录中唯一，冲突的定义均不参与调度并显示错误。

`enabled` 省略时视为 `true`；只有明确设置为 `false` 的 Shadow 才退出调度。

`active_for_models` 省略时视为 `["*"]`，匹配所有 Main 模型。只有用于补偿特定模型表现的 Shadow 才需要显式声明模型列表。

每次 heartbeat 判断前，registry 检查顶层 Markdown 的文件变更，只重新解析新增或发生变化的文件，并移除已删除定义。不使用文件系统实时监听；用户手动编辑的结果在下一次 Main `turn_end` 生效。

Shadow 实例启动时取得定义的不可变快照。运行期间对 Markdown 的修改、禁用或删除只影响后续激活，不会改变或中止已有实例；需要立即停止时由用户执行 `/shadow pause`。

## 4. Shadow 上下文

Shadow 上下文以 Main 能看到的完整上下文为基础做减法，而不是重新构造一套任务背景。它完整继承 Main system prompt，包括适用于当前任务的系统级和项目级指令；随后过滤消息历史，并加入当前 Shadow Mind 的定义。

保留的消息内容包括：

- 用户消息；
- Main 的普通文本；
- 工具调用及其结果概述；
- 已注入 Main 会话的历史 `shadow-report`；
- 当前 Shadow Mind 的定义。

Main system prompt 保持完整原文，不追加 Shadow 专属 suffix，既避免 Shadow 遗漏 Main 必须遵守的约束，也使 Main 与所有 Shadow 共享完全相同的 system prompt cache。system prompt 之后只有一条真实的用户消息：先放净化后的纯文本轨迹，再声明 Shadow 公共协议和当前 Shadow Markdown 定义，最后以 kickoff 结束并启动本轮。不伪造 assistant 身份交接消息。

```text
Main system prompt
→ one user message: plain-text Main trajectory + Shadow protocol + Shadow definition + kickoff
```

公共协议保持最小，只说明：当前实例是一次性的并行认知核心；消息历史已经过净化；它可以依照自身职责独立观察或执行工作；需要向 Main 同步结果时调用 `report_to_main`，该调用会立即结束当前 loop；没有需要同步的内容时可以正常结束。kickoff 首先要求判断轨迹是否与当前 Shadow 职责相关：无关时只回复固定词 `NOT_RELEVANT` 并立即结束，不调用任何工具；相关时才继续执行职责。具体关注点、任务线和表达方式全部由 Shadow Markdown 决定。

轨迹范围覆盖当前 Main Session 从开始到激活时刻的全部历史，而不只包含当前用户 epoch。这样 Shadow 能看到早期用户约束和已经形成的会话决策。epoch 只用于判断 Shadow 的迟到结果能否介入，不参与轨迹裁剪。

这里的“全部历史”以 Main 激活时实际可见的上下文为准。Main 已发生 compaction 时，Shadow 继承压缩后的上下文，不绕过 compaction 读取已被替换的原始消息。

由于净化轨迹是 Main 上下文的严格子集，第一版不增加单独的摘要或截断机制。如果某个 Shadow 配置的 `run_with_model` 上下文窗口更小而无法容纳轨迹，则该次激活失败并记录原因，不生成介入消息。

以下内容不进入 Shadow 上下文：

- Main 的 thinking / reasoning；
- 工具返回的完整内容；
- 其他 Shadow 未上报的推理过程。

第一版原样保留工具调用参数，不额外识别或脱敏其中的密钥、令牌等内容。如果 Shadow 使用与 Main 不同的模型供应商，这些参数会随净化轨迹发送给 `run_with_model` 指定的模型；用户配置执行模型时需要接受这一信息边界。

工具调用和结果概述写在同一行，以 `·` 分隔：

```text
User: 帮我为项目设计权限系统。
Main: 我先检查现有实现。
Tool: read({ path: "src/auth.ts" }) · 成功，返回 186 行
Tool: search({ query: "UserRole" }) · 成功，3 个文件中有 7 处匹配
Main: 建议复用项目现有的 UserRole。

```

上例就是运行时实际注入的纯文本轨迹。Shadow Markdown 不出现在轨迹或 system prompt 中，而是与公共协议和 kickoff 一起放在同一条用户消息的轨迹之后。

运行时不复用 Pi 原生的 assistant tool call 与 tool result 消息角色。插件先按关联 ID 配对调用和结果，再将整个 Main 历史扁平化为普通文本；`调用 · 概述` 就是发送给 Shadow 模型的实际形式。这样历史工具调用只是一份只读记录，不会被模型误认为当前 Shadow loop 中尚待继续的原生调用。

结果概述只表达调用是否成功、结果规模和必要的状态信息，不携带完整正文。例如：

```text
read({ path: "src/auth.ts" }) · 成功，返回 186 行
search({ query: "UserRole" }) · 成功，3 个文件中有 7 处匹配
shell({ command: "npm test" }) · 失败，12 项通过、2 项失败
```

概述由插件中的工具摘要器注册表生成。每类工具拥有自己的摘要策略，例如 `read` 记录路径和行数，`search` 记录文件数与匹配数，`shell` 记录退出状态和测试统计。未知工具使用通用摘要器，只记录成功/失败、结果类型和结果规模。摘要过程不调用模型。

工具摘要器是独立扩展点；增加新工具时注册对应摘要器，不在轨迹构建主流程中持续追加类型分支。

这样，Shadow 可以观察 Main 做了什么以及行动的大致结果，但无法直接继承 Main 的证据内容和推理路径。需要核实时，Shadow 使用自己的工具重新调查，形成独立证据链。

## 5. Heartbeat 调度

第一版不识别 plan change、uncertainty、risk 等语义事件，也不使用 Gate Model。

Main model call 完成后，只有该 `turn_end` 至少包含一个已完成的工具调用，才按插件配置 `heartbeat_probability` 独立判断是否产生 heartbeat。默认值为 `1/3`：

```text
P(heartbeat after eligible tool-bearing turn) = heartbeat_probability
default heartbeat_probability = 1 / 3
```

纯文本轮次直接跳过，不消耗随机数，也不启动 Shadow。这会压制普通问答、方案讨论和 Shadow 报告后的纯文本回应产生的无效唤醒。带工具调用的中间轮次仍参与判断，因此 Main 一旦开始读取、验证或修改项目，Shadow 仍可并行介入。每个 eligible `turn_end` 根据其中工具结果的最高 `turn_weights` 计算一个 `turnWeight`；同一轮的多个工具不累加。该权重只推进 Shadow 的 `min_rounds_after_end` / `max_rounds_after_end` 进度，不改变普通路径的 `heartbeat_probability × activation_probability`。权重为 `0` 的工具轮仍然参与 heartbeat，只是不推进加权进度。Shadow AgentSession 自己的 `turn_end` 不参与 Main heartbeat。

由 `shadow-report` 触发的 Main 补充或修正只有在实际调用工具时才重新获得 heartbeat 机会，避免纯文本报告与回应形成递归唤醒链。

默认情况下，相邻 heartbeat 的期望间隔为 3 个符合条件的工具轮次，但实际间隔保持随机：可能连续发生，也可能较长时间不发生。配置了 Shadow 轮次策略后，`min_rounds_after_end` / `max_rounds_after_end` 比较的是加权有效轮次进度；达到 max 时仍进入强制路径并绕过两层概率。

调度默认使用运行时随机数；可通过 `random_seed` 配置可重复的调度序列，实际抽样值仍通过轻量调度事件保留，供事后分析。

heartbeat 发生时：

1. 读取当前 Main 模型。
2. 筛选 `enabled: true` 且 `active_for_models` 匹配的 Shadow。
3. 排除当前正在运行的同一 Shadow。
4. 排除仍处于 `min_rounds_after_end` 冷却期的 Shadow。
5. 对达到 `max_rounds_after_end` 或已经 `forcedPending` 的 Shadow 绕过 heartbeat/activation 概率，优先选择。
6. 对其余 Shadow 按自己的 `activation_probability` 独立判断是否激活。
7. 如果命中项超过 `max_parallel_shadows`，从中选择允许的数量。
8. 并行创建运行实例并传入各自的净化轨迹。

一次 heartbeat 可能不激活任何 Shadow，也可能激活一个或多个。一次 heartbeat 不等待 Shadow 完成，Main 继续工作。

`max_parallel_shadows` 是插件级调度配置，默认值为 `2`。它限制同一时刻正在运行的 Shadow 实例总数，而不仅是单次 heartbeat 新建的数量。heartbeat 只能使用剩余并发槽位：

```text
available_slots = max_parallel_shadows - running_shadow_count
```

当 Shadow 达到 `max_rounds_after_end` 但并发槽位已满时，插件记录 `forcedPending`，不突破 `max_parallel_shadows`。任意当前 epoch 的 Shadow 结束并释放槽位后，插件优先启动 pending Shadow；多个 pending Shadow 不按彼此等待时间排序，只按 registry 当前顺序选择，并继续受并发槽位限制。暂停或没有 Main 模型时不推进 eligible 轮次。

`activation_probability` 表示 heartbeat 已经发生之后，该 Shadow 被选中的基础概率。因此某个 Shadow 在单次符合条件的 Main 工具轮次后获得激活机会的基础概率为：

```text
P(activation) = heartbeat_probability × activation_probability
```

`activation_probability` 省略时使用默认值 `0.3`。在默认 heartbeat 概率 `1/3` 下，且不考虑并发槽位竞争时，该 Shadow 每次符合条件的 Main `turn_end` 的基础激活概率约为 `10%`；纯文本轮次为 `0%`。

当一次 heartbeat 的命中数量超过剩余并发槽位时，并发上限会进一步降低每个命中项的最终激活概率。

Main 在会话中切换模型后，后续 heartbeat 直接依据新模型重新筛选。

## 6. Shadow 的输出与介入

Shadow 可以得出“没有值得介入的发现”，此时保持沉默。插件不要求每次激活都产生消息。

当 Shadow 发现问题或完成并行工作后，可以调用 `report_to_main` 提交一条面向 Main 的简洁结果。Shadow 不决定投递方式，插件根据 Main 当前状态选择交付方式：

```text
Shadow 返回
├── Main 仍在运行
│   └── 使用 steer，在下一次认知边界注入
│
├── Main 已最终回复，但用户尚未开始下一轮
│   └── 触发 follow-up，让 Main 补充或修正
│
└── 用户已经开始下一轮
    └── 丢弃旧结果
```

最终回复不会立即终止正在运行的 Shadow。迟到结果仍可在下一条用户消息到来前触发补充回复。

每个用户任务拥有递增的 `epoch`：

```text
Shadow started at epoch 12
Shadow returned during epoch 12  → 可以介入

User sends a new message
Current epoch becomes 13
Running Shadow from epoch 12     → 立即中止并回收
```

新用户消息开启 epoch 时，插件立即中止所有属于旧 epoch 的 Shadow AgentSession，释放并发槽位，并丢弃聚合窗口内尚未发送的旧结果。返回与 epoch 切换恰好并发时，发送前再次校验 epoch。

用户手动中止 Main 当前任务时，插件同步中止当前 epoch 的全部 Shadow AgentSession，清空待发送的聚合报告并释放并发槽位。中止操作不触发 Main 的补充回复。

Shadow 严格绑定启动它的 Main Session。用户切换、替换或关闭 Session，以及插件卸载或运行时关闭时，插件立即中止该 Session 的全部 Shadow、清空报告聚合并释放资源；结果不会跨会话投递，也不会等待后台实例完成。

这允许 Main 保持非阻塞，同时避免旧 Shadow 干扰新的用户任务。第一版接受用户偶尔先看到初始回答、随后看到补充或自我修正。

### 多结果聚合

多个 Shadow 几乎同时返回有效意见时，插件不会立即逐条注入。结果先进入一个短暂的聚合窗口，再组合成一条消息：

```text
[项目事实检查者]
Main 声称项目已有 UserRole，但当前轨迹不足以支持该结论。

[约束检查者]
当前方案遗漏了用户要求的访客只读访问。
```

聚合只负责按 Shadow 名称分段拼接，不调用额外模型进行总结或去重。插件配置 `result_batch_window_ms` 控制收集窗口，默认值为 `400`。

聚合消息仍遵循 epoch：窗口内混入的过期结果在发送前被丢弃。

聚合结果以可见的 `shadow-report` 自定义消息写入 Main 会话，并保留各 Shadow 名称作为来源。它不会伪装成用户消息；Main 与用户都能识别这是插件产生的并行认知报告。运行时再根据 Main 状态，将该自定义消息按 `steer` 或 follow-up 方式交付。

`shadow-report` 在聊天中采用紧凑展开样式，直接显示章鱼标识、来源 Shadow 名称和完整报告内容，但视觉层级弱于用户消息和 Main 普通回复，不使用大型对话气泡，也不默认折叠。

历史 `shadow-report` 会进入后续 Shadow 的净化轨迹，形成显式反馈链。新的 Shadow 可以结合 Main 对既有报告的响应继续复查：问题已解决则保持沉默，尚未解决则再次上报。

Shadow 自己的静默工具调用和行动摘要不进入 Main 消息历史，也不进入后续 Shadow 的净化轨迹。它们只体现在共享的外部环境、Main Session 的轻量观测 entries 和可选 debug 日志中。Shadow 之间的显式认知传播只通过 `shadow-report` 发生。

## 7. 运行状态

插件需要维护的状态保持在最小范围：

```text
current epoch
current Main model
model call count
heartbeat_probability
max_parallel_shadows
result_batch_window_ms
default_shadow_timeout_seconds
Shadow activation probabilities
turn_weights
per-Shadow weighted progress counters
per-Shadow forced-pending state
running Shadow IDs
active Shadow runs and their start epoch
lightweight Shadow run events in Main Session custom entries
```

Shadow Markdown 是定义，不承担日志和运行状态。调度记录、运行结果和统计数据不应持续写回定义文件。

Shadow 的临时 AgentSession 不跨激活复用，也不写回记忆。

轻量事件属于运行观测数据，不参与任何 Agent 的上下文。`debug: true` 产生的完整 Session 日志也只用于调试，不会成为后续 Shadow 的记忆。

插件提供 `Alt+S` 快捷键以及 `/shadow toggle`、`/shadow pause`、`/shadow resume` 命令，只控制当前 Main Session 是否继续产生 heartbeat，不修改全局 Shadow Markdown。执行 pause 时立即中止当前 Session 已运行的 Shadow、清空尚未发送的聚合结果并释放并发槽位；resume 后从后续 Main `turn_end` 恢复概率判断。暂停时底部状态固定显示 `🐙 Paused`，不展示恒为零的运行数量。

同一个 Shadow 在前一次实例仍运行时不重复激活；不同 Shadow 可以并行运行。

如果配置了轮次策略，前一次实例结束后按 eligible 工具轮次推进该 Shadow 的独立计数。前 `min_rounds_after_end` 个轮次不会触发；达到 `max_rounds_after_end` 后进入强制触发状态。会话开始时没有上一次实例的 Shadow 也从第一个 eligible 轮次开始遵守该策略。

## 8. 第一版范围

第一版包含：

- 从 Markdown 发现和加载多个 Shadow Mind；
- 隔离无效定义并提供持续可见的校验错误；
- 每次 heartbeat 前增量刷新全局 registry；
- 维护全局 Shadow registry；
- 每次激活创建并在结束后销毁全新的临时 AgentSession；
- 用户和 AI 创建、修改、启用与停用 Shadow；
- AI 写入全局 Shadow registry 前取得用户确认；
- 按 Main 模型筛选 Shadow；
- 为每个 Shadow 配置执行模型，并支持插件级默认模型；
- 纯文本 Main 轮次跳过 heartbeat，只在完成工具调用的轮次参与调度；
- 通过 `heartbeat_probability` 配置随机 heartbeat，默认概率为 `1/3`；
- 每个 Shadow 按自己的概率参与 heartbeat；
- 通过 `turn_weights` 配置工具类别的加权有效轮次，单个 `turn_end` 取最高权重；
- 通过 `min_rounds_after_end` / `max_rounds_after_end` 可选配置每个 Shadow 的加权进度冷却和强制触发；
- `max_rounds_after_end` 到期时绕过两层概率，槽位满载时保留 `forcedPending` 并在槽位释放后优先启动；
- 通过 `max_parallel_shadows` 配置最大并行数量；
- 构造净化轨迹；
- 默认使用当前 Main Session 的全部净化历史；
- 通过工具摘要器注册表生成结果概述，并提供通用兜底；
- Shadow 独立使用工具进行检查；
- 通过内置 `report_to_main` 工具显式提交介入内容；
- `report_to_main` 调用后立即终止对应 Shadow Agent loop；
- 为每个 Shadow 配置工具白名单，默认使用 Pi 的 `readOnlyTools`；白名单中的额外工具视为已授权；
- 提供插件级默认运行超时，并允许单个 Shadow 覆盖；
- 记录轻量运行事件并提供 `/shadow status`；
- 为 `debug: true` 的 Shadow 保存完整临时 Session 日志；
- 每次 Shadow 激活使用一个独立日志文件，并记录最终状态；
- 调试日志采用 Pi 原生 Session JSONL 并增量写入；
- 运行中使用 `steer`，Main 结束后使用 follow-up；
- 在短聚合窗口内合并同期 Shadow 意见后一次性注入；
- 使用可见的 `shadow-report` 自定义消息呈现聚合结果；
- 使用 epoch 丢弃跨用户任务的迟到结果。
- 新 epoch 开始时立即中止旧 epoch 的 Shadow 并释放资源；
- 用户手动中止 Main 时同步停止当前 epoch 的 Shadow；
- 支持按 Main Session 暂停和恢复整个 Shadow 系统；

第一版明确不包含：

- 项目级 Shadow 及全局/项目覆盖规则；
- 语义 Gate 或 Expected Value of Thinking 预测；
- 根据错误、风险、计划变化等事件进行规则调度；
- 学习型调度器；
- Shadow 之间通信；
- 将 Main thinking 或完整工具结果暴露给 Shadow；
- 根据历史表现自动训练或优化 Shadow；
- Shadow 的跨次运行记忆。
- Main、Shadow 与第三方工具之间的写入并发保护。

## 9. 验证方式

使用同一组任务比较：

```text
Single-core Pi
vs
Pi + multiple Shadow Minds
```

第一阶段重点观察：

- Shadow 是否发现了 Main 未发现的问题；
- Shadow 的介入是否改变了 Main 的后续行为；
- 是否减少项目事实编造、遗漏约束和错误路线；
- 无效或有害介入的比例；
- heartbeat 频率和并行数量带来的成本与延迟。

这些运行数据将决定后续是否值得引入更复杂的调度，而不是在第一版提前设计智能 Gate。
