# New API · 商业化与运营功能

> 快照：`references/neo-api`。这是「对标赶超」最需要吃透的部分。

## 1. 一条主线：单一 quota 贯穿全链路

```
         ┌──── 充值/兑换/签到/返利/调账（+quota）
钱包 quota ┤
         └──── 请求计费（-quota，先预扣后结算差额）

定价侧：倍率表 + 分组倍率 + 计费表达式 → quota = f(tokens, ratios)
资金来源：wallet | subscription（FundingSource 抽象二选一）
```

`FundingSource` 接口（`service/funding_source.go:15-24`）：`PreConsume / Settle / Refund`
`BillingSession` 承载「预扣→结算→退款」生命周期（`service/billing_session.go:30-42`）

## 2. 额度单位体系

| 项 | 值 |
|---|---|
| `QuotaPerUnit` | **500,000**，即 1 USD = 500,000 quota |
| 倍率语义 | `modelRatio=1` ⇒ $0.002/1K tokens ⇒ `quota = tokens × ratio` |
| 单请求上限 | `MaxQuota = MaxInt32`（防批量累加溢出回绕） |
| 钱包上限 | `MaxWalletQuota = 2^53-1`（JS 安全整数，可被 float64 精确表示） |

**三种金额单位必须区分（最易踩坑）**：
1. **quota**：库内余额、日志 `quota`、订阅 `amount_total/used`
2. **美元金额**：`TopUp.Amount`（额度）、`TopUp.Money`（实付）、`Plan.PriceAmount`
3. **展示金额**：`quota_display_type=TOKENS` 时前端传的是 token 数，需先 ÷QuotaPerUnit

## 3. 六类倍率

| 倍率 | 默认/兜底 |
|---|---|
| 模型倍率 | 未配置返回 37.5 且 `ok=false`（自用模式决定是否报错） |
| 模型固定价 | 按次计价（MJ/Suno/DALL·E 3/Sora/Veo） |
| 补全倍率 | 硬编码族规则，部分模型 **locked**（配置无效强制对齐）：gpt-4o=4、gpt-5=8、claude-3/4=5 |
| 缓存读取 | 默认 1.0；gpt-5/Claude 0.1，gpt-4o 0.5，deepseek 0.25 |
| 缓存写入 | 默认 1.25；**派生** 1h=×6/3.75、12h=×2 |
| 分组倍率 | default/vip/svip=1 |
| **用户组×使用组二维** | `{"vip":{"edit_this":0.9}}` 命中则**覆盖**一维并标 `HasSpecialRatio` |

### 组合公式（`service/text_quota.go:303-368`）
```
groupRatio = GroupRatio[usingGroup]，若 GroupGroupRatio[userGroup][usingGroup] 命中则覆盖

ratio = modelRatio × groupRatio
baseTokens = prompt − cr − cc − img − audio
promptQuota = baseTokens + cr×cacheRatio + img×imageRatio + cc×cacheCreationRatio(分 5m/1h/12h)
completionQuota = completion × completionRatio
quota = (promptQuota + completionQuota) × ratio
      × Π(otherRatios)          ← n / seconds / 尺寸分辨率
      + audioInputQuota + toolCallSurcharge

兜底：ratio≠0 且 quota≤0 → quota=1（保证"有调用就有扣费"）
```

**OtherRatios 统一插槽**：`types.PriceData.otherRatios`，`AddOtherRatio` 拒绝 `≤0/NaN/+Inf`。图片数量通过 `n` 注入，任务参数由 adaptor `EstimateBilling` 返回 map 注入。

## 4. 计费表达式引擎（核心差异化）

**一个模型的价格 = 一条表达式字符串**，而非散落倍率表。

| 维度 | 说明 |
|---|---|
| 模式 | `ratio`（旧，界面标"弃用"）/ `tiered_expr`（新） |
| 存储 | `billing_setting.billing_expr`（模型级）/ `plugin_billing_expr`（插件级） |
| 内置价格 | 用真实 USD/1M tokens 写表达式（如长上下文分档、DeepSeek 峰谷时段） |
| 语言 | `expr-lang/expr`，版本前缀 `v1:` |
| 变量 | `p`(输入) `c`(输出) `len`(完整上下文) `cr` `cc` `cc1h` `cc12h` `img` `ai` `ao` `image_count` `u()`(任务用量事实) |
| **自动排除语义** | 「表达式引用了哪个子类变量，就从 p/c 中扣掉该类 token」，避免重复计费；`len` 永不扣除 |
| 内置函数 | `tier()`（记录命中档位，必须包裹成本）、`fixed()`（按次美元价）、`param()`、`header()`、`hour/minute/weekday`、`has()` |
| 保存前校验 | `SmokeTestExpr` 跑 7 组 token 向量 × 2 组上下文，要求结果有限非负；任务表达式还要求 usage key 已声明 |

> **商业意义**：把「时段折扣、长上下文溢价、分档计价、模态差异定价」统一成一句话配置。`expr.md:3` 的原话："One expression, one truth"。

## 5. 预扣 → 结算 → 退款

```
① 定价与预扣（请求发出前）
   PreConsumeBilling → NewBillingSession
     ├─ 信任额度旁路？→ effectiveQuota=0
     ├─ 预扣令牌额度（原子 CAS）
     └─ 预扣资金来源（钱包原子尝试 / 订阅预扣记录）
② 上游调用（可重试/换渠道）
   ReserveBeforeSubmit(更高预估) —— 发送前补足，图片场景强制余额覆盖
③ 结算：delta = actual − preConsumed → 补扣 / 退还 / 不动
   资金先行提交，令牌后调整；资金已提交则标记 fundingSettled 防退款误退
④ 失败退款：异步、幂等、订阅额外预扣单独回滚
```

**必须复刻的语义**：

| 规则 | 说明 |
|---|---|
| 信任额度旁路 | 钱包/令牌余额都 > `trust_quota_usd`(默认 10 USD) → 跳过预扣 |
| 旁路例外 | ① 异步任务必预扣 ② **订阅永不旁路** ③ 图片强制余额覆盖 |
| 免费模型不预扣 | `enable_free_model_pre_consume=false` 且价格为 0 |
| 钱包允许透支 | 结算补扣无条件扣，余额可为负；但「发送前补扣」必须余额够 |
| 计费偏好 | `subscription_first`(默认)/`wallet_first`/`subscription_only`/`wallet_only` |
| 订阅预扣最小 1 | `max(preConsumedQuota, 1)`，为 0 额度请求也建记录以锁定订阅 |
| 低额度提醒 | 余额**跨越**阈值才提醒一次 |

## 6. 计费模式矩阵

| 模式 | 触发 | 口径 |
|---|---|---|
| 按 token | 默认 | 见 §3 公式 |
| 按次固定价 | `ModelPrice` 命中 | `price × QuotaPerUnit × groupRatio × otherRatios` |
| 图片按张 | `n ∈ [1,128]` | 固定价时 `n` 注入倍率；token 计价走 `img` 倍率 |
| 视频按秒/分辨率 | adaptor 返回 `seconds` | OtherRatios 连乘（Sora 尺寸、Veo 4K） |
| 任务用量事实 | `u("image_count")` | 表达式求值 |
| 工具按次附加 | web_search 等 | `$/1K次 ÷1000 × count × groupRatio × QuotaPerUnit` |
| 违规附加费 | Grok CSAM 类 | 固定金额 × groupRatio |
| 实时语音 | Realtime | 文本/音频四象限分别计价 |

## 7. 数值安全

所有 quota 转换集中在 `common/quota_math.go`：
`QuotaFromFloat`（截断）/ `QuotaRound`（away-from-zero）/ `QuotaFromDecimal` / `WalletQuotaFromDecimalStrict`
每类都有 `*Checked`（返回 `*QuotaClamp` 供审计）与 `*Strict`（越界直接报错，**禁止饱和值进入计费**）。

饱和事件写日志 `other.admin_info.quota_saturation`（仅管理员可见）。
用户可控乘数（`n`、`seconds`、`max_tokens`）必须在请求校验层设上限。
预扣与结算都「越界即失败」而非静默回绕。
钱包入账用原子条件 UPDATE 防并发超额。

## 8. 支付渠道矩阵

| 渠道 | 入账换算 | 验签 |
|---|---|---|
| **易支付 epay** | `Amount(美元) × QuotaPerUnit` | MD5 或 RSA 双轨；**RSA 时额外校验 pid** |
| Stripe | `Money(实付) × QuotaPerUnit` | `Stripe-Signature` |
| Creem | **`Amount` 直接当 quota 整数** | Webhook Secret |
| Waffo / Waffo Pancake | `Amount × QuotaPerUnit` | 平台公钥 |
| 余额支付 | 钱包 quota 抵扣计划价 | 内部事务 |
| 兑换码 | 码面额 | CAS 状态翻转 |
| 人工调账 | add/subtract/**override** | 行锁 + 审计 |

### 易支付实现细节（LTZY 相关）
- 签名双轨：MD5（`EpayKey`）与 RSA（商户私钥签名 + 平台公钥验回调）
- 订单号：`USR{userId}NO{6位随机}{unix}`
- **回调防重三层**：① 进程内订单互斥锁 ② **DB 行锁 + 事务内状态校验**（真正的正确性保证，多实例安全）③ 幂等返回
- 回调只认成功态，其他事件只记日志仍回 `success`（防上游无限重试）
- RSA 模式必须 `params["pid"] == PartnerID`
- **回调验签先于结算**

### 订单状态机
```
pending ──(回调/补单)──► success
   ├──(失败)──► failed
   └──(过期)──► expired
```
**支付网关一致性校验**：每类 `Recharge*` 校验 `PaymentProvider != 期望` → 拒绝，防止「用 A 渠道凭证给 B 渠道订单回调」。

### 合规闸门
`compliance_confirmed` + `compliance_terms_version == "v1"` 未确认时：支付方式清空、兑换码不可用、订阅下单被拒。确认动作记录 by/IP/at。

## 9. 兑换码

- `Key char(32) unique`，`common.GetUUID()` 去 `-`，一次最多 100 个
- 状态：1 启用 / 2 禁用 / 3 已使用，过期是派生状态
- **核销**：事务内行锁 → 校验 → **CAS 翻转 1→3**（`RowsAffected==0` 即并发失败）→ 入账
- 并发安全：行锁 + CAS 双保险（SQLite 无行锁也安全）+ `RandomSleep` 抗时序探测
- 批量运维：批量软删 1–1000、「删除无效码」一键清

## 10. 订阅

- 计划字段：`PriceAmount + Currency`、时长、`AllowBalancePay`、`AllowWalletOverflow`、`MaxPurchasePerUser`、`UpgradeGroup/DowngradeGroup`、`TotalAmount`、`QuotaResetPeriod`
- 预扣：`PreConsumeUserSubscription(requestId,...)` → 建记录（requestId 幂等）
- 退款：带 requestId 幂等，可重试 3 次
- 到期：按周期重置已用额度；过期按 `DowngradeGroup`/`PrevUserGroup` 降级用户组
- 购买限制在**事务内锁用户行**后校验（多实例串行）
- 缓存：两级 HybridCache（Redis + 本地 LRU hot）

## 11. 渠道运营（自愈闭环）

```
测活 → 判定（状态码/关键词/时延三因子）→ 自动禁用 + 关 WS + 通知 → 被动恢复探测
```

三种模式：
| 模式 | 测试对象 | 可自动禁用 |
|---|---|---|
| `scheduled_all` | 所有非手动禁用渠道 | 是 |
| `auto_ban_only` | 仅 `auto_ban=1` | 是 |
| **`passive_recovery`** | **仅自动禁用状态的渠道** | **否**（只恢复不禁用） |

判定细节：错误来源为 channel 级（密钥/配置）→ 禁用候选；否则按状态码（默认 401）+ 关键词匹配；**响应耗时超阈值也判失败**。

**渠道余额查询**按类型分派 8 种实现（OpenAI 账单、DeepSeek、Moonshot、Sub2API、NewAPI、AdvancedCustom、TaskPlugin、通用）。多 Key 渠道直接拒绝（无法确定查哪个 key）。

**比率同步**：只输出「差异集」供管理员逐项确认，**不自动覆盖** —— 运营安全的关键设计。支持 New API 原生 / OpenRouter / models.dev 三种上游格式。

**渠道亲和（session affinity）**：按 `model_regex/path_regex/user_agent` 匹配，从 `context_int/header/gjson` 提取 key，TTL 内粘同一渠道。这是多轮对话/长任务稳定性的运营级能力。

## 12. 日志三级可见性

`other` JSON 分 `public / admin / root` 三级：
- **public**：`model_ratio` `group_ratio` `cache_tokens` `frt`(首字延迟) `billing_source` `request_plugins`
- **admin**：`use_channel`(重试链) `billing_model` `is_multi_key` `request_policy` `reject_reason` `quota_saturation`

> 商业站点必须的「运营侧可见、用户侧不见」能力，且从**写入侧**就隔离。

## 13. 统计与看板

- 小时聚合表 `quota_data`（user/model/group/token/channel/node 维度 + cache 命中）
- 内存累积后按 `DataExportInterval`(默认 5min) 落库
- 排行榜 5 分钟缓存
- 日志导出：流式 NDJSON，每人同时仅一个导出

## 14. 用户运营

| 功能 | 规则 |
|---|---|
| 注册赠送 | `QuotaForNewUser`，注册即入账 |
| **邀请返利** | `AffCode`(4位随机)；被邀请人得 `QuotaForInvitee`，邀请人累计到 **`aff_quota/aff_history` 双记** |
| 返利提现 | `TransferAffQuotaToQuota`，最低 1 美元等值，事务+行锁 |
| **签到** | `(user_id, checkin_date)` 唯一索引防重复；随机奖励 `min/max_quota` |
| 封禁/降权 | 禁止对同级或更高角色操作；降权清权限、撤销全部会话、清令牌缓存 |

> 返利进 `aff_quota` 而非 `quota` 是刻意设计：**返利是「待提取余额」，与消费余额隔离**，便于审计与风控。

## 15. 任务系统

- 状态机：`NOT_START → SUBMITTED → QUEUED → IN_PROGRESS → SUCCESS/FAILURE`
- **提交时强制全额预扣**（`ForcePreConsume`，不走信任旁路）；失败全额退款并回减用量
- 轮询适配器接口：`Init / FetchTask / ParseTaskResult / AdjustBillingOnComplete(返回差额)`
- 系统任务用 **DB 租约锁**（ClaimSystemTask + 续租 + 过期回收），跨实例安全

## 16. 「对标赶超」的关键机会点

**成熟、建议直接对齐**：
1. 单一 quota + 集中化饱和转换（长期运营不翻车的地基）
2. BillingSession 生命周期抽象（覆盖同步/异步/图片/重试四类场景）
3. 订单状态机 + 行锁 + 网关一致性校验
4. 表达式定价（可校验、可审计、可迁移，有 convert/preview 无副作用接口）
5. 渠道自愈闭环（被动恢复模式尤其优雅）
6. 日志三级可见性

**差异化空位（机会）**：

| 机会 | 依据 |
|---|---|
| **成本侧利润看板**：只有我方扣费与上游余额，**无「上游真实成本 vs 售价」毛利表** | `model/channel.go:42-46`、`usedata` 无 cost 字段 |
| **充值/消费对账报表**：三张表无统一对账视图或定期结算任务 | `topup`/`subscription_orders`/`log` |
| **价格版本化与生效历史**：只留当前值，**无「价格变更时间线 / 历史计费复现」** | `model/option.go:288-386` |
| **多币种定价**：仅展示层换算，套餐 `Currency` 存在但支付几乎单一通道 | `subscription.go:166` |
| **退款/拒付（chargeback）**：Stripe 无 chargeback 事件与额度追回 | `topup_stripe.go:193-204` |
| **渠道成本自动比价**：选路只看 priority/weight，未按成本排序 | `ability.go:153-163` |

## 17. 对 LTZY 的启示

LTZY 现状：`users.balance_micros` 单一余额、`recharges` 订单表、`receipts` 计费表、易支付 V1/V2。

**已经做对的**：
- 整数 micros 计费（无浮点误差）
- `out_trade_no UNIQUE` 幂等键
- 预扣 `reserved` + 结算 `cost` 分离
- 余额不足 `402`、待核对 `pending`

**应补的（按优先级）**：
1. **支付网关一致性校验**：LTZY 只有易支付，但应校验 `epay_version` 与订单匹配
2. **回调验签先于结算**：需确认 LTZY 的 `handle_pay_notify` 顺序（当前先 `pay.verify` 再查单，顺序正确）
3. **成本侧毛利看板**：LTZY 有 `price` 快照，可算出收入；缺上游成本字段 → 建议给 lane 加 `cost_price`，可做**差异化卖点**
4. **价格版本化**：LTZY 的 `price_version` 已在报价快照里，可扩展为「变更时间线 + 历史复现」
5. **邀请返利双记账**：LTZY 无邀请体系，若要加，用 `aff_quota/aff_history` 双记

**暂不需要**：表达式定价引擎（LTZY 模型少）、订阅套餐、任务系统、排行榜。
