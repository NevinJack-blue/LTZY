# 贡献指南

## 分支保护规则

- `main` 为受保护分支：禁止直接推送、禁止强制推送、禁止删除。
- 合并方式：仅允许通过 Pull Request，且至少需要 **1 个 approving review**。
- 新的提交推送到 PR 后，旧的审核批准会自动失效（需重新审核）。
- 管理员同样遵守以上规则（enforce_admins）。

## 提交规范

- 分支命名：`feat/xxx`、`fix/xxx`、`docs/xxx`。
- Commit message 建议格式：`feat: ...` / `fix: ...` / `docs: ...`。

## 隐私要求

本仓库为公开开源仓库，**任何隐私信息绝对不能提交**：

- GitHub 令牌（ghp_ 开头等）、API Key、密码、私钥证书；
- `.env` 及各类本地配置；
- 真实姓名、手机号、身份证号、住址等个人数据。

`.gitignore` 已预置常见敏感文件规则，提交前请务必 `git diff --cached` 自查。
