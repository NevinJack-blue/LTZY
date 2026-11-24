# LTZY

LTZY 是一个在本机运行的模型路由与用量账本。官网和工作台由同一个 Python 服务提供；默认仅绑定回环地址，使用 SQLite 持久化。运行时只需要 Python 3.11+，不需要 npm、第三方 Python 包或云服务账户。

## 启动与首次使用

在 Windows 双击 [启动 LTZY](start-ltzy.cmd)，或在仓库目录执行：

```shell
python server.py --port 8765
```

打开 <http://127.0.0.1:8765/>，点击「工作台」。首次启动会生成随机管理员密码，保存在本机的 `.ltzy/admin-password.txt`。不要将密码、数据库或运行目录分享给他人。Ctrl+C 停止；重新执行相同命令会使用原数据。其他端口和数据目录通过 `--port`、`--data-dir` 指定。

1. 在「模型广场」查看当前实例真实接入的模型：输入与输出单价均为 0 的模型归入免费分组，其余按量计费；页面不展示虚构限流或延迟。
2. 在「API 密钥」签发可调用的项目 Key，立即保存明文；只读 Key 只能列模型。
3. 打开「接入文档」，将项目 Key 放入示例指定的环境变量，再运行当前模型对应的示例。管理员密码不能作为模型 API Key。
4. 在「请求日志」打开小票，核对路由、用量和价格快照。在「余额与充值」查看用量、充值或导出 CSV。出现未确认用量时，管理员在「线路与对账」按上游凭证核对，不把未知成本记为零。

默认只有 `local/echo`，一条不联网、不调用大模型的确定性测试线路。它走实际鉴权和记账流程，并使用**测试费率**；账本金额不是实际扣款。官网首页的可播放路线始终是教学示例，不向工作台写入虚构的请求。

## 配置自有上游

配置说明、计费边界和数据恢复见[运行手册](docs/gateway-operations.md)。管理面支持多用户注册、角色与余额管理，以及可选 SMTP 和彩虹易支付；网关与账本按用户隔离密钥、日志和用量。默认仍只绑定回环地址，面向本机使用，不应直接暴露为公网服务。

## 验证

```shell
python -m unittest discover -s tests -v
```

管理和推理回归使用临时数据库。网关测试包含本机 HTTPS 上游夹具，不调用付费模型；[运行手册](docs/gateway-operations.md)记录了外部配置后的首调核验方法。

浏览器断言自起隔离实例与数据目录，不依赖正在运行的服务，也不会写入本机账本：

```shell
python scripts/checks/public_checks.py   # 官网 30 项断言
python scripts/checks/desk_checks.py    # 工作台 42 项断言
```

报告与截图写入 `.ltzy/checks/`（已被忽略，不入库）。设计规范与动效实测口径见 [docs/design-v4.md](docs/design-v4.md)。

## 目录结构

```
server.py            HTTP 服务与 /api/* 管理面
gateway.py           /v1/* 模型网关、路由、计量与账务
web/                 官网与工作台前端（原生 JS/CSS，无构建步骤）
tests/               后端单元与集成测试
scripts/checks/      浏览器验收脚本（Playwright + Edge）
docs/                产品设计、技术选型、视觉规范、运行手册
legacy/              v0 时期的历史原型，仅供参考
start-ltzy.cmd       Windows 双击启动入口
```


## 协作流程（必读）

仓库维护者（持有者）可直接推送到 `main`；贡献者请走 Pull Request：

1. Fork 或从最新 `main` 拉出功能分支：
   ```bash
   git checkout main
   git pull origin main
   git checkout -b feat/你的功能名
   ```
2. 开发、提交（**严禁提交任何密钥 / 令牌 / 密码 / 个人隐私文件**，见 `.gitignore`）：
   ```bash
   git add <文件>
   git commit -m "feat: 描述"
   ```
3. 推送功能分支并发起 PR：
   ```bash
   git push -u origin feat/你的功能名
   ```
   然后到 GitHub 页面创建 Pull Request → 由维护者审核合并进 `main`。

## 隐私红线

- 个人令牌、密码、私钥、`.env`、含个人信息的文件一律不入库。
- 提交前自查：`git diff --cached` 确认没有敏感内容。
- 若发现敏感信息已被提交，立即联系维护者吊销相关凭据并清理历史。
