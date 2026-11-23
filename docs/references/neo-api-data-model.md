# New API · 数据模型与计费设计

> 快照：`references/neo-api`（GORM v2）。表清单权威来源：`model/main.go:342-400`。

## 1. 表清单（37 张主库 + 1 张日志库）

| 表 | 核心字段 | 说明 |
|---|---|---|
| `users` | username, password, role, status, **quota**, **used_quota**, group, aff_code, inviter_id, **auth_version**, setting(JSON) | 单表承载身份 + 钱包 + 邀请三域 |
| `channels` | type, key, models(逗号), group(逗号), priority, weight, balance, model_mapping, channel_info(JSON 多key状态) | 上游连接 + 路由属性 + 扩展配置三合一 |
| `abilities` | **PK(group, model, channel_id)**, enabled, priority, weight, tag | **物化路由表，全系统最关键** |
| `tokens` | user_id, key(unique), remain_quota, unlimited_quota, model_limits, allow_ips, group, auto_groups | 令牌子钱包 |
| `logs` | user_id, model_name, quota, tokens, channel_id, token_id, group, request_id, other(分层可见 JSON) | 无软删，分区友好 |
| `redemptions` | key char(32) unique, quota, status, redeemed_time, used_user_id | 兑换码 |
| `top_ups` | trade_no unique, amount, money, payment_method, status | 在线充值 |
| `subscription_plans` / `_orders` / `user_subscriptions` / `_pre_consume_records` | price_amount decimal(10,6), total_amount, quota_reset_period, upgrade_group | 订阅套餐四表 |
| `options` | key(PK), value | **万能配置表**，倍率等全在这里 |
| `models` / `vendors` / `prefill_groups` | 模型元数据 | 部分唯一索引 |
| `task_plugins` / `tasks` / `midjourneys` | 异步任务 | |
| `quota_data` / `perf_metrics` | 小时聚合看板、TTFT 指标 | |
| `checkins` | user_id + checkin_date 唯一 | 签到 |
| `user_sessions` / `auth_flows` / `passkey_credentials` / `two_fas` / `two_fa_backup_codes` / `user_access_tokens` | 认证子表 | |
| `external_identity_claims` / `user_oauth_bindings` / `custom_oauth_providers` | 第三方身份 | 双唯一索引防重放 |
| `casbin_rule` / `authz_roles` | 权限 | |
| `system_tasks` / `system_task_locks` / `system_instances` | 集群协调 | lock 表做 leader 选主 |
| `audit_logs` | event_id, category, action, token_ref, route, status | 审计 |

**重要：没有 `user_groups` 表**。分组是纯字符串（`users.group` / `channels.group` / `tokens.group` / `abilities.group`），元数据（倍率、可用组）全在 `options` 的 JSON 里。设计意图：分组是**路由/计费维度而非独立实体**，新增分组不需要迁移。

**注意坑**：`options` 作为万能配置表，`model_pricing_config.go` 已需维护 11 个键的白名单 + 版本号，继续增长会变成隐式 schema。

## 2. abilities 物化表（最值得学的设计）

**问题**：`channels.models` 是逗号分隔字符串，路由时需「给定 group+model 选渠道」，`LIKE '%model%'` 无法走索引也无法排序。

**解法**：把 `channels(models × group)` 展开成 `(group, model, channel_id)` 三元组独立表，路由一条 SQL 搞定：
```sql
WHERE group=? AND model=? AND enabled=? ORDER BY priority DESC, weight DESC
```

**维护策略**：写扩散 + 全量修复兜底
- 渠道增改时 `UpdateAbilities` **先全删后重建**，分块 50 条 `OnConflict{DoNothing}`
- `FixAbility()` 全量修复，带 `TryLock` 防并发，结尾 `InitChannelCache()` + `BumpSyncTopic()` 广播多节点失效
- 冗余字段（priority/weight/tag）不加触发器，靠应用层保证

**路由算法两个细节**（`model/ability.go:129-167`）：
1. 先按 priority 分组降序，`retry` 次数决定降到第几档 → **同优先级内重试、跨优先级降级重试**
2. 权重用 `weight + 10` 作基础权重 —— 保证 `weight=0` 的渠道仍有非零概率，避免"设 0 即永久冷宫"的反直觉

## 3. 计费体系

### 3.1 额度单位
```go
QuotaPerUnit = 500 * 1000.0     // 1 quota = $0.000002，即 $1 = 500,000 quota
USD2RMB = 7.3                    // 硬编码汇率（历史遗留）
```
`model_ratio` 语义 = **每 1K token 美元价 ÷ 0.002**。`gpt-4o: 1.25` ↔ $2.5/1M。

### 3.2 三层价格数据
| 层 | 载体 | 热更新 |
|---|---|---|
| 内置默认 | Go map 常量 `setting/ratio_setting/` | 随版本 |
| 管理员覆盖 | `options` 一行 JSON（11 个键） | 无需迁移 |
| 表达式计费 | `options.billing_setting.billing_expr` | 支持阶梯定价 |

`ModelPricingVersion`（sha256）做**乐观并发控制**：保存带 `ExpectedVersion`，不一致返回 `ErrModelPricingConflict`。

### 3.3 按量计费公式（`service/text_quota.go:303-368`）
```
ratio = model_ratio × group_ratio

prompt_quota = base_prompt_tokens
             + cache_tokens × cache_ratio
             + cache_creation_tokens × create_cache_ratio   (5m/1h/12h 分档)
             + image_tokens × image_ratio
completion_quota = completion_tokens × completion_ratio

quota = (prompt_quota + completion_quota) × ratio × Π(other_ratios)
      + audio_input_quota + tool_call_surcharge_quota
```

按次计费：`quota = model_price × QuotaPerUnit × group_ratio × Π(other_ratios)`

### 3.4 预扣与结算分离
- 预扣只用 prompt 估算：`preConsumedQuota = prompt_tokens × PreConsumeMultiplier × model_ratio × group_ratio`
- 结算算真实总价，差额补扣或退还
- **零额度兜底**：`if !ratio.IsZero() && quota <= 0 { quota = 1 }` —— 防精度截断导致"无限免费"

### 3.5 计费安全不变量（`common/quota_math.go`）
所有 float→int 只允许走 `QuotaFromFloat` / `QuotaRound` / `QuotaFromDecimal` 及 `*Checked` 变体，**禁止裸 `int(float64(x)*r)`**。单请求饱和上限 int32 边界；钱包用 `MaxWalletQuota = 1<<53-1`（JS 安全整数）。饱和事件写入日志 `admin_info.quota_saturation` 供审计。

## 4. 资金抽象（第二个最值得学的设计）

`service/funding_source.go:15-24` 定义统一接口 `PreConsume / Settle / Refund`：
- `WalletFunding`：Redis Lua 原子预扣，失败回退 DB 条件更新。**Refund 不可重试**（`IncreaseUserQuota` 非幂等）
- `SubscriptionFunding`：幂等性由 `subscription_pre_consume_records.request_id` 唯一索引保证，**Refund 可重试**

计费来源由 `UserSetting.BillingPreference` + plan 的 `AllowWalletOverflow` 决定，支持 `wallet_first` 回退订阅。

> 把「钱从哪扣」抽象成接口，而不是在主流程写 `if 有订阅 {...} else {...}`。新增资金来源只需实现 4 个方法。

## 5. 额度一致性（三处状态）

`TryReserveUserQuota`（`model/quota_reserve.go:164-198`）：
1. **Redis 优先**：Lua 校验 `Id + CacheSchema + 字段存在`，然后 `HINCRBY Quota -amount`。缓存在此期间是余额权威来源（批量模式下 DB 落后）
2. 缓存未命中 → 水合 → 重试
3. Redis 异常 → 降级 DB 条件更新 `UPDATE users SET quota=quota-? WHERE id=? AND quota>=?`
4. 落库失败 → 补偿缓存

授信方向（充值/兑换/返利）必须 `syncCreditUserQuotaCache`，否则新到钱在缓存过期前不可用。

## 6. 缓存设计（把 Redis 当不可信加速层）

| 机制 | 做法 |
|---|---|
| 完整性 MAC | `UserBase.cacheMAC()` 对除 Quota 外字段做 HMAC，读取校验 → 防"往 Redis 塞 Role=root"提权 |
| Schema 版本 | `userCacheSchemaVersion = 2`，结构变更旧缓存自动判废 |
| 双栅栏 | 变更时先立 fence（10s）+ version，栅栏期读请求直接落库，杜绝"删缓存后被旧快照回填" |

渠道与定价**不落 Redis**，用进程内内存缓存 + `BumpSyncTopic()` 广播失效（全量小数据、每请求必读，走 Redis 反而加 RTT）。

## 7. 入金三通道（各自独立幂等键）

| 通道 | 表 | 幂等键 |
|---|---|---|
| 兑换码 | `redemptions` | `key` char(32) unique |
| 在线充值 | `top_ups` | `trade_no` unique |
| 订阅订单 | `subscription_orders` | `trade_no` unique |

> 支付回调天然重复，每条通道必须有外部可校验的业务唯一键，而非"查状态再更新"。

金额全部用 `shopspring/decimal`，落库前 `WalletQuotaFromDecimalStrict` 做 53 位边界检查。

## 8. 订阅套餐的巧思

1. **套餐直接操控分组**：`upgrade_group` / `downgrade_group` 让订阅改变路由与倍率身份，到期回滚到 `PrevUserGroup`
2. **快照而非外键**：`DowngradeGroup`、`AllowWalletOverflow` 从 plan 复制到 `user_subscriptions` —— **已售出权益必须按成交时条款执行**
3. `TotalAmount=0` 表示无限（与令牌的 `unlimited_quota` bool 表达不一致，两处独立演化）

## 9. 迁移策略（三库兼容）

「AutoMigrate 打底 + 定向迁移补救 + 三库矩阵验证」三层。启动顺序**先迁移后 AutoMigrate**（先修结构，再让 GORM 在正确基线上比对）。

| 问题 | 解法 |
|---|---|
| SQLite 无 ALTER COLUMN | 手写 CREATE TABLE + PRAGMA table_info 差量 ADD COLUMN |
| SQLite 无 TRUNCATE | `DELETE FROM` |
| PG 报 `CHAR(n)` 为 bpchar | 自定义 dialector 修正类型名 |
| MySQL decimal 默认补零 | 比较时剥离 default |
| JSON 列写入 | `Valuer` 返回 `string` 而非 `[]byte`（否则 PG 按 bytea 编码触发 22P02） |
| 布尔默认值 | 禁止 `default:true`，改在 hook 设，防三库归一化差异反复 ALTER |

**退役而非删除**模式：旧字段标 `Deprecated` + 明确退役期限（如 legacy access_token 30 天），配 `ErrLegacyAccessTokenRetired`。

## 10. 设计评价

**值得借鉴**：abilities 物化、FundingSource 接口、LogOther 三层可见性（写入侧就隔离字段）、缓存 MAC+版本+双栅栏、计费"绝不返回负费用"收敛到 quota_math、迁移"探测-验证-决策"纪律。

**需要留意**：
1. `users.quota` + Redis 计数器 + 批量更新 = 三处状态，一致性依赖顺序严格，无自动对账任务
2. abilities 冗余字段无触发器保证，直接改 SQL 会让路由陈旧
3. options 万能配置表 → 隐式 schema
4. `channels` 三重配置列（setting/settings/other/other_info）语义重叠，易写错
5. 无物理外键，孤儿数据需定期任务发现
6. 时间戳两套体系（int64 秒 vs time.Time）混用

## 11. 对 LTZY 的启示

LTZY 当前：SQLite 单库、`users.balance_micros` 单一余额、`receipts` 单一计费表、每百万 token 固定单价。

**可直接借鉴**：
1. **计费安全收敛**：把额度运算收敛到单一模块，禁止裸浮点转换（LTZY 已用 micros 整数，这点做对了）
2. **入金幂等键**：LTZY 的 `recharges.out_trade_no UNIQUE` 已正确
3. **FundingSource 抽象**：LTZY 未来接订阅套餐时应先抽象接口
4. **迁移的探测-验证-决策纪律**：LTZY 的 `MIGRATIONS` 元组已是雏形，可加"未知状态报错而非静默"

**暂不需要**：abilities 物化（LTZY 线路少）、Redis 缓存层（单机）、三库兼容（只支持 SQLite）。
