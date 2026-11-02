# dsh-telegram-remote

在 Telegram 里遥控电脑上正在跑的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
Web 会话：列会话、附着、切模型、直接对话。

## 用法

在 Web 的「设置 → Telegram 遥控」里填 bot token、允许的用户 ID 和代理，
保存后启用。

- `/start` 检查连接
- `/sessions` 选工作区，再选会话；点会话即绑定
- `/new` 选工作区，在那个目录新建会话并直接绑定
- `/model` 切换模型，点一下即生效，和 Web 端同一份选择
- 直接发文本：发到绑定会话，正文按流式消息回传，长了自动接在下一条，另有一条状态消息显示用时和当前动作
- 定时任务到期：正文推到白名单用户的 chat（已绑该会话的走绑定），不抢当前绑定；跑完给一个「切到这个会话」按钮
- 模型提问时：网页没开着，问题就留在 Telegram——已绑定该会话的 chat 直接出选项卡片，
  其他 chat 收到一条等待回答的提醒，答完模型接着跑；网页开着时由网页作答，Telegram 不插手
- `/unbind` 解除绑定
- `/help` 查看命令

工作区与会话每页 10 个，带翻页按钮；绑定按 chat 存本机的 `state.json`，
重启后保留。会话被删掉后列表里不会再出现，旧绑定点开会提示，发文本时也会自动解除。

## 配置

| 键 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `token` | `DSH_TELEGRAM_TOKEN` | 空 | BotFather 给的 token，空则不启用 |
| `allowedUserIds` | `DSH_TELEGRAM_ALLOWED_USER_IDS` | `[]` | 数字 user id 白名单，逗号分隔；必填，留空不启用 |
| `proxy` | `DSH_TELEGRAM_PROXY` | 空 | HTTP CONNECT 代理，如 `http://127.0.0.1:7890` |
| `pollTimeoutSec` | `DSH_TELEGRAM_POLL_TIMEOUT_SEC` | `30` | getUpdates 长轮询秒数 |

bot token 和允许的用户 ID 都有值才会启用。

## 安装

需要 DSH 的 `web` profile 和 `0.2.1-rc.5` 或兼容版本。

```bash
dsh plugin --profile web add github:Sunhelter/dsh-telegram-remote
```

装完重启一次 Harness。卸载：

```bash
dsh plugin --profile web remove @local/dsh-telegram-remote
```
