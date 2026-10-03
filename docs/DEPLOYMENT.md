# Docker、GHCR 与 TrueNAS 部署

部署单位是完整音乐机器人应用。镜像包含后端、WebUI、Node.js 22、FFmpeg、Opus 原生模块和 `yt-dlp 2026.08.19`，支持 `linux/amd64`、`linux/arm64`。不需要给官方旧镜像挂载补丁 `dist`，也不需要从宿主机挂载 FFmpeg 或 yt-dlp。

## GHCR 自动构建

GitHub Actions 工作流位于 [docker-publish.yml](../.github/workflows/docker-publish.yml)。默认主分支更新和版本 tag 推送触发构建，也可手动触发。镜像发布到 `ghcr.io/<owner>/teamspeak-music-mirror`，所有者使用小写名称。主分支镜像使用 `:main`，发布 tag 按工作流生成版本标签；正式部署建议固定版本或 digest。

在 GitHub 仓库中启用 Actions，并允许工作流发布 Packages。工作流使用仓库的 `GITHUB_TOKEN`，不需要将个人令牌提交到仓库。首次发布后检查 GHCR 包的可见性；公开仓库不代表包必然已经公开。公开部署建议把包设置为 Public，使 Docker 和 TrueNAS 可匿名拉取。

本地构建：

```bash
docker build -f scripts/docker/Dockerfile -t teamspeak-music-mirror:local .
```

## Docker Compose

根目录 [compose.yaml](../compose.yaml) 默认本地构建。`DATA_PATH` 指定可写数据目录，`MEDIA_PATH` 指定只读媒体目录，`WEB_PORT` 指定宿主机 WebUI 端口，`WEB_BIND_ADDRESS` 指定绑定地址。

```bash
export DATA_PATH=/path/to/teamspeak-music-mirror/data
export MEDIA_PATH=/path/to/media
export TSMUSICBOT_IMAGE=ghcr.io/<owner>/teamspeak-music-mirror:main
docker compose pull
docker compose up -d --no-build
```

占位路径和镜像 owner 需替换。修改 Compose 环境变量后执行 `docker compose up -d --no-build`；仅修改 `mirror.json` 时可重启容器使配置生效。

`/app/data` 保存数据库、配置、TeamSpeak 身份、平台 Cookie、头像、日志及上传文件，应完整持久化并备份。`/mnt/media` 是可选只读挂载点；将媒体挂载到此处不会自动导入音乐库，只有实际使用该路径的功能才能读取它。WebUI 上传文件写入 `/app/data/local-audio`。

网络代理按需设置 `HTTP_PROXY`、`HTTPS_PROXY` 和 `NO_PROXY`，根 Compose 会同时传入小写变量，供 FFmpeg 使用。TeamSpeak 语音连接仍需直接访问服务器，HTTP 代理不能代替语音网络连通性。代理认证信息只保存在部署端的受保护配置中。

## TrueNAS SCALE 25.04 新应用

使用 Apps 的自定义应用安装入口，以 Compose YAML 创建新应用 `teamspeak-music-mirror`。准备新的应用数据 dataset，确保容器运行用户可写；媒体 dataset 只需读取权限。不要通过放宽所有文件权限来替代正确的 dataset 权限配置。

以下 YAML 使用通用占位值，不包含任何实际部署身份或地址：

```yaml
services:
  teamspeak-music-mirror:
    image: ghcr.io/<owner>/teamspeak-music-mirror:<version>
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      NODE_ENV: production
      # 首次新安装可先省略下面两个变量，在 WebUI 建立两个机器人后再添加。
      # MIRROR_SOURCE_BOT_ID: "REPLACE_WITH_SOURCE_BOT_ID"
      # MIRROR_TARGET_BOT_ID: "REPLACE_WITH_TARGET_BOT_ID"
      # HTTP_PROXY: "http://proxy.example:8080"
      # HTTPS_PROXY: "http://proxy.example:8080"
      # http_proxy: "http://proxy.example:8080"
      # https_proxy: "http://proxy.example:8080"
      # NO_PROXY: "localhost,127.0.0.1,::1"
      # no_proxy: "localhost,127.0.0.1,::1"
    volumes:
      - /mnt/<pool>/apps/teamspeak-music-mirror/data:/app/data:rw
      - /mnt/<pool>/media:/mnt/media:ro
    stop_grace_period: 30s
```

替换所有占位值，端口按实际情况调整，随后安装。若不需要媒体挂载，删除对应行。服务器地址、密码和机器人身份在 WebUI 或 data 卷内配置，不提交到公开仓库。

首次安装：访问 WebUI 创建管理员和两个机器人，取得 ID。target 设置数字 `channelId` 和 `autoStart`，按 [镜像说明](MIRROR.md) 配置文件或成对环境变量及 TeamSpeak 权限，再重启应用。

## 从旧 music-bot 整体迁移

迁移需暂停旧应用，避免 SQLite 数据、同一 TeamSpeak 身份和音乐会话被两个实例同时使用。

1. 记录旧应用镜像版本、data 挂载位置、端口、代理及媒体挂载，准备受保护的完整数据备份。新应用的数据目录与旧应用分开。
2. **先正常停止旧应用并确认容器已退出，再复制 data。** SQLite 可能使用 WAL，运行中仅复制 `.db` 不能保证一致性。停止后复制整个数据目录，包含可能仍存在的 `-wal`、`-shm` 文件，保留文件属性。不要手工删除这些文件。
3. 将副本挂载到新应用 `/app/data`。保留原数据库、`config.json`、Cookie、头像和身份；这样管理员、权限、机器人 ID、历史和保存队列可以随数据迁移。启用了自动恢复的播放队列会按应用规则恢复，通常从当前歌曲开头开始。
4. 确认副本权限允许新容器写入。在复制的 `mirror.json` 或新应用环境中设置现有 source/target ID。已有数字 target 频道和 `autoStart` 设置可保留。
5. 旧应用保持停止，启动新应用。检查 WebUI 管理员登录、机器人连接、队列、头像、两间房音频及固定频道权限；确认网络和各音源可用。
6. 迁移完成后保留停止的旧应用和原始备份作为回退，不要让旧应用自动重启。可继续使用原 WebUI 端口，使现有访问入口保持可用。

不要让两个应用同时连接同一 TeamSpeak 身份，也不要让双方共享可写数据库目录。新应用会写入自己的数据副本，旧目录保留为迁移时的回退点。

回退时先停止新应用，确认退出，再启动旧应用使用其原始目录和原镜像。新应用运行期间产生的新数据不会自动回流到旧副本；如需恢复这些变更，应另行制定数据迁移方案。

## 更新

更新前备份 data 并记录当前镜像 digest。拉取新镜像后重建应用，检查启动日志和镜像功能。TrueNAS 中修改镜像版本并更新应用；Docker Compose 执行 `docker compose pull` 和 `docker compose up -d --no-build`。

升级发生数据库迁移时，回退应配合对应版本的备份，不能只把旧镜像接到已迁移数据库上。敏感 data、部署导出、身份、账号密码和令牌保持在仓库之外。
