# Docker、GHCR 与 TrueNAS 部署

部署单位是完整音乐机器人应用。镜像包含后端、WebUI、Node.js 22、FFmpeg、Opus 原生模块和 `yt-dlp 2026.08.19`，支持 `linux/amd64`、`linux/arm64`。不需要给官方旧镜像挂载补丁 `dist`，也不需要从宿主机挂载 FFmpeg 或 yt-dlp。

## GHCR 自动构建

GitHub Actions 工作流位于 [docker-publish.yml](../.github/workflows/docker-publish.yml)。默认主分支更新和版本 tag 推送触发构建，也可手动触发。镜像发布到 `ghcr.io/<owner>/<repository>`，所有者使用小写名称。主分支镜像使用 `:main`，发布 tag 按工作流生成版本标签；正式部署建议固定版本或 digest。

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
export TSMUSICBOT_IMAGE=ghcr.io/<owner>/<repository>:main
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
    image: ghcr.io/<owner>/<repository>:<version>
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

遵循先部署、验证新应用，再切换和停用旧应用的流程。旧应用运行期间先用 SQLite backup API 制作一致性副本，其他持久数据复制到独立路径；新副本禁用 autoStart，使用临时 WebUI 端口部署，避免复用正在服务的 TeamSpeak 身份。

完成健康、管理员、方案配置、持久化和使用独立测试身份的功能验证后，准备回退，在切换窗口刷新数据副本、交接原身份/频道与入口。两应用不能共享可写库或同时连接同一身份。切换会短暂中断播放。新应用和入口验证成功后旧应用保持停止，原数据保留；失败则先停止新应用，再恢复旧应用。

完整流程及旧镜像关系改为网页管理的说明已写在 [README 的迁移章节](../README.md#旧应用迁移和回退)。不要在运行中只复制 .db，或把旧实时 WAL 混入 SQLite backup 得到的副本。

## 更新

更新前备份 data 并记录当前镜像 digest。拉取新镜像后重建应用，检查启动日志和镜像功能。TrueNAS 中修改镜像版本并更新应用；Docker Compose 执行 `docker compose pull` 和 `docker compose up -d --no-build`。

升级发生数据库迁移时，回退应配合对应版本的备份，不能只把旧镜像接到已迁移数据库上。敏感 data、部署导出、身份、账号密码和令牌保持在仓库之外。
