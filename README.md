# dsh-telegram-remote

在 Telegram 里遥控电脑上正在跑的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
Web 会话：列会话、附着、切模型、直接对话。

和 `hi-wenw/dsh-telegram-channel` 的区别是只做最小集：不认图片、不接审批，
纯 host 半、零依赖、无构建步骤。

## 状态

脚手架阶段，代码还没写。设计见 `roadmap.md`（本地文件，不入库）。

## 配置

| 键 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `token` | `DSH_TELEGRAM_TOKEN` | 空 | BotFather 给的 token，空则不启动轮询 |
| `allowedUserIds` | `DSH_TELEGRAM_ALLOWED_USER_IDS` | `[]` | 数字 user id 白名单，逗号分隔 |
| `proxy` | `DSH_TELEGRAM_PROXY` | 空 | HTTP 代理，如 `http://127.0.0.1:7890` |

`api.telegram.org` 在国内直连不通，必须配代理。

## 安装

```bash
dsh plugin --profile web add /path/to/dsh-telegram-remote
systemctl restart dsharness.service
```
