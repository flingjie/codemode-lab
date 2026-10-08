# 30 分钟体验 Code Mode：找出最需要跟进的 5 条工单

目标：亲自观察哪些工作需要模型判断，哪些可以通过一次生成的程序完成。场景可替换为订单核对、客户跟进、仓库 issue、候选人筛选。

## 环境与范围

Node.js 20+；无需安装依赖。第一轮不需要 API key；第二轮使用真实模型 API，需要支持 Chat Completions 和 function calling 的服务。数据全部合成。

这是教学用工具编排实验。`run` 在本地 Node 中加载程序，**没有安全沙箱**，只运行自己检查过的实验代码。它模拟 Code Mode 的组合调用与输出选择，不复现 Pi 的宿主沙箱、工具发现、多模态或持久执行。

## 任务与验收规则

40 条工单中，选出 status=open、至少 7 天没有回复、负责人仍 active 的工单。按 severity 降序、未回复天数降序、id 升序排序，取前 5 条。输出 id、severity、days_since_reply、owner。不得用正文猜测优先级。

三个工具：

| 工具         | 入参           | 返回字段                                         |
| ------------ | -------------- | ------------------------------------------------ |
| list_issues  | {}             | 工单数组：id/title/severity/owner_id/status/body |
| get_activity | {id: 工单ID}   | id/days_since_reply/comments                     |
| get_owner    | {id: 负责人ID} | id/active/name/bio                               |

正文刻意较长，用于观察中间数据搬运开销。所有模式用相同数据。

## 第一轮：5 分钟观察机制

在此文件所在目录运行：

```bash
node lab.mjs compare > comparison.json
```

先猜结果再打开 comparison.json：

1. 同样串行，Code Mode 会不会更快？
2. 并发相同，Code Mode 的收益还剩什么？
3. 工具调用数量减少了吗？

四个模式使用完全相同的底层调用与筛选规则：

| 模式              | 调用方式   | 进入模拟模型上下文的数据 |
| ----------------- | ---------- | ------------------------ |
| native-sequential | 串行       | 每次完整返回             |
| native-grouped    | 并发上限 4 | 每组完整返回             |
| code-sequential   | 串行       | 最终 5 条                |
| code-parallel     | 并发上限 4 | 最终 5 条                |

**此轮没有调用任何 LLM。** elapsed_ms 仅为本地模拟工具与程序耗时；modeled_context_bytes 是选定边界上 UTF-8 字节数，不是 token；modeled_observation_boundaries 是设计的结果交付次数，不是实测模型请求数。工具延迟为模拟延迟。该轮不能证明某模型更快或更准。

预期：串行与并发各自耗时接近；Code Mode 将中间结果留在程序中，所以返回数据较少；工具数量不变。native-grouped 说明原生调用也可以并发。真实 Harness 还可能裁剪返回或提供批量工具，从而缩小差异。

## 第二轮：真实模型对照

`real.mjs` 直接请求模型 API，A 使用原生 function calling，B 通过 execute_code 生成 JavaScript 并在本地 Worker 内编排相同工具。工具通过宿主代理执行，程序只能通过返回值将中间结果交回模型。它是通用教学实现，不复现任何厂商的专有 Code Mode 产品。

**执行边界：Worker 和 Node VM 不是安全沙箱。** 生成的代码仍可能利用运行时逃逸访问本机；只在一次性容器或低权限隔离环境运行。API key 在宿主中用于请求，不主动传给 Worker。`--allow-code` 表示你了解该教学运行器会执行模型生成的代码。完整模型响应（包括可能的推理内容）保存到本地结果文件，不保存 API key。只使用本实验合成数据。

配置你的服务；base URL 需填到 `/chat/completions` 的上一级。以下是占位值，替换成服务实际地址、模型 ID 和 key。建议先选择支持工具调用的非思考模型；不同供应商的专属参数不保证兼容。

```bash
export LLM_BASE_URL='https://model-gateway.shuwenda.icu/v1'
export LLM_MODEL='deepseek-v4-pro'
read -rsp 'API key: ' LLM_API_KEY; echo
export LLM_API_KEY

# 先跑一对，确认服务兼容。会产生模型 API 费用。
node real.mjs --allow-code --runs 1 --count 40 --out results/smoke

# 基线：5 个种子，每个种子 A/B 各一次，共 10 个任务。
node real.mjs --allow-code --runs 5 --count 40 --out results/40

# 数据扩大，仍用相同模型。
node real.mjs --allow-code --runs 5 --count 200 --out results/200

# 临时失败：第一个开放工单的首次活动查询失败。
node real.mjs --allow-code --runs 5 --count 40 --fail --out results/failure
```

运行时间取决于模型速度；5 次重复可能超过 30 分钟。每个场景生成 `summary.json` 和每次运行的完整响应轨迹。先跑一对再扩大，避免未验证兼容性就产生大量费用。API 错误不自动重试，标为 error；工具暂时失败由模型或程序决定是否重试。默认每任务最多 80 个 API 请求，每个响应最多 4096 输出 token，可用 `--max-turns`、`--max-tokens` 调整预算。

| 条件               | A：native                  | B：code          |
| ------------------ | -------------------------- | ---------------- |
| 模型、温度         | 相同，默认温度 0           | 相同             |
| 业务工具、合成数据 | 相同                       | 相同             |
| 物理工具并发       | 宿主限制最多 4             | 宿主限制最多 4   |
| 缓存               | 宿主缓存成功结果           | 相同             |
| 重试               | 每个工具与 ID 最多两次尝试 | 相同             |
| 失败注入           | 相同工单首次活动查询失败   | 相同             |
| 中间数据           | 完整工具结果进入上下文     | 程序决定返回内容 |
| 最终输出           | Top 5 的 ID 数组           | 相同             |

真实模型实验会按种子改变严重程度、负责人、状态和未回复天数，减少模型推导合成命名规律的机会。相同种子的 A/B 使用相同数据、独立状态；交替运行 A/B 顺序，减少顺序影响。验证器在宿主中计算标准答案，不计入任务耗时，也不交给模型。第一轮保留旧固定数据，方便复现原有演示结果。

记录指标：

- `correct/status`：ID 及排序是否与标准答案完全一致；wrong_answer、error、turn_limit 都作为失败，统计时不能剔除。
- `elapsed_ms`：模型请求、工具执行、代码生成与修正的总时间；不含验证器计算和结果落盘。
- `prompt_tokens/completion_tokens/total_tokens`：逐请求累加服务 usage；任何请求缺失对应字段，该累计值为 null。
- `model_requests`：客户端 API 请求尝试次数，不等于供应商内部推理次数。
- `calls/failures/peak_concurrency`：底层实际工具执行情况；缓存命中不算物理调用。
- `code_executions/code_errors`：B 的代码执行次数与失败数。
- `context_result_bytes`：工具结果回传模型的字节数；与真实 token 分开记录。
- `estimated_cost`：默认 null。可设置 LAB_INPUT_PRICE、LAB_OUTPUT_PRICE（每百万 token 价格），但估算不包含缓存折扣等特殊计价；实际费用以账单为准。

先比较全部任务的成功率，再比较耗时和 token。成功与失败样本分别展示耗时，避免把提早失败误认为更高效。5 对只用于探索，不证明普遍性能优势。模型训练效果也不能靠这一个对照实验归因。

离线验证运行器：

```bash
node verify.mjs
```

它使用假 API 响应验证协议、队列、缓存、失败恢复、超时、标准答案与 usage 累计，**没有调用真实模型**。实验包不包含已测得的真实模型成绩。

## 第三轮：10 分钟改条件、制造失败

先预测变化，再执行：

1. 将阈值 7 天改为 10 天，Top 5 改为 Top 3。看看 Agent 是重新搬运全部数据，还是修改程序规则。
2. B 运行 `node lab.mjs run my-program.mjs --fail`：工单 13 的活动查询在本次运行首次调用时失败。要求明确的有限重试；不得静默跳过。每次新 run 都重置故障注入。
3. 让程序先过滤未回复天数，再查负责人，并对 owner_id 去重。调用数为何减少？这来自流程优化与缓存，不应全部归因于 Code Mode。
4. 改成“哪些工单反映产品定位有问题”。原来的排序程序是否够用？它可以整理材料，但这一步需要语义判断、额外证据或模型调用。

参考程序最后再看：

```bash
node lab.mjs run example.mjs
node lab.mjs run example.mjs --fail
```

本实验只注入暂时性读取失败，没有模拟写入副作用、断点恢复或真正的持久执行。增加发邮件、退款等工具时，应由领域服务处理权限、幂等与状态，而非依赖一次生成的程序保证。

## 怎样判断自己感受到了价值

你能指出：程序省掉了哪些数据进入模型、哪些重复决策；原生并发能获得哪些相同收益；何处仍需要模型读取新反馈。

如果只有两次小查询，编程成本可能高于收益；如果是大量关联、筛选和重复调用，程序组合更值得试。对已经稳定的重复任务，把验证后的逻辑沉淀为普通领域服务，不必每次重新生成。

## 扩展实验

真实模型实验目前固定 7 天、Top 5。要改成 10 天、Top 3，请同时修改 real.mjs 的任务提示和 lab.mjs 的 select 验证规则，避免任务与标准答案不一致。

下一步可增加多个模型、字段裁剪与批量工具。一次只改变一个条件。换成涉及语义判断的任务时，还要定义标注答案或人工评审标准。

背景阅读：https://lucumr.pocoo.org/2026/10/6/codemode/
