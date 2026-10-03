# teamspeak-music-mirror

完整的 TeamSpeak 音乐机器人 fork：在同一进程运行主机器人（source）和固定频道镜像机器人（target），将同一音乐送到两个频道。包含 WebUI、音乐源、队列、用户权限和播放控制，可作为原音乐机器人应用的整体替代。

source 的播放器直接转发已编码的 Opus 帧和成功上传的头像字节，无需第二次解码、编码或下载封面。它需要本项目管理的两个机器人，无法接入任意外部机器人的音频。

## 功能

- source 负责播放、暂停、切歌、进度、队列和音量；target 展示同一队列和进度，拒绝独立播放控制和播放器写入。
- target 使用独立 TeamSpeak 身份，固定在指定频道，被移动时停止发送音频并尝试返回。
- 镜像歌曲封面、自定义空闲头像及头像清除；target 重连后重新应用 source 最近成功设置的头像。
- 无人自动暂停和空闲断线合并两个频道的听众；手动暂停不会因听众返回而恢复。
- 保留上游的 WebUI 鉴权、音乐源、播放历史、保存队列等功能。未配置镜像时保持普通多机器人模式。

## Docker 快速开始

完整镜像支持 `linux/amd64`、`linux/arm64`，包含 Node.js 22、FFmpeg、Opus 原生模块和固定版本 `yt-dlp 2026.08.19`。GitHub Actions 在主分支更新和版本 tag 推送时自动构建到 GHCR。

下载本项目，在根目录执行以下命令本地构建并启动：

```bash
docker compose up -d --build
```

使用已发布镜像时，把 `<owner>` 替换为实际 GitHub 所有者的小写名称：

```bash
export TSMUSICBOT_IMAGE=ghcr.io/<owner>/teamspeak-music-mirror:main
docker compose pull
docker compose up -d --no-build
```

打开 `http://localhost:3000`，首次运行创建管理员，在 WebUI 建立两个机器人，连接同一 TeamSpeak 服务器并使用各自的独立身份。取得它们的 ID，为 target 设置数字 `channelId` 并开启 `autoStart`。

将 [examples/mirror.json](examples/mirror.json) 复制为持久化目录下的 `mirror.json`，填入实际 ID，重启应用；也可同时设置 `MIRROR_SOURCE_BOT_ID` 和 `MIRROR_TARGET_BOT_ID`，优先于文件。`MIRROR_CONFIG_PATH` 可改写默认路径 `/app/data/mirror.json`。配置在启动时读取，无效配置会阻止启动。首次未配置镜像时，可先进入 WebUI 创建机器人。

最后配置 TeamSpeak 权限，允许 target 在固定频道讲话、查询听众，并阻止普通用户移动它或在镜像频道讲话，详见 [镜像配置](docs/MIRROR.md)。正式部署建议固定镜像版本或 digest。

## 部署和维护

- [Docker、GHCR、TrueNAS 与旧应用迁移](docs/DEPLOYMENT.md)
- [镜像配置、固定频道权限与限制](docs/MIRROR.md)
- [上游功能与使用说明（历史参考）](docs/UPSTREAM.md)
- [API 说明](docs/API.md)

应用数据必须持久化到 `/app/data`，本地媒体可按需只读挂载到 `/mnt/media`。上传文件仍存放在 data 卷中的 `local-audio`。源码开发使用 Node.js 22，分别安装根目录和 `web/` 的依赖后运行 `npm run build`、`npm test`。修改后端和 WebUI 后重新构建完整镜像部署。

## 上游与许可证

基于 [ZHANGTIANYAO1/teamspeak-music-bot](https://github.com/ZHANGTIANYAO1/teamspeak-music-bot) 的 `v1.15.2`，基线 commit `28c128d0c954c4bd6fb3a5f33f00b33282033462`。感谢上游作者及贡献者。

保留 [MIT 许可证](LICENSE) 和上游 `Copyright (c) 2026 TSMusicBot Contributors` 归属。上游 README 原文保存在 [docs/UPSTREAM.md](docs/UPSTREAM.md)，旧镜像和部署命令仅供参考。
