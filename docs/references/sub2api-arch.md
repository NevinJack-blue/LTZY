# Sub2API · 架构与数据模型

> 快照：`references/sub2api`。Go + Gin + Ent ORM + PostgreSQL + Redis，Vue3 前端。

## 0. 工程概览

| 维度 | 事实 |
|---|---|
| 形态 | 单二进制（前端 `embed` 进后端），Go 编译 `CGO_ENABLED=0` |
| 入口 | `cmd/server`，`--setup` / `--version`；首启检测 → 向导或 auto-setup |
| 依赖注入 | Google Wire |
| 数据层 | **Ent ORM（39 实体）+ 原生 SQL 迁移（305 个文件，schema 的真正权威）** |
| 存储 | PostgreSQL（唯一事实源）+ Redis（缓存/分布式锁/广播） |
| 部署 | Docker Compose / 二进制+systemd / Apple container |

## 1. 数据模型：两层结构（最重要的发现）

1. **Ent 管理层**（`ent/schema/*.go`，39 实体）：类型安全 CRUD、软删除拦截器、边关系
2. **纯 SQL 层**：`channels`、`ops_*`、`scheduler_outbox`、`usage_dashboard_*`、`channel_monitor_v2_*`、插件表、MCP OAuth 表**不在 Ent schema**，只由 SQL 迁移创建、由 `repository/*.go` 手写 SQL 访问

> **二次开发时只看 `ent/schema` 会漏 80+ 张表。这是最重要的一条。**

### 通用约定
- `TimeMixin` → `created_at`/`updated_at`；`SoftDeleteMixin` → `deleted_at`（查询自动追加 `IS NULL`，Delete 被 Hook 改写为 UPDATE）
- **唯一约束普遍改为部分索引** `WHERE deleted_at IS NULL`，支持软删后重建
- 金额统一 `decimal(20,8)`（成本列 `decimal(20,10)`），倍率 `decimal(10,4)`
- **删除策略是显式设计决策**：订单/设置/兑换码/套餐/支付通道硬删（审计走独立表），用户/账号/分组/Key 软删

### 核心业务表

| 表 | 关键字段 | 说明 |
|---|---|---|
| `users` | email、balance、**frozen_balance**、**concurrency(默认5)**、totp、rpm_limit、total_recharged | 软删 |
| `accounts` | platform、type、**credentials(jsonb)**、**proxy_id**、**concurrency(3)**、**priority(50)**、**load_factor**、**rate_multiplier**、schedulable、**rate_limited_at/overload_until/temp_unschedulable_until**、session_window_*、expires_at、parent_account_id | **上游账号池核心表** |
| `api_keys` | key(唯一)、group_id、ip 黑白名单、quota、expires_at、**rate_limit_5h/1d/7d + usage_5h/1d/7d** | 多时间窗限额 |
| `groups` | rate_multiplier、**peak_rate_\*(高峰倍率)**、platform、subscription_type、daily/weekly/monthly_limit_usd、图片/视频/搜索/语音定价列、model_pricing(jsonb)、model_routing、model_allowlist、rpm_limit、max_reasoning_effort、profit_control_* | 计费与路由的核心配置载体 |
| `account_groups` | (account_id, group_id) + priority | 账号↔分组 |
| `usage_logs` | request_id、model/requested_model/upstream_model/**mismatch**、**billing_mode(token/per_request/image)**、token 分解（含 5m/1h/30m/12h 缓存写）、**cost 四段 + total/actual**、rate_multiplier、**account_rate_multiplier**、duration_ms、**first_token_ms**、image_*/video_* | **只追加** |
| `user_subscriptions` | daily/weekly/monthly_window_start + usage_usd | 订阅到期/限额 |
| `payment_orders` | out_trade_no、payment_type、order_type(balance/subscription)、provider_*、**退款字段组** | 硬删（审计走 payment_audit_logs） |
| `proxies` | protocol/host/port、expires_at、**fallback_mode(none/proxy/direct)**、backup_proxy_id | 账号出网代理 |
| `idempotency_records` | scope、key_hash、request_fingerprint、response_body、locked_until | 通用幂等 |
| `error_passthrough_rules` | error_codes/keywords/match_mode、platforms、passthrough_code/body、skip_monitoring | 错误透传规则 |
| `tls_fingerprint_profiles` | grease、cipher_suites、curves、signature_algorithms、alpn… | **TLS 指纹伪装**（反检测） |
| `channel_monitors` + history + daily_rollups | provider、check_mode(probe/quota/quota_probe)、interval 15–3600s、AES-GCM api_key | 渠道监控 |
| `auth_identities` + `pending_auth_sessions` | provider_type(7种)、intent(login/bind/adopt_existing) | 身份合并流程 |
| `batch_image_jobs` + items + events | hold/actual_cost、idempotency_key、manifest_hash | 批量生图 |

### 平台枚举（12 平台 + composite）
每平台带 `Gateway`（**anthropic/openai/gemini/antigravity 四种网关族**）与 `CNProvider`、`LiteLLMProvider` 元数据。
账号「模式 × 协议」是 credentials 内两个**正交维度**：`payg/coding/zen/go` × `chat_completions/anthropic/responses/adaptive`。

## 2. 分层架构

```
cmd/server (main + wire)
   ├── internal/setup        首装：NeedsSetup/AutoSetup/CLI/迁移
   ├── internal/server       gin.Engine、路由注册
   │     ├── routes/          auth / user / admin / gateway / payment / mcp / model_plaza
   │     └── middleware/      40+ 中间件
   ├── internal/handler       HTTP 编排 + DTO 映射（225 文件，admin 子包 176）
   ├── internal/service       **业务核心（1633 个 .go，含全部网关协议转换）**
   ├── internal/repository    持久化 + 缓存 + 分布式协调
   ├── internal/domain        纯常量与值对象（无依赖）
   ├── internal/pkg/*         平台 SDK / 指纹 / 工具
   └── internal/web           前端 embed
```

**依赖方向严格单向**：`handler → service → repository`，接口在 service 侧声明，repository 实现。
> 最直白的注释："It is implemented in the repository layer (Redis-backed) so the service layer never depends on Redis directly"

**"platform 层"是误称**：真正的平台适配落在两处 —— `internal/pkg/{anthropic,openai,gemini,xai,tlsfingerprint,anthropicfp}`（协议/指纹/SDK）+ `internal/service/gateway_*.go`、`openai_gateway_*.go`、`gemini_*_compat_service.go`（协议互转与计费口径）。`internal/platform/` 只有 `liveattestation`（活体证明）。

## 3. 配置体系：两级

| 层级 | 载体 | 生效 |
|---|---|---|
| **启动配置** | `config.yaml` + 环境变量（viper） | 重启生效 |
| **运行时业务配置** | `settings` 表键值 + `SettingService` | 大部分即时生效 |
| **系统密钥** | 环境变量优先，否则落 `security_secrets` 表 | 首次 bootstrap |

加载优先级：显式 env > config.yaml > setDefaults。`viper.AutomaticEnv()` **无前缀**：`server.port` → `SERVER_PORT`。

### 关键配置项（工程上最易踩）

| 关注点 | 配置 | 默认 |
|---|---|---|
| API Key 鉴权缓存 | l1_size 65535、l1_ttl 15s、l2_ttl 300s、negative_ttl 30s、jitter 10%、singleflight | 两级缓存 |
| 无效鉴权防护 | threshold 120 / window 60s / block 60s | 按 IPv6 /64 聚合 |
| **Key 创建限制** | max_active_per_user 200、max_per_user_per_hour 60 | **删除不返还配额**（阻断删建循环） |
| PG 连接池 | max_open 256、max_idle 128、lifetime 30m | 超 24h 的 lifetime 会被夹回默认并 warn |
| Redis 池 | pool_size 1024、min_idle 128 | |
| **上游连接池隔离** | `connection_pool_isolation=account_proxy` | proxy / account / account_proxy 三档 |
| **请求体内存预算** | 未设 = 内存 1/4（≥1GiB）；超限 503 + Retry-After | 显式设置后不再自适应 |
| 幂等 | observe_only=true、ttl 86400s | 观察期可先只记录 |

### 热更新路径
```
Admin 更新 settings → SettingRepository（PG）→ SettingService 解析/写缓存 → onUpdate 回调
   ├─ frontendServer.InvalidateCache()
   └─ refreshFrameOrigins()（重算 CSP）
```
> **注意**：settings 的跨实例同步**没有 Redis 广播**，依赖每次读 DB + 各自短 TTL 缓存。只有少数通道有广播。

## 4. 多实例集群（三套协调机制）

### 4.1 Leader 选举：Redis SETNX + DB advisory lock 双后端
- `SETNX key owner ttl`，释放用 **compare-and-delete Lua**（防过期后被新主持有却被老主删掉）
- 降级：Redis 报错 → PG advisory lock；两者都无 → 不加锁直接跑

被门控的 14+ 个后台任务：备份、仪表盘聚合、Ops 聚合、指标采集、告警评估、数据清理、定时报表、订单过期扫描、订阅提醒、计费探测、额度重置、监控 V2 聚合…

### 4.2 缓存失效三条通路
| 通路 | 覆盖 |
|---|---|
| Redis Pub/Sub | API Key 鉴权、订阅计费、渠道、错误透传规则、TLS 指纹模板 |
| **PG Outbox（补偿 Redis 丢消息）** | auth 缓存失效的可靠投递：`FOR UPDATE SKIP LOCKED` 租约 + 两阶段投递 + 重试退避 + 积压 Stats |
| **调度快照 Outbox** | 账号/分组变更 → 各实例调度缓存 |

**调度 outbox 的工程细节值得抄**：
- 事件去重：`dedup_key = sha256(...)`，`ON CONFLICT DO NOTHING`
- 清理：仅删 `created_at < NOW() - INTERVAL '10 seconds'`，**规避 PG 序列在事务内先分配、提交滞后的竞态**
- 清理互斥用 `pg_try_advisory_lock(hashtext('...'))`
- 兜底：滞后/积压触发强制重建 + 每 300s 全量重建

### 4.3 迁移的多实例安全
- advisory lock，500ms 重试 → 多实例同时启动只有一个跑迁移
- `schema_migrations(filename, checksum, applied_at)` + SHA256 校验
- **21 个历史上改过的文件维护兼容 checksum 规则表**（说明迁移纪律曾被破坏）
- 非事务迁移后缀 `_notx.sql`（如并发建索引）
- 启动期对 PG 恢复中/断连做 8 次指数退避重试，仅对 `57P03`/`08*` 重试，配置错误立即失败

### 4.4 容量预算
PG `max_connections` ≥ 实例数 × `MAX_OPEN_CONNS` + 20% 余量；应用侧总连接 50%~80%。

## 5. 可观测性

- 日志：`log/slog`，双输出（stdout + 文件）、lumberjack 滚动、采样降噪
- **无 Prometheus/OTel** —— 指标是**落库型**：采集器写 `ops_system_metrics`，聚合到 hourly/daily
- 访问侧 `Server-Timing`（Redis/SQL 耗时注入响应头）
- `/health` 返回 `{"status":"ok"}`

### TTFT 监控（两种口径）
- `semantic`（首个语义输出事件）/ `visible`（客户端可见输出），由 `openai_ttft_mode` 控制
- **消费端 1**：OpenAI 高级调度把 TTFT 作为评分因子，粘性会话按 TTFT 阈值逃逸（默认 15000ms）
- **消费端 2**：渠道监控 V2 健康分

### 渠道监控 V1 / V2
- **V1（主动探针）**：`check_mode` 三态、interval 15–3600s + jitter；请求可快照化（模板改动不影响已上线监控）
- **V2（被动指标）**：从真实流量聚合 1m 表 → rollup，按 platform/group/model 四种分组；指标含 RPM/TPM、error_rate、cache_rate、TTFT 与 duration 的 p50/p90/p95
- 健康评分：错误率 + TTFT p50 + 缓存率加权（TargetTTFT 3000ms、Critical 10000ms、TTFTWeight 0.20），样本不足判 `unknown`
- **默认 V1**，V2 需显式开启；历史回填走「硬门+软门」，单 tick 最多一个历史块

## 6. 部署

- **Docker 四阶段构建**：Node 前端 → Go 交叉编译 → `postgres:18-alpine` 取 `pg_dump`（与 Compose 同版本保证备份兼容）→ alpine 运行时
- 非 root（uid 1000）、`/app/data` 卷、entrypoint 修卷权限后 `su-exec` 降权
- Compose：三服务 + `AUTO_SETUP=true`、PG 通过 command 传参数、Redis 开 AOF、**PG/Redis 不映射宿主端口**
- PGDATA 陷阱：postgres:18 必须显式 `PGDATA=/var/lib/postgresql/data`
- 二进制 + systemd：`install.sh` → `/opt/sub2api/`，配置 `/etc/sub2api/config.yaml`
- Apple container：`apple-container.sh init|up|status|...`，无 restart policy、无 Compose 编排

## 7. 工程化

| 项 | 内容 |
|---|---|
| goreleaser | v2，`-tags=embed`，linux/windows/darwin × amd64/arm64 |
| 测试 | **build tag 三层**：`unit` / `integration` / `e2e`；miniredis、integration harness |
| CI | 单元+集成+golangci-lint、安全扫描（govulncheck+gosec+pnpm audit） |
| **openspec** | spec-driven 变更提案库：`proposal.md / design.md / tasks.md / verification.md / implementation-evidence.md`，可带 `source-freeze/` 冻结上游基线 |
| 文档 | `docs/`（支付、MCP、批量图片、监控 V2 安全默认值、插件开发、法务）、`DEV_GUIDE.md` |

## 8. 架构评价与风险

1. **schema 双源风险**：Ent 只覆盖 39 张，`channels`/`ops_*`/`channel_monitor_v2_*`/`scheduler_outbox` 等 80+ 张靠 SQL 迁移；改这些表必须同时改迁移与手写 SQL，Ent 生成物无感知
2. **settings 无跨实例广播**：改设置后其他实例可能滞后，与「Redis 广播」类缓存形成两套语义，排障易误判
3. **调度依赖 DB 轮询**：`scheduler_outbox` 每实例 1s 轮询，实例数×QPS 打在主库
4. **单库无读副本**：V2 回填、Ops 聚合、usage 分区清理都在主库
5. **密钥固定化是硬要求**：`JWT_SECRET`、`TOTP_ENCRYPTION_KEY` 留空会每次启动随机生成（前者全员掉登录、后者 TOTP 全失效），代码仅 warn
6. **可观测性缺标准出口**：无 Prometheus/OTel，接外部监控需自建 exporter
7. **历史迁移 checksum 补丁表**（21 条）说明迁移纪律曾被破坏

## 9. 对 LTZY 的启示

LTZY 是**单文件 Python + SQLite**，与 Sub2API 的复杂度不在一个量级。

**直接借鉴（成本低、价值高）**：
1. **`author_line` → 幂等记录表**：Sub2API 的 `idempotency_records` 是通用方案，LTZY 可先只做 `out_trade_no` 幂等（已有）
2. **Key 创建限制**：`max_active_per_user` + `max_per_hour`，且**删除不返还配额**（阻断删建循环）—— 这是防滥用的巧思，LTZY 应加
3. **多时间窗限额**：`rate_limit_5h/1d/7d` 三级窗口，LTZY 目前只有预算总额
4. **部分唯一索引** `WHERE deleted_at IS NULL`：LTZY 若加软删需注意
5. **成本四段拆分**：`usage_logs` 把 cost 拆成四段 + total/actual，便于对账
6. **TTFT 双口径**：semantic vs visible，避免统计口径争议

**暂不需要**：Ent/Wire/集群协调/outbox/多实例（LTZY 单机）、openspec（团队协作成熟后再引入）

**架构建议**：LTZY 若继续演进，第一步是把 `server.py` 的职责按 `handler / service / repository` 切开，即使仍是单文件，也要保证 **service 层不直接依赖 sqlite3 细节**。
