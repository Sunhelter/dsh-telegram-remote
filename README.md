# dsh-telegram-remote

在 Telegram 里遥控电脑上正在跑的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
Web 会话：列会话、附着、切模型、直接对话。

和 `hi-wenw/dsh-telegram-channel` 的区别是只做最小集：不认图片、不接审批，
界面只有 Telegram 和一个设置页，零依赖、无构建步骤。

## 状态

M0 骨架、M1 Telegram 传输、M2 会话列表与绑定已完成并真机验证；
M3 对话、M4 模型切换已真机验证；M5 打磨还没做。

## 用法

在 Web 的「设置 → Telegram 遥控」里填 bot token、允许的用户 ID 和代理，
保存后立即开始轮询。

- `/start` 检查连接
- `/sessions` 选工作区，再选会话；点会话即绑定
- `/model` 切换模型，点一下即生效，和 Web 端同一份选择
- 直接发文本：发到绑定会话，正文按流式消息回传，另有一条状态消息显示用时和当前动作
- `/unbind` 解除绑定
- `/help` 查看命令

工作区与会话每页 10 个，带翻页按钮；绑定按 chat 存本机的 `state.json`，
重启后保留。会话被删掉后列表里不会再出现，旧绑定点开会提示，发文本时也会自动解除。

## 配置

| 键 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `token` | `DSH_TELEGRAM_TOKEN` | 空 | BotFather 给的 token，空则不启动轮询 |
| `allowedUserIds` | `DSH_TELEGRAM_ALLOWED_USER_IDS` | `[]` | 数字 user id 白名单，逗号分隔；空表示不限制 |
| `proxy` | `DSH_TELEGRAM_PROXY` | 空 | HTTP CONNECT 代理，如 `http://127.0.0.1:7890` |
| `pollTimeoutSec` | `DSH_TELEGRAM_POLL_TIMEOUT_SEC` | `30` | getUpdates 长轮询秒数 |
| `maxMessageLength` | `DSH_TELEGRAM_MAX_MESSAGE_LENGTH` | `4096` | 单条回复的长度上限 |

`api.telegram.org` 在国内直连不通，必须配代理。白名单留空时任何找到这个 bot
的人都能操作本机，建议始终填上自己的 id。

## 安装

需要 DSH 的 `web` profile 和 `0.2.1-rc.5` 或兼容版本。

```bash
dsh plugin --profile web add github:Sunhelter/dsh-telegram-remote
```

装完重启一次 Harness。卸载：

```bash
dsh plugin --profile web remove @local/dsh-telegram-remote
```
