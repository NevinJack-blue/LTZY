# Sub2API · 账号池与智能调度

> 快照：`references/sub2api/backend`。这是它最核心的差异化技术。

## 0. 先纠正一个认知

`internal/platform/` **不是**上游适配层，那里只有 `liveattestation`（macOS 证明链）。
平台适配实际分三层：
- 平台登记表：`internal/domain/platforms.go`（单一数据源）
- 网关服务：`internal/service/gateway_*`、`openai_gateway_*`、`gemini_*`、`antigravity_*`
- 协议原语：`internal/pkg/{claude,openai,xai,gemini,antigravity,tlsfingerprint,...}`

`platforms.go` 的设计意图值得学：平台清单是唯一来源，新增平台登记一条即可在「分组平台、用户额度、组合路由、调度快照、定价匹配」全部生效；但**依赖具体实现的能力（OAuth、余额探测、用量窗口）刻意不在此声明** —— 避免「平台表」变成上帝对象。

## 1. 账号类型体系

### 四个网关族 → 13 个平台
| 网关族 | 承载平台 |
|---|---|
| Anthropic 协议 | anthropic、typesafe |
| OpenAI 协议 | openai、grok、**kimi、zhipu、deepseek、minimax**、opencode_go、command_code、cline |
| Gemini | gemini |
| Antigravity | antigravity |

关键：`kimi/zhipu/deepseek/minimax` 标 `CNProvider: true`，**且不归一为 openai** —— 从而实现「kimi 分组只命中 kimi 账号」的精确平台匹配。

### 六种账号类型
`oauth` / `setup-token` / `apikey` / `upstream`（Base URL 透传）/ `bedrock`（SigV4）/ `service_account`（Google SA）

`IsOAuth()` 把 `oauth` 与 `setup-token` 归为一类 —— 因为两者 access_token 都是 8h 短期令牌需要刷新。**注释记录了「setup-token 之前被排除导致过期后 401」这个 bug 修复**。

### 分组是调度的一等公民
账号不直接面向用户，所有调度先落到 group。分组携带大量调度约束：
`requiredOAuthOnly`（只有非 apikey 可入组）、`requirePrivacySet`、`modelRouting`（**模型模式 → 优先账号 ID 列表**，即强制钉账号）、`rpmLimit`（分组级接管用户级）、`profitControl`（按上游倍率过滤候选池）

## 2. OAuth 令牌生命周期

### 三条刷新路径共享一个核心 API
请求内按需刷新 / 后台主动刷新 / 管理端手动 —— 共用 `OAuthRefreshAPI`。

### `RefreshIfNeeded` 六步协议
```
0. 进程内互斥锁（cacheKey → contextMutex）
1. Redis 分布式锁（TTL 60s，Redis 故障降级无锁）
2. DB 重读 account（锁保护下拿最新 refresh_token）
3. 二次检查 NeedsRefresh（另一路径可能已刷完）
4. 执行平台特定 Refresh()
5. 条件更新 DB（CAS）+ 清 token 缓存
6. 释放锁（detached context，不受请求取消影响）
```
`cacheKey` 是**账号级**而非 token 级，保证同账号并发刷新全局串行。

### `invalid_grant` 竞争恢复（最精巧的一段）
刷新返回 `invalid_grant` 时**先不判账号失效**，而是重读 DB 比较 `refresh_token`：
```go
if usedRT != currentRT {
    return reReadAccount, true  // 另一 worker 已换新 token，本次是良性竞争
}
```
只有 `refresh_token` 未变（真被上游作废）才抛错。**避免多实例并发下的「账号被误杀」**。

### OpenAI/Grok 的不可逆轮换：CAS 持久化
上游已消费旧 refresh_token，持久化失败不能简单重试（会拿旧 token 再刷 → 真死）。三层处理：
- 最多 3 次 CAS 重试；CAS 因「其他字段被管理员改过」miss 时，**只重放本次刷新的凭据字段**到最新快照，不覆盖代理等设置
- 失败即返回 `providerCycleContainmentRefreshError`，**阻断该供应商本轮所有刷新**，而非逐个账号标记失效
- 锁租约预算扣除：`budget = lockTTL - persist - reposync - cleanup - release - margin`

### PG 三值逻辑陷阱（必须记住）
候选分页 SQL 用 `(...) IS NOT TRUE` 而非 `NOT (...)`，否则 `temp_unschedulable_until = NULL` 的健康账号会被**全部排除**。注释明确记录了这个踩坑，表现为「后台任务偶发漏掉全部账号」，极难定位。

## 3. 调度器：两条并存路径

| | OpenAI 高级调度器 | 网关负载感知调度器 |
|---|---|---|
| 服务对象 | openai/grok/CN 供应商 | anthropic/gemini/antigravity |
| 选法 | **连续评分 + TopK 堆 + 加权无放回抽样** | **字典序分层过滤 + LRU + 组内随机** |
| 适用理由 | OpenAI 家族账号差异大（plan/倍率/额度窗口） | Claude 订阅账号同质，priority 语义强 |

### 四层决策链
```
Layer A  previous_response_id 精确回访
Layer B  guardian parent（守护进程归属）
Layer C  session_hash 粘性会话
Layer D  负载均衡（评分 + TopK + 抽样）
```

### 评分公式（8+2 项加权）
```
priorityFactor / loadFactor / queueFactor / errorFactor / ttftFactor
resetFactor（use-it-or-lose-it）/ quotaHeadroom / upstreamCost
+ previous_response 加分 + session_sticky 加分
```
**权重默认全 0** —— 全 0 时评分退化为纯行为比较器（priority → loadRate → waitingCount → ID）。这是很克制的设计：默认行为确定可预测，想要「智能」再逐项开权重。

TTFT 与错误率来自 `sync.Map` + CAS 的 **EWMA，alpha=0.2**，TTFT 初值用 NaN 哨兵表示「无样本」。

### TopK + 加权无放回抽样（三个细节）
1. 最小堆维护 TopK，**堆根是「最差」候选**（反直觉但正确）
2. 抽样前把分值**平移到正区间** `weight = (score - minScore) + 1` —— 避免单一最高分账号长期垄断
3. 随机数种子由 `SessionHash + PrevResponseID + Model + GroupID` 做 FNV-1a；**无会话锚点的纯 LB 请求混入时间熵**，否则固定命中同一账号

> 设计意图：TopK 内候选统计上接近，确定性排序会让并发请求全砸向同一「最优」；加权抽样保持偏好的同时天然分散压力。

### 探针预算（有界努力）
抢槽上限 64 次、DB 复核上限 64 次。超支后走 4 轮分桶重试，按「是否已尝试过 × 是否已知满」分桶，避免重复踩同一满账号。

### 可诊断性内建（最值得抄）
`isAccountRequestCompatibleReason` 返回**具体否决理由**而非 bool：
`account_nil / model_not_owned / privacy_not_set / runtime_blocked / proxy_stream_quarantined / quota_auto_pause_5h / shadow_parent_unhealthy / model_not_supported / capability_mismatch / profit_control_*`

累积成可诊断错误串：
```
no available OpenAI accounts supporting model: gpt-5.4-mini
(pool=3, filtered: excluded=1 model_not_supported=1 quota_auto_pause_7d=1)
```
> 注释说明这是 issue #4599 的修复：历史上这些排除是静默的，「没有可用账号」完全无法排障。

### 快照过期再校验
Layer 2 过滤时**故意重新检查 schedulability**：
> Scheduler snapshots can be temporarily stale (bucket rebuild is throttled); re-check schedulability here so recently rate-limited/overloaded accounts are not selected again before the bucket is rebuilt.

即：**快照负责性能，DB 状态负责正确性**，两者在决策点汇合。

## 4. 粘性会话

### Key 结构与分组隔离
```
sticky_session:{groupID}:{sessionHash}  → accountID
```
**分组隔离是关键**：同一用户在不同分组可绑不同账号。TTL 1h。

### sessionHash 生成优先级
```
1-5. Header: session-id / conversation_id / x-session-affinity / x-conversation-id / x-grok-conv-id
6.   Body: prompt_cache_key
7.   Body: content fallback（model + system + tools + 首条 user message）
```
Grok 额外做模型作用域隔离：`grok-affinity:v1:{model}:{sessionID}` —— **换模型不应继承旧的账号绑定**。

### Sticky Escape（主动失效）
```go
if ttft > threshold        → "ttft"
if errorRate > threshold   → "error_rate"
if 锁竞争 + 槽位满          → "concurrency_full"
```
触发后**保留绑定但不使用**，转走负载均衡 —— 用户下轮请求仍可能回到原账号，避免一次抖动就永久换号。

### 会话数量上限（Anthropic 专有）
`checkAndRegisterSession`：**账号级「同时在线的不同会话数」限制**，与并发槽位是不同维度：
- 并发限制「同时多少请求」
- 会话数限制「同时多少个不同对话」

### 新旧 hash 双写兼容
xxhash 新 key + sha256 legacy 双写双读，legacy key 限流 10 分钟 TTL，带独立计数器观测回退命中率。这是典型的**零停机哈希迁移**手法。

## 5. 并发控制

### 三维度 + 两类租约
| 维度 | Key | 上限来源 |
|---|---|---|
| 账号 | `concurrency:account:{id}` | `concurrency`(默认3) 或 `load_factor` |
| 用户 | `concurrency:user:{id}` | `user.concurrency` |
| API Key（仅统计） | `concurrency:api_key:{id}` | 无上限 |
| Live 租约 | `concurrency:live:*` | 语音/实时会话 60s |
| WS ingress 租约 | `concurrency:openai_ws_ingress:api_key:{id}` | 60s + 20s 续约 |

**全局并发没有单独实体**，通过「所有账号容量之和」隐式体现。

### ZSET + Lua（原实现的重大问题与修复）
> 原实现用 SCAN 遍历独立槽位键，高并发下多次往返且性能下降明显。改用有序集合：每账号一个键，成员为 requestID，分数为时间戳；**ZCARD 原子取并发数 O(1)**；ZREMRANGEBYSCORE 清理过期槽位；单次调用完成计数。

核心 acquire 脚本的四个工程要点：
1. `redis.replicate_commands()` —— 兼容 Redis 3.2-4.x，否则 `TIME` 在脚本里无法正确复制
2. **用 Redis 时间而非应用时间** —— 多实例时钟漂移会让槽位提前/延后过期
3. **返回 `{result, now}`** —— Go 侧复用同一时间源写活跃索引，省一次 TIME 往返
4. **live 与 regular 分开计数但合并判定** —— 实时会话与普通请求共享账号预算，但分开过期（60s vs 15min）

### 释放一律脱敏上下文
```go
context.WithoutCancel + 独立 5s 超时
```
这是全库反复出现的模式：**释放槽位/续约/清缓存一律脱离请求上下文**，否则客户端断开就会泄漏槽位直到 TTL。

### 泄漏防护四件套
1. 槽位 TTL（15min）—— 进程崩溃后自然过期
2. 活跃索引（替代全量 SCAN）
3. 启动清理：按**进程请求 ID 前缀**删除非本进程遗留成员
4. 后台清理 worker：周期按活跃索引批量 reconcile

### WS 租约 fail-closed
`refreshOpenAIWSIngressLeaseScript` **不重建丢失的成员**：丢失即租约失效，必须终止本地 WebSocket。
对瞬时 Redis 错误容忍一个完整 TTL，超过即 `ErrLeaseLost` 并 cancel 上下文。
> 这是「分布式配额必须 fail-closed」的正确做法 —— 本地不能因为读不到 Redis 就无限放行。

## 6. 故障转移与健康监测

### 失败作用域模型（防止雪崩的关键）
```go
GatewayFailureScopeAccount  = "account"   // 换账号能解决
GatewayFailureScopeProvider = "provider"  // 整个供应商挂了
GatewayFailureScopeRequest  = "request"   // 请求本身的问题
```

```go
func ShouldReportAccountScheduleFailure() bool {
    return !e.IsCredentialFailure() || e.Scope == GatewayFailureScopeAccount
}
```
**provider 级和 request 级的凭据失败不会被误记到被选中的账号身上** —— 这一行避免了「上游整体故障导致全部账号被逐个标记失效」的雪崩。

### 错误分类处置矩阵（关键行）
| 码 | 条件 | 处置 |
|---|---|---|
| 400 | `credit balance` | 永久 disable（语义等同 402） |
| 401 | OAuth **且有** refresh_token | 失效缓存 + temp-unschedulable 10min，**保持 active** |
| 401 | OAuth **但无** refresh_token | 永久 disable（**抢在冷却前**，避免冷却后必然 502） |
| 402 | CN 供应商 | 可恢复临时停调（充值后自动解除） |
| 402 | 其他 | 永久 disable |
| 429 | — | `shouldDisable=false`，写限流窗口 |
| 529 | — | 过载冷却，不 disable |
| 5xx | 未启用自定义错误码 | 仅记日志，**不动账号** |

**401 的关键注释**（记录了一个严重历史 bug）：
> 原实现使用请求开始时的 account 快照整列覆盖 credentials JSONB，在另一个 worker 刚刷新完 refresh_token 的窄窗口内会把新 refresh_token 回滚为旧值，导致下一周期用旧 refresh_token 拿到 `invalid_grant` 后，竞争恢复也救不回来，账号被错误 disable。

现在只做 `InvalidateToken + SetTempUnschedulable`，**凭据写入完全交给带锁的正路**。

### 冷却体系：五类时间字段
`rate_limited_at`+`reset_at`（429）/ `overload_until`（529）/ `temp_unschedulable_until`+`_reason`（任意原因）/ `session_window_*`（Claude 5h）/ `schedulable`（管理员硬开关）

`IsSchedulable` 是**唯一真值**，DB 查询在 SQL 层复刻同一套逻辑。

### 429 解析的三个层次
1. **OpenAI**：`x-codex-*-used-percent` 头，**只有 ≥100% 才算耗尽**（未达 100% 的 reset-after 只是窗口信息）
2. **Anthropic**：per-window 头（5h/7d/7d_oi），`selectAnthropicExhaustedWindow` 选实际触发的窗口
3. **兜底**：可配置秒级冷却
   > 注释说明理由：不标记会导致每个请求反复撞同一批 429 账号，白白烧掉 failover 预算，客户端稳定收 429

**OpenAI OAuth 的刻意豁免**：`ShouldRetryOpenAIOAuth429` 为真时**不落限流**，因为落库会让下一次重试直接不合格，把「同账号恢复」变成「账号切换」。

### CAS 写回的四种条件写
| 方法 | 条件 | 用途 |
|---|---|---|
| `SetRateLimitedIfLater` | `reset_at IS NULL OR reset_at < new` | 只延长不缩短（并发响应乱序） |
| `ClearRateLimitIfObserved` | 观测值匹配 | 一次性成功不擦掉更新的 429 |
| `SetRateLimitedIfUnchanged` | `updated_at` 匹配 | 异步探测不覆盖新状态 |

> `account_repo.go:2392` 的注释直说：「Grok 请求可能并发完成，较早的响应不能覆盖较晚的重置边界」。这不是学术洁癖。

### API Key 账号的独立熔断器
只对 `platform=openai && type=apikey && poolMode` 生效：
- 滑动窗口失败计数达阈值 → temp-unschedulable
- **只统计 429 与 5xx**，排除 `IsCredentialFailure / RequestScopedTransient / Scope∈{request,provider}`
- **成功不重置窗口**（注释：成功不重置滑动窗口，且不在热路径加一次 Redis 往返）

> 分级熔断：OAuth 账号靠上游窗口头精确冷却，API Key 账号没有窗口信息只能靠错误率熔断。

## 7. 配额追踪

### 5h/7d 窗口的三路数据来源
被动采样（响应头，每个响应）/ 主动探测（`/wham/usage`）/ 上游错误头（429）

被动采样把 5 个字段合并为**一次** `UpdateExtra` 写入 —— 热路径不允许五次 DB 写。

### 原始字段与规范字段共存
OpenAI Codex 原始头是 `primary/secondary`，但 primary 到底是 5h 还是 7d 取决于 `x-codex-*-window-minutes`：
1. 原始字段全量落库便于排障
2. `Normalize()` 归一化后写 `codex_5h_*` / `codex_7d_*`
3. 读取时**规范字段优先**，回退时用 `Normalize` 的窗口分类，**不能固定把 primary 当 7d**

### 耗尽判定与自动暂停（最复杂的一段）
**消费阈值高于暂停阈值**：
```go
if utilization >= config.Threshold5h:   // 达消费阈值
    notifyAutoReset(account.ID); return true

if pauseReached:
    if 有可用重置卡 && !stale:
        return false    // 有卡可用，继续放行（让流量撑到消费阈值）
    notifyAutoReset(...); return true
```
> 设计意图：**有卡可用时宁可继续跑，把额度用满再一次性重置** —— 这是「拼车」场景下额度利用率最大化。

**禁用标记必须存在的原因**：账号阈值留空意味着「用全局默认」，一旦有了全局默认，管理员就**没有任何办法**单独豁免一个账号。

### 评分中的额度因子（双窗口联动）
```go
factor = 1 - 7d.usedPercent/100
if 5h.remaining < 0.10: factor *= 0.5     // 5h 快见底，压低分数
```
「7d 还很宽但 5h 快爆」的账号被自动降权，而非硬暂停。

### 原生限额重置兑换
**OpenAI reset credit**：
- 用 `privacyClientFactory` 构造**模拟 TLS 指纹**的客户端（Cloudflare-friendly）
- `redeem_request_id` 幂等键
- **Spark 影子不能兑换**（不持凭据）
- 兑换快照**必须带过期时间** —— `N>0` 但无 expires_at 的快照无法被 reader 老化，会一直显示并可兑换已过期的卡

**自动重置服务**：`selectAutoResetCandidate` 用 `openAIAutoResetCycleSeed(usage)` 哈希做**同周期稳定性**选择，避免每次评估选到不同的卡。

**Claude 原生重置**三层幂等/栅栏：
1. `IdempotencyCoordinator` + `LeaderLockCache`（缺任一即拒绝运行）
2. 账号租约 + 组织租约（TTL 90s）
3. **durable organization fence**（一个组织一行，多账号共用，账号编辑无法抹掉）

栅栏 TTL 三档：未知结果 24h / 明确 unavailable 仅 15min / 正常 365 天。

## 8. 贯穿全库的六个模式

1. **可取消的分布式锁 + 失败开放/关闭分级**
   Redis 挂掉时：并发槽位仍按进程内逻辑继续（可用性优先），但 WS 租约 **fail-closed**（配额正确性优先）

2. **脱敏上下文做释放/续约**
   `context.WithoutCancel` + 独立超时出现在所有释放路径。客户端断开不应导致资源泄漏。

3. **CAS 而非覆盖写**
   限流状态、OAuth 凭据、快照写入全部带前置条件。

4. **可诊断性内建**
   `openAISelectionFilterStats`、`selectionFailureDiagnosis`、`OpenAIScheduleDecision` 全字段回传。出问题时错误串本身就能定位。

5. **惰性回收优先于主动扫描**
   ZSET 的 `ZREMRANGEBYSCORE`（每次 acquire 顺手清）、活跃索引替代 SCAN、启动清理按进程前缀。**没有一处依赖「定时全表扫」**。

6. **迁移友好**
   新 hash + legacy 双写双读、`_token_version` 版本戳、原始字段与规范字段并存。每次语义升级都留了回退通道。

## 9. 「拼车」的核心矛盾与四个解法

> 本质矛盾：**上游按账号计费/限流，下游按用户计费/限流**。

| 矛盾 | 解法 |
|---|---|
| 一个账号被多人用会撞并发 | 账号级 ZSET 槽位 + 用户级槽位分离 |
| 多轮对话换账号丢上下文 | 粘性会话（分组隔离 + 1h TTL + escape） |
| 额度窗口耗尽不应让整组停摆 | 账号级窗口冷却 + 模型级冷却 + 阈值暂停分级 |
| 额度浪费在「马上重置」的账号上 | **use-it-or-lose-it**（`PreferSoonestReset` / `resetFactor`） |

**use-it-or-lose-it 最值得注意**：订阅额度是**周期性清零**的，不用就浪费。所以调度器倾向优先用尽「重置时间最近」的账号，把「重置时间还很久」的账号留作缓冲。**这是订阅制（而非按量付费）特有的调度逻辑。**

## 10. 复杂度代价（客观评价）

- `openai_account_scheduler.go` 3207 行、`gateway_scheduling.go` 2684 行、`ratelimit_service.go` 3103 行、`account_repo.go` 4248 行。调度相关约 **1.5 万行**，测试另计
- 平台特化分支密集：`HandleUpstreamError` 里 CommandCode/Cline/Bedrock/CN/OpenCode/Ollama 各有专用处理
- **存在明显的历史层积痕迹**：`stickySessionTTL` 与 `openaiStickySessionTTL` 两个同名常量、legacy/new 双 hash、`codex_primary` 与 `codex_5h` 双字段、`fallback_group_id` 与 `model_routing` 两套钉账号机制

> 这些不是设计缺陷，而是「多平台 × 多账号类型 × 订阅制 × 拼车」组合的固有复杂度在该实现里的投影。代码通过**统一决策结构 + 命名化否决理由 + 详尽注释**管理复杂度，而不是通过抽象层掩盖它 —— 这是可接受且相对诚实的工程选择。

## 11. 对 LTZY 的启示

LTZY 现状：静态线路配置（`LTZY_UPSTREAMS` 环境变量）、无账号池、无 OAuth、无并发槽位、无粘性会话。

**不在一个层级，但有三个概念可立即用**：

1. **失败作用域模型**（`account/provider/request`）—— 即使只有静态线路，也应区分「这条线路的问题」vs「这个上游供应商的问题」vs「请求本身的问题」。LTZY 现在 429/502/503/504 一律重试，会误伤。**这是最高性价比的一条**
2. **可诊断性内建** —— 「没有可用线路」时返回具体理由（`model_not_supported` / `context_limit` / `last_lane_disabled`），而不是笼统 503
3. **`IS NOT TRUE` 而非 `NOT (...)`** —— LTZY 用 SQLite，NULL 语义同样存在（虽然 SQLite 的 NULL 处理与 PG 略有差异）

**中期若做「多上游账号」**：
- 静态配置 → 数据库 `channels` 表
- 加 `priority`/`weight`/`healthy` 字段，用简化的评分（不需要 8 项加权）
- 加粘性会话（Redis 或 SQLite 表，1h TTL）

**不应照搬**：
- 四层保活、ZSET 并发槽位、outbox、leader lock（单机无此需求）
- 1.5 万行调度器（LTZY 的账号规模不需要）
- use-it-or-lose-it（LTZY 按量计费，无窗口清零概念）
