# 同进程音乐镜像

source 和 target 是本应用管理的两个 TeamSpeak 客户端。source 保持完整播放器，target 用自己的身份和连接在固定频道输出同一音乐。

## 配置

推荐在 WebUI 的设置 → 机器人管理中选择「镜像机器人」方案，选择原实例和固定目标频道。关系保存在数据库，支持一台原机器人对应多个镜像；操作步骤、状态、权限和限制以 [README](../README.md) 为准。下列文件/环境方式为兼容旧部署或由运维锁定关系的高级配置，指定目标在网页中只读。

先在 WebUI 创建或确认两个机器人并取得 ID。两者应连接同一语音服务器，保存各自独立身份。target 必须配置数字 `channelId`，并开启 `autoStart`，保证应用重启后重新连接。

将 [示例文件](../examples/mirror.json) 复制到持久化目录 `/app/data/mirror.json`：

```json
{
  "sourceBotId": "REPLACE_WITH_SOURCE_BOT_ID",
  "targetBotId": "REPLACE_WITH_TARGET_BOT_ID"
}
```

也可设置环境变量：

```yaml
environment:
  MIRROR_SOURCE_BOT_ID: "REPLACE_WITH_SOURCE_BOT_ID"
  MIRROR_TARGET_BOT_ID: "REPLACE_WITH_TARGET_BOT_ID"
```

两个环境变量必须一起设置，优先于文件；`MIRROR_CONFIG_PATH` 可改写默认文件路径。两个 ID 必须不同且确实存在。配置在进程启动时读取，修改后重启应用。没有配置时保持普通多机器人行为；不完整或无效配置会阻止启动。

## 播放与头像

source 播放器按自己的播放时钟生成 Opus 帧，管理器将同一批帧送到 target 的独立连接。切歌、暂停、恢复、音量和进度跳转由 source 控制。target 拒绝播放器 REST 写入、独立播放、队列载入和聊天点歌；其状态和队列展示跟随 source，昵称、ID、连接仍保持各自配置。

source 最近成功设置的头像字节被缓存并转发给 target，包括歌曲封面、自定义空闲头像和清除头像。target 无需重新下载图片，连接或重连后应用缓存。头像写入串行执行，失效请求会丢弃，target 的传输或头像失败不阻断 source 播放。

两个语音连接共享一个播放器的实时输出。网络、服务器和客户端缓冲仍可能产生延迟差，不承诺两端扬声器达到采样级同步。target 断线期间不缓存或补播音频，重连后跟随当前输出。

## 固定频道与权限

target 只在固定频道发送音频，被移动后尝试返回。还需要 TeamSpeak 服务端权限：

- target 的所需移动权限高于普通成员的有效移动权限。
- 镜像频道的所需讲话权限高于非机器人客户端的有效讲话权限，仅 target 获得足够讲话权限。
- 检查 talker 标志、频道组和客户端覆盖项，避免覆盖使普通成员仍可讲话。
- source 和 target 均需要 `b_virtualserver_client_list=1` 查询听众；优先直接授予并配置 Skip，避免为此授予管理员组。

能修改服务端权限的管理员仍可改变这些保护；应用的回频道行为无法代替服务端权限。

## 听众与自动暂停

source 的无人自动暂停和空闲断线统计合并两间房的听众，排除受管理的机器人，同频道时去重。客户端列表查询失败视为人数未知，不会据此判定房间为空。target 的听众返回只恢复 source 先前自动暂停的播放，保留手动暂停。target 自己不会因房间无人断开连接。

## 部署与验证

使用本项目的完整 Docker 镜像，详见 [部署说明](DEPLOYMENT.md)。镜像已包含后端、WebUI 和运行工具，无需额外挂载 `dist` 或二进制目录。

部署后验证：两间房都有声音；暂停、跳转、切歌时 target 跟随；头像更换和清除正常；target 断线不影响 source；重连后恢复当前音频和头像；普通用户不能移动 target 或在镜像频道讲话。开启无人自动暂停后，测试任一房间有听众、两房间无人、听众返回及手动暂停。
