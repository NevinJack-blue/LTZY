# New API · 路由与鉴权体系

> 快照：`references/neo-api`。行号相对仓库根目录。

## 1. 四层正交设计（理解全局的第一把钥匙）

| 维度 | 取值 | 作用 |
|---|---|---|
| `RelayFormat` | openai / claude / gemini / openai_responses / openai_realtime / rerank / embedding / task / mj_proxy 等 14 种 | **下游客户端协议**，决定 handler 与错误序列化形状 |
| `RelayMode` | Chat / Embeddings / Images / Audio / Responses / Realtime / Gemini… | 路径语义，由 `Path2RelayMode` 从 URL 推导 |
| `APIType` | 39 个值 | 选择 adaptor（`GetAdaptor` 大 switch） |
| `ChannelType` | 1–63 | 渠道身份，决定 baseURL、鉴权头、URL 拼接 |

映射：`ChannelType → APIType` 由 `common/api_type.go:5` 完成；**未知渠道类型回落 OpenAI**（"OpenAI 兼容兜底"）。

## 2. 中间件链（两条独立链）

### 控制台链 `/api`
`PanicRecover` → `RequestId` → `Version` → `I18n` → 日志脱敏(`gin.Logger`) → `RouteTag("api")` → `gzip` → `AccessTokenAudit` → `BodyStorageCleanup` → `GlobalAPIRateLimit`
（`router/api-router.go:18-24`）

### 数据面链 `/v1`
引擎级：`CORS` → `DecompressRequestMiddleware`（gzip/br/zstd 透明解压 + MaxBytesReader 32MB）→ `BodyStorageCleanup` → `StatsMiddleware`
组内：`RouteTag("relay")` → `SystemPerformanceCheck`（过载 503）→ `TokenAuth` → `ModelRequestRateLimit` → `Distribute`
（`router/relay-router.go:16-19,71-92`）

> **gin 组快照语义**：`Group` 创建时拷贝当时的 `engine.Handlers`，所以注册顺序决定各组拿到哪些引擎级中间件。`/api` 注册在最前，故不含 CORS/解压/Stats。

## 3. 多凭据共存与判别（最值得抄的部分）

| 凭据 | 载体 | 存储 | 生命周期 |
|---|---|---|---|
| 控制台 Access JWT | `Authorization: Bearer` | 无状态 HS256 | 15 分钟 |
| Refresh Token | Cookie `new_api_refresh`，`Path=/api/user/auth`，HttpOnly，SameSite=Strict | `user_sessions.refresh_hash`（HMAC） | 30 天 |
| Scoped PAT | `nap_` 前缀 | `user_access_tokens.token_hash` (SHA256) | 用户指定，明文只返回一次 |
| Legacy PAT | 无前缀 | `users.access_token` | 过渡期 30 天 |
| API Key（数据面） | `Bearer sk-x` / `x-api-key` / `x-goog-api-key` / `?key=` / WS 子协议 | `tokens.key` + Redis | 由 `expired_time`（-1 永久） |
| Security Proof | `X-Security-Proof` JWT | 无状态 + `auth_flows` 一次性行 | 60 秒 |

### 防降级判别（`service/auth_token.go:107-124`）
`ParseDashboardAccessToken` **故意不验签**，只检查 `iss=="new-api"` / `aud` 含 `dashboard` / `token_use`；三者命中即断言为内部令牌，**绝不回退**到 PAT 或 API Key。效果：伪造的正确 issuer JWT 得到 401，而不是被当 PAT 查库；`nap_` PAT 也不会被 JWT 解析器误认。

## 4. 权限模型（三层叠加）

### 4.1 角色（硬编码整数）
`guest=0 / common=1 / admin=10 / root=100`（`common/constants.go:202`），`IsValidateRole` 只允许这四值，防伪造 `role=1000`。

### 4.2 Casbin RBAC
- 模型极简，**无角色继承**（`service/authz/enforcer.go:19-31`）
- 判定四步（`resolver.go:10-35`）：角色映射（100→root，≥10→admin，**其余返回 nil 不走 Casbin**）→ root 直接 allow → 未注册 permission 一律 deny → 用户级显式策略（**deny 优先**）→ 角色基线 → 默认 deny
- 多节点每 `SyncFrequency` 秒 `ReloadPolicy`；启动时**重建内置角色基线**（代码是唯一事实来源）；旧版 v4/v5 策略**一律加载为 deny** 并告警

### 4.3 PAT Scope：fail-closed 白名单
`middleware/access_token_routes.go:43-315` 是约 230 条「路由→规则」大表，三种规则：
- `scope("x:y")` 必须持有
- `any` 任意有效 scope
- `session` **拒绝所有 PAT**（改安全设置、会话管理、PAT 自身管理、`POST /pg/chat/completions`）

执行点 `enforceAccessTokenRoute`（`auth.go:289-315`）：
```
declared && session → 403 AUTH_SESSION_REQUIRED
legacy              → 放行（过渡期豁免）
!declared           → 记 SysError + 403 ACCESS_TOKEN_ROUTE_UNDECLARED  ← fail-closed
any || scope 命中    → 放行
否则                 → 403 ACCESS_TOKEN_SCOPE_DENIED（写审计）
```
> 新增路由若忘记声明 scope，PAT 被拒并打错误日志，而不是默默放行。**这是整套设计最值得抄的一行。**

## 5. 会话失效：双层版本号

```
users.auth_version            ← 全局凭据代次
user_sessions.version         ← 单会话版本
```
JWT 里带 `uv`（user auth version）与 `sv`（session version），任一不匹配即 `AUTH_SESSION_REVOKED`。
改密/启用 2FA/换 Passkey → `BumpUserAuthVersion` + 推当前会话到新版本 + `RevokeOtherUserSessions`。
Refresh 轮换带 30s 重放窗，**超窗复用即判定会话被撤销**（`model/user_session.go:473-560`）。

上限：活跃会话 50、24h 内签发 100。

## 6. 二次验证（step-up）

统一 scope 策略表 `securityVerificationPolicy`（`service/security_verification.go:313-365`）：有 2FA/Passkey 就必须用，否则降级密码，再否则 OAuth 回跳。

Proof 机制：
- 签发：`auth_flows` 行提供 `jti` + 60s JWT，绑定 `scope + context_hash(HMAC) + 会话版本`
- 消费：`UPDATE ... WHERE consumed_at IS NULL AND expires_at > now` **原子抢占**，`RowsAffected != 1` 即已用
- context 绑定：把「被管理的 userId」等绑进 proof，使针对 A 的 proof 不能重放到 B（`admin.user.*` scope）

## 7. 安全清单

| 项 | 做法 |
|---|---|
| 密钥派生 | `HMAC(SessionSecret, "new-api/auth/"+purpose+"/v1")`，purpose 分 access / security_proof / refresh / verification-context → **按用途隔离签名能力** |
| 防重放 | 一次性 flow（原子 UPDATE）+ TTL + scope/context 绑定；external identity `token_hash` 唯一索引 + OnConflict DoNothing |
| 限流分层 | 全局 IP 360 / 关键操作 20 / **用户级（抗代理池）** / 模型请求 / 邮件验证码 30s2次 |
| 审计 | AccessTokenAudit（含被拒原因）、管理写操作兜底审计（响应 64KB 上限）、Token 操作审计、安全操作审计（只记 ref 不记明文） |
| 日志脱敏 | OAuth 回调剥整段 query；`?key=` 物理摘除后再进日志；API Key 列表 `MaskTokenKey` |
| 会话 Cookie | HttpOnly + SameSite=Strict + Path 限定 + Origin/Referer 双校验（常量时间比较） |

## 8. 风险点

1. `WssAuth` 是**空函数**（`auth.go:422-424`），若误挂 WS 路由即无鉴权放行
2. `/mj/image/:id` 在 `TokenAuth` **之前**注册（`relay-router.go:225`），靠不可猜 ID 保护
3. CORS `AllowAllOrigins + AllowCredentials`，依赖浏览器拒绝 `*`+credentials 兜底
4. Legacy PAT 过渡期内**绕过所有 scope**（`auth.go:297-298`）
5. `TRUSTED_PROXIES` 未配置时默认信任内网网段，`X-Forwarded-For` 可被内网伪造
6. `GET /v1/video/generations/:id`、`POST /v1/videos/:id/remix` 不过 `ModelRequestRateLimit`

## 9. 对 LTZY 的启示

LTZY 当前只有 `admin/user` 两角色 + Cookie 会话，缺口：

- **无 PAT/API Key 分离**：控制台会话与数据面 key 已有区分，但无 scope 化
- **无 step-up 二次验证**：敏感操作（撤销密钥、调余额）目前仅靠会话
- **无版本栅栏**：改密不会踢掉其他设备
- **权限判定硬编码角色**：无 Casbin 式的资源-动作权限
- **无限流分层**：仅登录失败限流

落地优先级（成本/收益比）：
1. **会话版本栅栏 + 改密踢端**（低成本，高安全收益）
2. **敏感操作 step-up**（调余额、撤销密钥、系统设置）
3. **API Key scope 化**（read/chat 已有雏形，可扩展为细粒度）
4. Casbin 式 RBAC（当前两角色够用，暂不急）
