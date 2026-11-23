# New API · 转发核心与多协议适配

> 快照：`references/neo-api`。这是该项目最核心的技术资产。

## 1. 四维正交 + 三层解耦

核心不是 40 个 adaptor，而是：`RelayFormat`（客户端协议）/ `APIType`（adaptor 选择）/ `ChannelType`（渠道身份）+ **relaykit 的注册表化转换矩阵**。

`service/`：
- `channels/` 60+ 个上游适配目录
- `relay/common/` RelayInfo、协议视图、每 attempt 重置
- `relay/helper/` SSE 扫描、定价、模型映射、推理尾缀

## 2. 支持的 API 协议清单（下游）

| 协议 | 路由 | 实现 |
|---|---|---|
| OpenAI Chat Completions | `POST /v1/chat/completions`、`/pg/chat/completions` | `relay/compatible_handler.go:26` `TextHelper` |
| OpenAI legacy Completions | `POST /v1/completions` | 同上 |
| Moderations | `POST /v1/moderations` | adaptor 透传 |
| **Responses API** | `POST /v1/responses` | `relay/responses_handler.go:18` |
| Responses Compact | `POST /v1/responses/compact` | 只转发白名单字段 |
| **Responses over WS** | `GET /v1/responses`（WS） | `relay/responses_websocket.go`（1065 行） |
| Alpha Search | `POST /v1/alpha/search` | Codex 独立 web search |
| DeepSeek Tools | `POST /v1/tools/{search,fetch}` | |
| **Claude Messages** | `POST /v1/messages` | `relay/claude_handler.go:23` |
| Gemini generateContent | `POST /v1beta/models/*path` | `relay/gemini_handler.go:23` |
| Gemini Embeddings | `:embedContent` / `:batchEmbedContents` | `gemini_handler.go:169` |
| Embeddings | `POST /v1/embeddings` | `relay/embedding_handler.go:20` |
| Rerank | `POST /v1/rerank` | `relay/rerank_handler.go:21` |
| Audio TTS/STT | `/v1/audio/{speech,transcriptions,translations}` | `relay/audio_handler.go:18` |
| Image（DALL·E/gpt-image） | `/v1/images/{generations,edits}` | `relay/image_handler.go:32` |
| Image（Flux/Replicate/即梦/MiniMax） | 同上 | 各自 ConvertImageRequest |
| **Midjourney** | `/mj/submit/*`、`/mj/task/:id/fetch` | `controller.RelayMidjourney:366` |
| **Video（任务型）** | `/v1/video/generations` | `controller.RelayTask:539` |
| Video（OpenAI Video host protocol） | `/v1/videos`、`/:id/content` | JS 插件接管 |
| **Realtime（WS）** | `GET /v1/realtime` | `relay/websocket.go:18` |
| Batch API | **无**（未实现） | — |

## 3. 上游适配器（38 个 case）

`GetAdaptor` 编译期硬编码 switch（`relay/relay_adaptor.go:51-131`）：

OpenAI(1) · Azure(3) · Anthropic(14) · Gemini(24) · Vertex(41) · AWS Bedrock(33) · 阿里(17) · 百度(15) · 千帆v2(46) · 智谱(16) · 智谱4V(26) · 讯飞(18) · DeepSeek(43) · Moonshot(25) · Ollama(4) · xAI(48) · Cohere(34) · Mistral(42) · 腾讯混元(23) · 火山(45) · SiliconFlow(40) · OpenRouter(20) · Cloudflare(39) · Dify(37) · Jina(38) · Perplexity(27) · PaLM(11) · Coze(49) · MiniMax(35) · 即梦(51) · Replicate(56) · **Codex(57)** · Submodel(53) · **Sub2API(59)** · NewAPI(60) · MokaAI(44) · Xinference(47) · AI360/Lingyiwanwu · **Advanced Custom(58/62/63)** · **Provider Plugin(61)**

适配器接口 `channel.Adaptor`（`relay/channel/adapter.go:18-35`）12 个方法，含 6 个 `Convert*`。

**能力接口 + 类型断言**（避免巨型接口）：
`ResponsesRequestFinalizer` / `RequestSigner`（AWS SigV4、插件 HMAC）/ `WebSocketPreparer` / `outboundImageCounter` / `TaskAdaptor` / `TaskArtifactProvider`

## 4. 转发数据流（8 阶段）

```
① 路由 + 中间件
② Distribute（鉴权后选渠道/钉选/校验）
③ controller.Relay 请求级准备（插件 ingress、解析、RelayInfo、预扣费）
④ 重试循环（每 attempt：选渠道→InitChannelMeta→插件包装→分派 handler）
⑤ Handler：provider 转换 → 插件 outbound → ParamOverride → 序列化
⑥ Adaptor.DoRequest → DoApiRequest：URL→Header→Override→Sign→发送
⑦ Adaptor.DoResponse：错误归类 或 流式/非流式转换写回
⑧ 计费结算 + 日志 + 插件 report
```

### 关键细节

**③ 顺序严格**（`controller/relay.go:73-201`）：
- Realtime 必须**先 upgrade 再走后续**（否则错误无法用 HTTP 状态码表达）
- `Report` defer **最先注册→最后执行**（插件需等客户端拿到完整响应）
- 请求插件 Ingress 在 body 解析**之前**改写原始字节
- Claude 流式心跳在「转换与选渠道」期间就启动，避免客户端超时

**④ 重试循环**（`:203-263`）：
```
reset per-attempt state → getChannel → AppendUsedChannel
→ 重放 body（BodyStorage） → 插件 Reply 包装
→ 分派 handler → 成功/失败决策
→ DecideRelayRetry → processChannelError（可能自动禁用）
```

**⑤ 插件三段式顺序（重要）**：`Outbound`（插件改 JSON/Header）→ `ParamOverride`（管理员规则）→ `Egress`（只读审计）

**`RemoveDisabledFields`**（`relay/common/relay_info.go:1212-1271`）：默认剥离 `service_tier`（避免额外计费）、`inference_geo`、`speed`、`safety_identifier`，`store` 保留。用 `ojson` 只删目标成员、**保留其余字节与键序**。

**⑥ 安全敏感点**：`ApplyHeaderOverride` 若插件改过的 header 含渠道 API Key 则**拒绝覆盖**。

## 5. 渠道选择（三级）

| 层 | 函数 | 职责 |
|---|---|---|
| L1 | `SelectChannelForRequest` | 钉选 → 会话亲和（仅首次 attempt）→ 随机合格渠道 |
| L2 | `CacheGetRandomSatisfiedChannel` | `auto` 分组跨组游标推进 |
| L3 | `model.GetRandomSatisfiedChannel` | 优先级分层 + 加权随机 |

**优先级+权重算法**：
1. 模型名两段式匹配（精确 → `RoutingMatchModelName` 归一化）
2. priority 降序排序
3. **retry 序号 = 优先级层级索引**（retry=0 打最高优先级）
4. 层内加权随机：`sumWeight==0` → 等效 100；平均权重 <10 → 平滑系数 100（放大差）

**auto 跨组重试**：`ContextKeyAutoGroupIndex` 记游标，当前组优先级耗尽 → 游标+1、retry 归零。

**会话亲和**：仅 retry==0 尝试；响应 <400 才写入；`SessionMode=="strict"` 时亲和失效直接 503（**不切换渠道**保一致性）。

**重试决策唯一裁决点** `DecideRelayRetry`（`service/relay_error.go:20-57`）返回 `{Action, Reason, Source}` 并写日志：

| 顺序 | 条件 | 决策 |
|---|---|---|
| 1 | `err==nil` | stop / request_completed |
| 2 | 严格会话亲和失败 | stop / strict_session |
| 3 | 渠道约束抑制重试 | stop / pinned_channel |
| 4 | **`IsChannelError`（code 前缀 `channel:`）** | **retry** / channel_error |
| 5 | `IsSkipRetryError` | stop / non_retryable |
| 6 | 预算耗尽 | stop / attempt_budget_exhausted |
| 7-11 | 状态码判定 | 见代码 |

**自动禁用** `ShouldDisableChannel`：
1. 全局开关关 → 不禁用
2. `RelayErrorSource`：`"channel"`（密钥/配置错误）→ **禁用**；`"local"`（网关自己抛的）→ **不禁用**（本地错误可能没到上游，且消息可能夹带客户端输入导致误命中关键词）
3. `IsSkipRetryError` → 不禁用
4. 状态码策略 → 禁用
5. 兜底：**Aho-Corasick 多关键词匹配**（比逐个 `strings.Contains` 快）

禁用后：关该渠道活跃 WebSocket → i18n 通知关注者 → master 调度器同步。异步 `gopool.Go` 执行，不阻塞请求。

**多 Key**：禁用精确到具体 key（`ChannelError.UsingKey`）；任务路径 `GetNextEnabledKey()` 轮换。

## 6. 协议转换：relaykit（最值得学的部分）

### 分层
```
relaykit/dto/               四种协议 DTO + Usage + ChannelSettings
relaykit/relayconvert/      ★ 转换入口（registry + 选路）
  ├─ convmeta/              上下文 Meta、Options、ClaudeConvertInfo、ResponsesToolState
  ├─ reasoning/             推理意图解析（尾缀、budget、effort）
  ├─ toolconv/             工具跨协议编解码 + 损耗诊断
  └─ internal/
      ├─ oai_chat/          Chat ↔ Claude / Gemini / Responses
      ├─ oai_responses/     Responses ↔ Claude / Gemini / Chat
      ├─ claude_messages/   Claude ↔ Chat / Responses
      ├─ gemini_chat/       Gemini ↔ Chat / Responses
      └─ shared/
```

### 注册表机制
- `RequestConverterSpec{ID, From, To, Quality, Convert 或 StepConverters}`
- 注册校验 **panic 级**：ID 唯一、首尾必须与 From/To 闭合、`Convert` 与 `StepConverters` 互斥
- 自动选路：由 DTO 具体类型推断源协议，查 `from→to` 路由表
- 响应侧多三个流式钩子：`ConvertStream` / `NewStreamState` / `ConvertStreamChunk` / `FinalizeStream`
- `registerBuiltinTextConverter` **一条 spec 同时注册请求侧与响应侧**，保证两端成对

### 转换矩阵（12 条路由）
| From → To | Quality | 方式 |
|---|---|---|
| Claude → Chat / Chat → Claude | fair | 直转 |
| Gemini → Chat / Chat → Gemini | fair | 直转 |
| **Chat → Responses / Responses → Chat** | **good** | 直转 |
| Claude → Gemini / Gemini → Claude | **discouraged** | **两跳** |
| Claude → Responses（响应两跳）/ Gemini → Responses（两跳） | fair | |
| Responses → Claude / Responses → Gemini | fair | |

`good`=结构近一一对应；`fair`=主干可转、独有字段转诊断；`discouraged`=两跳、丢字段概率高。

### 三段式（把 N×N 降到 O(N)）
```
1. toolconv.ExtractRequest(from, request)      // 工具定义提取成中间表示
2. for each step: spec.Convert(ctx, info, current)  // 主体字段转换
3. tools.Model = 上游模型名
4. toolconv.AttachRequest(target, current, tools, options)  // 按目标协议重新编码 + 诊断
5. info.AppendRequestConversion(step.To)        // 转换链（日志/最终格式判定）
```
> 12 条路由里 6 条是两跳复用，工具/推理/多模态都有统一中间表示。

### 流式两范式
- **无状态逐事件**：`ConvertStream` 单函数
- **有状态机**（主流）：`NewStreamState` + `ConvertStreamChunk` + `FinalizeStream`，跨事件累积工具参数分片、usage 汇总、终止事件、索引推进

`ResponseStreamState` 还承担：usage 跨事件累积、诊断累计、`FailResponsesStream` 在流中断时生成协议原生错误事件。

### 损耗策略
`convmeta.Options.ToolLossPolicy`：`allow`（默认，全转+诊断）/ `safe`（请求阶段 error 级诊断即失败）/ `strict`（任何诊断即失败）。

诊断含 `Code/Path/Severity/From/To`，落日志 `admin_info` 便于排障。

### 黄金快照测试
`relaykit/relayconvert/testdata/golden/` **28 份 json**，覆盖请求/响应/流 × 全部路由组合。**这是转换矩阵能长期维护的前提。**

## 7. 流式与 WebSocket

**SSE 写预算**（`relay/helper/stream_scanner.go:84-118`）：按「客户端最低读取速率 8KB/s + 30s 超时」计算每次写的 deadline，跨次累计 —— 既不掐断读得慢但正常的客户端（多 MB 图片事件），又能在客户端彻底不读时结束。

**SSE 读取器**：缓冲初始 64KB、上限 128MB（单个超大事件不炸 scanner）；上游静默时发 `: PING` 心跳；客户端断开取消上游；流结束原因写入 `StreamStatus`。

**两条 WS 实现**：
| 场景 | 要点 |
|---|---|
| Realtime API | OpenAI 把 key 塞进 `Sec-WebSocket-Protocol`；双向 pump 用 `sync.Mutex` 保证单写者；`wsmanager.Register` 使渠道禁用时能主动关闭会话 |
| **Responses over WS** | 一条连接承载多次 `response.create`；每次 create 进独立工作者（串行）；读循环只投递有界消息、**绝不自己改计费状态** |

**重试隔离关键细节**（`relay/common/relay_info.go:286-292`）：
```go
// Per-attempt only. Do not clear StreamStatus, conversion diagnostics,
// LastError, or billing accumulators — those are request-scoped.
info.SendResponseCount = 0
info.ClaudeToChatStreamState = nil
info.ChatToGeminiStreamState = nil
```
每次 attempt 的 `InitChannelMeta` 必须置空流状态，否则**重试会复用上一渠道脏的转换器状态**。

## 8. 插件机制（三粒度）

| 类型 | 载体 | 能力 |
|---|---|---|
| **任务插件** | `plugin.js`（`export const meta`） | 定义上游提交/查询/产物/计费因子；可声明 host 协议 |
| **请求插件** | `plugin.js` + 实例配置 | 四阶段改写：`ingress`(body 解析前) / `request`(推理) / `outbound`(发送前) / `egress`(只读审计) |
| **Provider 插件** | `plugin.js` hooks | **运行期新增上游协议**：凭证交换、签名、**最多 32 跳请求链**、事件流 |
| **Advanced Custom** | 渠道设置 JSON | 纯配置式，零代码 |

**Host Protocol**（`pkg/jsplugin/routing.go:88-105`）—— 插件接管网关原生端点：
| 协议 | 路径 |
|---|---|
| `openai_responses` | `POST /v1/responses`、`GET /v1/responses/:id` |
| `openai_video` | `POST/GET /v1/videos`、`/:id/content` |
| `openai_image` | `/v1/images/{generations,edits}` |

路由**动态注册**；末端 `RelayTaskPluginEndpoint`：有插件端点→插件桥，否则→**回落原生 relay**。这就是「同一 URL，插件可接管、宿主可兜底」。

**请求插件执行计划在请求开始时快照**，设置变更只影响新请求。

## 9. 错误处理

**统一载体** `types.NewAPIError`：`Err` / `RelayError` / `skipRetry` / `recordErrorLog` / `errorType` / `errorCode` / `StatusCode` / `Metadata`

**渠道错误可识别**：`IsChannelError` = `strings.HasPrefix(code, "channel:")` → 直接驱动「重试 + 自动禁用」

**双层渲染**：`ToOpenAIError` / `ToClaudeError` 按**下游客户端协议**重排错误形状，同时保留上游 code/type

**跨协议容错解析** `GeneralErrorResponse`（`relaykit/dto/error.go:23-39`）同时容纳 8 种错误体形状，`ToMessage()` 按优先级取值：
```
error(object) → error(string) → message → msg → err → error_msg → detail → header.message → response.error.message
```
> 这是「能接 40+ 家方言」的关键：**不要求上游遵循统一错误格式**。

**状态码重映射**：渠道设置 `status_code_mapping` JSON（`{"429":"503"}`）对非 200 做改写。

**流式场景**：头已提交时把错误塞进同一个 SSE 流（Claude 用 `event: error`，OpenAI 用 `data: {"error":...}` + `[DONE]`），并记 `StreamStatus.MarkFailed` —— 避免客户端「只看到断流」。

## 10. 设计模式与风险

**亮点**：
1. **注册表 + 路由表**：新增协议只增不改，转换矩阵可组合（两跳）
2. **中间表示三段式**：N×N → O(N)
3. **能力接口 + 类型断言**：避免巨型接口
4. **声明式契约**：非 Go 开发者可接入上游
5. **双实现兜底**：插件缺席时网关仍可用
6. **作用域分层**：request-scope vs attempt-scope 切分清晰
7. **可重放体**：`BodyStorage` + `ReplayableBody` 支撑重试/多协议转换/HTTP2 透明重试共用一份 body
8. **诊断而非报错**：转换损耗可见、可按渠道策略升级为失败

**风险**：
1. `GetAdaptor` / `APIType` / `ChannelType2APIType` **三处人工同步**，新增渠道易漏
2. `openai/adaptor.go` 780 行承担多种协议形态（Azure/OpenRouter/Custom/Realtime/Images/Audio 混杂）
3. `relay/common/override.go` **2096 行**，是隐性的第二转换层
4. `task/jsplugin/adaptor.go` 2226 行单文件
5. 插件链路长：6 阶段 + 32 跳 + host 协议桥，排障需看三套审计

## 11. 对 LTZY 的启示

LTZY 当前转发：`gateway.py` 425 行，只支持 **OpenAI 兼容同构转发**（`LTZY_UPSTREAMS` 配置 HTTPS 渠道）+ `local/echo` 测试线路。有重试（429/502/503/504）、流式 SSE 转发、待核对结算。

**必须补的（按优先级）**：
1. **协议转换层**：至少支持 OpenAI ↔ Claude ↔ Gemini。可借鉴「工具提取→主体转换→工具回填」三段式，避免写 6 个两两转换器
2. **转换损耗诊断**：记录丢了哪些字段，而不是静默丢弃
3. **错误体容错解析**：LTZY 目前只解析 OpenAI 形状，需支持多形状
4. **渠道健康与自动禁用**：LTZY 有「最后一条线路保护」，但无按错误类型的自动禁用

**可以简化的**：
- 不需要 38 个 adaptor（先做 3-5 家主流）
- 不需要插件体系（Python 可动态加载，但会增加不可控面）
- 不需要 Advanced Custom 路由表（配置驱动可后期加）

**架构建议**：
把 gateway.py 拆成 `protocol/`（转换）+ `channel/`（上游适配）+ `billing/`（计费），即使保持单文件也要保证这三块边界清晰。
