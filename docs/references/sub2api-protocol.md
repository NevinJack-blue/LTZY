# Sub2API · 协议转换与网关转发

> 快照：`references/sub2api`。这是它最核心的工程资产。

## 0. 四条设计约定（所有机制的源头）

| 约定 | 含义 |
|---|---|
| **端点常量单一来源** | 入站/上游路径只在 `endpoint.go:17-38` 定义一次 |
| **入站端点归一化** | `/antigravity/v1/messages`、`/openai/v1/responses`、`/backend-api/codex/responses`、`/v1beta/models/gemini:gen` 全部折叠为 canonical form |
| **上游端点由平台推导** | OpenAI/Grok 一律转 `/v1/responses`；Anthropic→`/v1/messages`；Gemini→`/v1beta/models` |
| **协议判定单一函数** | 上游协议只由 `resolveUpstreamProtocol` 决定，三个入口共用 |

> 注意：`DeriveUpstreamEndpoint` 的 OpenAI 分支**保留 raw path 的 `/responses` 子路径后缀**，这是 `/v1/responses/compact` 能独立识别的原因；compact 检查必须早于 root Responses，否则前缀匹配误命中。

## 1. 入口端点（约 60 条路由，分 6 组）

| 组 | 代表路径 |
|---|---|
| `/v1` 主网关 | `/messages`、`/messages/count_tokens`、`/responses`(+subpath, GET=WS)、`/chat/completions`、`/embeddings`、`/alpha/search`、`/models`、`/images/*`、`/videos/*`、`/tts`、`/stt`、`/realtime`、`/web_search` |
| `/v1beta` Gemini 原生 | `/models`、`/models/*modelAction`（通配段承载 `{model}:{action}`）、`/cachedContents` |
| **根路径别名** | `/responses`、`/chat/completions`、`/models`… 为 Cursor、Codex 裸路径客户端服务 |
| `/backend-api/codex` | `/:call_id`、`/responses`、`/alpha/search`、`/models`（Codex manifest 格式） |
| **Antigravity 专用** | `/antigravity/v1/{messages,models}`、`/antigravity/v1beta/*`，`ForcePlatform` 强制平台 |
| WebSocket | `GET /v1/responses`、`/responses`、`/backend-api/codex/responses`、`/realtime` |

中间件链：`groupBodyLimit → clientRequestID → opsErrorLogger → **endpointNorm** → apiKeyAuth → groupModelAllowlist → rejectConflictingFields → compositeTarget → requireGroupAnthropic`

Gemini 组用 `APIKeyAuthWithSubscriptionGoogle`，支持 `x-goog-api-key`、`?key=`、`?api_key=` 三种凭证位置。

## 2. 协议转换矩阵（4×4）

转换全部在 `internal/pkg/apicompat/`，无状态纯函数 + 有状态流机。

| 入站 ↓ \ 上游 → | Responses | Chat | Anthropic | Gemini |
|---|---|---|---|---|
| **Anthropic** | `AnthropicToResponsesWithOptions` | `AnthropicToChatCompletionsRequest…` | **零转换直通** | `convertClaudeMessagesToGeminiGenerateContent` |
| **Responses** | 透传 | `ResponsesToChatCompletionsRequest…` | `ResponsesToAnthropicRequest` | — |
| **Chat** | `ChatCompletionsToResponsesWithMinOutputTokens` | 直通 | **链式** CC→Responses→Anthropic | `ForwardAsChatCompletions` |
| **Gemini** | — | — | `convertGeminiToClaudeMessage` | `ForwardNative` |

> 链式转换是它降低 N×N 复杂度的手段：Chat→Anthropic 走「Chat→Responses→Anthropic」两跳复用。

### 关键字段映射细节

**Anthropic → Responses**：
| 字段 | 规则 |
|---|---|
| `system` | → `input[]` 首项 role=**developer**。刻意**不用** `instructions`，以保持 conversation/cache 形状 |
| `system` 内 `x-anthropic-billing-header:` | 丢弃（Claude Code 计费归因块） |
| `tool_result` 内 image | Responses `output` 只收字符串 → 图片提取到**后续 user message** |
| `thinking`（有 signature） | → `reasoning` + `encrypted_content`；**跳过 `gAAAA`**（GPT/Codex 风格）与 `ccswitch-openai-reasoning-v1:` 信封（xAI 会 400） |
| `thinking`（无 signature） | **完全丢弃**（不能当纯文本） |
| `temperature`/`top_p` | **仅非推理模型**转发（gpt-5+ 会 `Unsupported parameter`） |
| `stop_sequences` | **不映射**（Responses 无对应） |
| `tool_choice` | `auto→auto`、`any→required`、`none→none`、`tool→{type:function,name}` |
| `thinking.type=disabled` | → effort `"none"`（**覆盖** `output_config.effort`） |
| 固定注入 | `include:["reasoning.encrypted_content"]`、`store:false`、`parallel_tool_calls:true` |

**Chat → Anthropic**：
- user 纯文本**折叠为单字符串**（严格 Chat 上游拒绝数组 content），有图才用 parts 数组
- `thinking` → `reasoning_content`，**仅当该 assistant 消息带 tool_calls**
- `tool_choice` 具名 choice **只在指向已声明工具时**转发（否则上游 400）
- **DeepSeek 风格「只有 reasoning 无正文」** → reasoning 提升为可见 text，避免空回合

**Claude → Gemini**：
- `functionCall/functionResponse` 的 `id` **强制剥离**（部分上游拒绝该字段）
- `tools[].input_schema` 经 `cleanToolSchema` **递归清洗** Gemini 不支持的 JSON Schema 关键字，enum 归一化、整型边界自增
- `web_search*` → `tools[].googleSearch`（**仅显式 server 类型**；同名普通 function 不提升）

**Gemini → Claude**：
- `functionCall` 无 id → 网关自造 `"toolu_" + randomHex(8)`
- `inlineData` → markdown 图片写在 text 块内

**Codex → 内部端点**（`applyCodexOAuthTransformWithOptions`）：
`store` 强制 false、`stream` 强制 true；compact 变体**删除** store 与 stream；删 `openAICodexOAuthUnsupportedFields`；`input[]` 中 `role:system` **镜像进 `instructions`**（internal 端点不接受 system role）；`input` 为字符串时转数组；续链保留 `item_reference` 与 `call_id`。

## 3. 流式转换：三个必须解决的难题

### 难题 1：工具名后到、参数先到
Chat 上游常先发 `arguments` 再发 `name`，但 Anthropic 的 `content_block_start` **必须带 name**。

解法：按 tool_call index 建四张缓冲表（`toolBlockIndex`/`toolAnnounced`/`toolName`/`pendingToolArgs`），name 到齐才公告并把缓冲参数一次性刷出；**name 永不到达的工具在 finalize 时以空 name 公告**，避免参数静默丢失。

### 难题 2：Gemini 的累积/增量二义性
Gemini 流有时发累积全文、有时发增量、有时重复回退。三态判别：
```
incoming 以 seen 为前缀 → 累积模式，只发差量
seen 以 incoming 为前缀 → 重复/回退，丢弃
否则                    → 增量模式，直接发
```

### 难题 3：Responses 严格客户端的字段存在性
Codex CLI 等 Rust serde 客户端对 `output_index=0`、`content_index=0`、空 `arguments`、`content:[]`、`sequence_number` 都要求字段**存在**。Go 的 `omitempty` 恰好会丢掉零值。

解法：`ResponsesStreamEvent.MarshalJSON` 对每个事件类型**逐一手工构造** wire 对象，而不是 marshal + 补丁。

## 4. 长流保活：四层独立机制

| 层 | 机制 | 参数 |
|---|---|---|
| **TCP** | `KeepAliveConfig` + Linux `TCP_USER_TIMEOUT` | idle 15s/count 3 → 断链 **30s 内中止**（旧默认 165s） |
| **HTTP/2** | 主动 PING | 长流 `ReadIdleTimeout=10s`+`PingTimeout=5s` |
| **SSE 下游** | 空闲 keepalive 帧 | 默认 10s |
| **SSE 等待期** | 排队 ping | 默认 10s |

**HTTP/2 PING 的必要性**：Go 默认惰性配置 http2 且 `ReadIdleTimeout=0`（不发健康 PING），被代理/NAT 静默掐断的连接会成为**「两端都以为存活」的死连接**，请求落上去会挂到 TCP 重传超时（分钟级）。主动 PING 让死连接在 15s 内被发现。

**SSE keepalive 的三种线格式**（按客户端切换）：
| 客户端 | 帧 |
|---|---|
| Anthropic 通用 | `event: ping` + `{"type":"ping"}` |
| **Claude Code ≥ 2.1.193** | **noop delta**（在已开启块上发零长度 delta，因新版本对纯 ping 帧处理有变化） |
| OpenAI / Codex | SSE 注释 `:\n\n` |
| **Gemini（go-genai/python-genai）** | **不发注释帧** |

> Gemini 特例原因：官方 `go-genai` 的 `iterateResponseStream` 对任何非 `data:` 前缀事件直接报 `invalid stream chunk: :`，`python-genai` 把非 `data:` 行当错误 JSON 拼接后抛错。因此按 UA 识别后关闭注释帧；`js-genai` 用规范解析器可正常忽略。

**上游超时与下游解耦**：SSE 读取在独立 goroutine，主循环 select「数据事件 / 上游数据间隔超时 / keepalive 定时器」，避免下游写阻塞误判为上游静默。
**客户端断开后继续 drain 上游**以获取完整 usage 用于计费。

## 5. WebSocket 转发

- Turn 生命周期钩子：`ClientLifecycleContext`（独立于 ingress lease 的下游写绑定）、`InitialRequestModel`（计费归属）、`BeforeTurn`/`AfterTurn`
- 连接池：最大年龄 60min、健康检查空闲 90s、热路径探活 2s、后台探活 **10s**（经代理 pong 实测最大 1.7s，误判代价远大于多等）
- **后台 PING 清扫的并发安全**：失败时**必须先 `tryAcquire()` 拿到租约令牌才允许剔除** —— 判断与占有必须是同一个原子动作，否则 pong 等待期间刚被借出的连接会被从借用者手里关掉
- Turn 级可重试：记录 `stage`（write/read/`previous_response_not_found`）与 `wroteDownstream`，**只有未写过下游**才允许换号重试
- 事件批量写：攒批 4 条 / 25ms，降低帧开销

## 6. 原生客户端兼容（反检测核心）

### Claude Code 双重验证
1. `User-Agent` 必须匹配 `^claude-cli/\d+\.\d+\.\d+`
2. `count_tokens` 辅助请求、`max_tokens=1` 探测请求放行
3. messages 严格校验：**system prompt 相似度 ≥ 0.5** 命中 6 条官方模板之一；`X-App`、`anthropic-beta`、`anthropic-version` 非空；`metadata.user_id` 过格式校验

另有一条更严格的独立判定：UA 匹配 **且** `metadata.user_id` 格式合法 —— 防止 opencode 等第三方伪造 UA。

**`max_tokens=1` 探测的处理**（三条互补规则）：
| 规则 | 条件 | 行为 |
|---|---|---|
| 校验绕过 | `max_tokens=1` 且 model 含 haiku | 跳过 system prompt 检查 |
| 校验绕过（泛化） | 请求体 `max_tokens ≤ 1`，**不限模型** | CLI 切模型/刷上下文时会对当前模型发轻量请求 |
| **本地拦截** | Claude Code + `max_tokens=1` + haiku | **不访问上游**，直接返回 mock `"#"` |

拦截三类（`IsInterceptWarmupEnabled` 时生效）：
- `Warmup`（"write a 5-10 word title"）→ `"New Conversation"`
- `SuggestionMode`（`[SUGGESTION MODE:` 开头）→ 空字符串
- `MaxTokensOneHaiku` → `"#"`

> 识别前有**快速短路**：请求体不含 `[SUGGESTION MODE:` / `title` / `Warmup` 任一关键字则直接返回 None。

### Codex CLI
- `client_metadata["x-codex-installation-id"]` 注入账号 device_id（三种形态兼容，已有非空值不覆盖）
- `x-codex-turn-state` / `x-codex-turn-metadata` 头透传用于多轮续链
- WS beta 头档位 v1 直接拒绝（保持行为确定性）
- `/v1/models?client_version=` → Codex manifest 格式
- tool 名反向映射（上游保留名 ↔ 客户端名）

### Gemini CLI
**粘性会话不依赖 UA**，从请求体正则提取 CLI 的 tmp 目录哈希：
```
tmpDirHash = regex(body)      // 无 tmp 目录 → 不用粘性会话
sessionHash = sha256(privilegedUserID + ":" + tmpDirHash)
```

### 其它指纹对齐
- **TLS 指纹伪装**（utls 模拟 Claude CLI），支持直连/HTTP CONNECT/SOCKS5 三种隧道
- Grok CLI 代理版本固定（host/env/version 在 `pkg/xai` 统一定义，三处共用同一身份）
- 账号级 header 覆盖 + 账号级 TLS 指纹 profile + Redis 广播失效

## 7. 请求体处理优化（性能关键）

**问题**：旧实现同一 body 被解析 3 次（handler 取 model/stream、service 取 system/messages、`GenerateSessionHash` 取会话字段）。

**方案**：
| 机制 | 说明 |
|---|---|
| `RequestBodyRef` | 借用不可变 `[]byte`，不拷贝 |
| **解析快照** | 标量存字符串，大字段（system/messages/input）只存**偏移区间** `jsonRange{start,end,kind}` |
| **复用双重校验** | 切片**身份**（`&data[0]` 指针相等）+ **内容指纹** `maphash.Bytes`。身份校验信任借用契约，指纹额外捕获共享存储的原地改写 |
| **延迟解码** | 只有真正需要结构化数据时才 Unmarshal 该区间 |
| `ParseGatewayRequestValidated` | 跳过 JSON 全量校验 —— 1 MiB body 上**省约 510 µs（占解析耗时七成）** |
| **编辑走 sjson** | 所有改写（模型名、`store`/`stream`、`reasoning.effort`、删字段）都用 `sjson.SetBytes/DeleteBytes` 字节级改写 |

### 内存预算（防 OOM）
- `BodyMemoryBudget`：**跨请求**的入站缓冲总量上限，超限 → 503 + `Retry-After: 1`（与 413 单请求上限、非法 JSON 明确区分）
- 预算保留到 HTTP 请求结束；瞬态容量在等待期间复用，失败分配退款
- 预读不拷贝：`PrereadBody` 全量预读后直接返回其切片
- 解压/宽松化共享同一预算
- **按路由选上限**：纯文本入口用 `TextMaxBodySize`，因为分组链中间件在 handler 前就读完 body，路由级上限来不及生效
- 压缩炸弹防护：zstd 拒绝超大 window，超限直接报错而非截断

### 流式内存
- 64 KiB scanner 缓冲 `sync.Pool` 复用
- `sseQueueBudget`（默认 8 MiB）：**单行大于预算则占满整个预算** —— 合法图片帧仍能过，但无法填满全部 16 个队列槽
- 出队释放而非关闭释放
- **事件级上限**：单事件 ≤ MaxLineSize / 4096 行 —— 防止上游「永不发空行」绕过单行上限
- `ReadLineString` 零拷贝转字符串（行是全新分配、无人持有，用 `unsafe.String` 移交）

## 8. 多实例协调（三套机制，按数据类型选）

### Leader Lock（互斥型后台任务）
降级链：
```
Redis 抢到 → release func
Redis 被同伴持有 → (nil,false)，本周期跳过
Redis 报错 → **降级 PG advisory lock**
两者都不可用 → 不加门直接运行，**永不静默饿死任务**
```
**Release 是 compare-and-delete**（按 owner 比对），过期的持有者永远无法删掉同伴的锁。
语义要点：TTL 仅作崩溃安全界；任务完成立即释放，因此**每周期重新竞争**而非固定钉在某实例。

**节奏桶设计**（值得学）：`upstreamBillingProbeLeaderLockKeyAt(now)` = `key + ":" + now.Unix()/cycleInterval` —— 键随调度节拍变化，错峰实例也能在**同一节拍窗口**内互斥，而非各跑一遍。

### 缓存广播（Pub/Sub 失效通知）
配置类数据用 Redis Pub/Sub 广播「已变更」，各实例清本地缓存，**而非广播完整数据**。
通道：渠道、API Key 鉴权、订阅计费、错误透传规则、TLS 指纹模板、prompt audit 配置版本。

### 调度读模型（Outbox，**不是** Leader 锁）
账号调度快照是**所有实例都要消费**的读模型，因此不能用 leader 锁。

| 机制 | 说明 |
|---|---|
| 轮询 | 读 Redis watermark → `ListAfterAndReleaseDedup(watermark, 200)` → 逐事件处理 → 推进 watermark（重试 3 次）→ 清理 |
| 消费语义 | 只有 watermark 成功推进，本批才算已消费 |
| **滞后检测** | 延迟按**下一条待消费事件**计算 —— 否则「处理越慢 → 越易触发更慢的全量重建」形成**正反馈** |
| 健康路径优化 | 空批次只做一次查询就清除退化状态 |
| 快照分桶 | `SchedulerBucket{groupID, platform, mode}` |

## 9. 错误映射与失败追踪

### 三层错误映射
1. **上游状态码 → 网关状态码**（按家族四个函数）
2. **错误体格式按入站协议对齐**（客户端 SDK 只认自己的形状）：Anthropic `{"type":"error",...}` / OpenAI `{"error":{...}}` / Gemini Google 格式
3. **可配置透传规则**：管理员按平台 + 状态码 + body 关键词匹配，命中则原样透传

> 关键词匹配上限 **8 KiB**（「错误信息不会在 8KB 之后才出现」），body 小写化延迟一次。

### 流中错误（已 flush 后 HTTP 200 已固化）
| 入站 | 流内错误帧 |
|---|---|
| Anthropic | `event: error` + `{"type":"error",...}`（仅发一次） |
| **Responses** | **`event: response.failed`** + 完整 `response` 子对象 |

`response.failed` 的必要性：通用 `event: error` 帧**不是** Responses 协议规定的终止事件，Codex CLI 等严格 SDK 会抛 `stream closed before response.completed`。
`created_at` 与 `sequence_number` **刻意不带 omitempty** —— 严格客户端当必填字段。

### 失败请求追踪
中间件用**带捕获的 ResponseWriter** 旁路采集，不侵入 handler：
- 增量探测终止 SSE 帧（`response.completed/failed/incomplete/cancelled`），**仅在可能命中时才检查**
- 双通道采集：流式按帧边界累积、非流式整体捕获
- 错误分类：`error_owner`（本地 vs 上游）+ `error_source`
- **本地业务限制标记** `MarkOpsClientBusinessLimited`，与真实上游错误区分，**避免污染上游指标**
- 有界队列 + worker 批量写入 + 队列压力可观测（length/bytes/dropped）

### 失败转移纪律（最重要）
| 纪律 | 说明 |
|---|---|
| **已写字节即禁止 failover** | Forward 前记录 `c.Writer.Size()`，返回后若增长说明 SSE 内容已发，无法撤销，禁止换号以避免**流拼接腐化** |
| 错误已由上游写出则不重复写 | |
| **部分 usage 也要入账** | 流中断但已观测到 usage 的部分结果走同一路径，否则上游已计量的请求**完全漏计费** |
| 失败分类驱动策略 | `UpstreamFailoverError` 携带 `GatewayFailureReason` |
| 请求域退避 | 从 `Retry-After`/`x-ratelimit-reset-*` 解析，上限 8s |

## 10. 设计取舍与风险

1. **`max_tokens=1` 放行已泛化到任意模型** —— 理由充分但严格校验边界从「haiku 探测」放宽到「任何 1-token 请求」
2. **TTL 依赖人工调参** —— 要求 TTL > 任务最坏运行时长，纯约定无运行时保护
3. **Redis 抖动降级到 PG advisory lock** —— 若 Redis 频繁抖动且 DB 也承压，存在**降级风暴**可能；不同任务策略不一致（`upstream_billing_probe` 选 fail-closed 而非降级）
4. **`ParseGatewayRequestValidated` 与未校验版本语义不同** —— 靠约定维持的不变量
5. **Antigravity 的 `preserveChatCompletionTokenLimit` 是补丁性质** —— 链式转换丢 `max_tokens` 需显式回填，新增链式路径要逐个补
6. **`x-anthropic-billing-header` 只验证存在不验证取值** —— 作者注释明确承认这不构成防伪边界

## 11. 对 LTZY 的启示

LTZY 的 `gateway.py`（425 行）只做**同构转发**（OpenAI 兼容上游）+ `local/echo`。与 Sub2API 差着一个数量级的工程复杂度。

**必须承认的差距**：
- 无协议转换（只支持 OpenAI 形状的上下游）
- 无原生客户端兼容（Claude Code、Codex CLI 无法直接接入）
- 无账号池（只有静态线路配置）
- 无 TLS 指纹伪装

**可立即借鉴且成本可控的（按性价比排序）**：

1. **错误形状按下游协议对齐** —— 即使不做协议转换，也应让 `/v1/messages` 返回 Anthropic 形状错误。这是接入 Claude Code 的最小前提
2. **`Retry-After`/`x-ratelimit-reset` 退避** —— LTZY 现在固定重试，加上限 8s 的请求域退避成本很低
3. **「已写字节禁止 failover」** —— LTZY 的 `started` 标志已实现这一点（`if not started` 才重试），设计正确 ✓
4. **「部分 usage 也要入账」** —— LTZY 的 `settlement='pending'` 已覆盖此语义 ✓
5. **SSE keepalive** —— LTZY 目前无心跳，长请求可能被中间层掐断
6. **sjson 式的字节级编辑** —— Python 里可用「解析一次 + 只读视图」，避免重复 `json.loads`

**中期可考虑**：
- 协议转换层（先做 OpenAI ↔ Claude 双向，这是最高频需求）
- TLS 指纹不可行（Python 标准库限制），但可用 curl_cffi 等第三方库（会破坏零依赖承诺，需权衡）

**不应照搬**：
- 四层保活、WS 连接池、outbox、leader lock（单机 Python 无此需求）
- `max_tokens=1` 探测拦截（这是为「订阅账号被滥用」设计的，LTZY 按 token 计费无此压力）
