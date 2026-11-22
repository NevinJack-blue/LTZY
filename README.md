# LTZY

开源协作仓库。

## 协作流程（必读）

`main` 分支已开启保护：**禁止直接 push，所有改动必须走 Pull Request + 审核合并**。

1. 从最新 `main` 拉出功能分支：
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
   然后到 GitHub 页面创建 Pull Request → 等待维护者审核 → 审核通过后由维护者合并进 `main`。

## 隐私红线

- 个人令牌、密码、私钥、`.env`、含个人信息的文件一律不入库。
- 提交前自查：`git diff --cached` 确认没有敏感内容。
- 若发现敏感信息已被提交，立即联系维护者吊销相关凭据并清理历史。
