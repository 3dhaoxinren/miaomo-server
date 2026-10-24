# miaomo-server · 喵墨服务端

基于 [InkSight](https://github.com/datascale-ai/inksight) 独立维护的局域网墨水屏控制台，面向软路由和家用 Linux 主机。打开进入相框，无需注册或登录；手机浏览器、电脑和[喵墨 App](https://github.com/3dhaoxinren/miaomo)可连接同一服务。

> **仅适用于可信局域网（LAN only）。** 控制台免登录，能够访问服务的局域网成员具有管理权限。不支持公网部署，请勿通过公网端口映射、公网反向代理或内网穿透公开网页和设备 API。详见[局域网部署说明](docs/LAN_ONLY.md)。

本项目保留 InkSight 的原始 MIT 许可证与版权声明。代码来源、基础提交和本地版改动见 [UPSTREAM.md](UPSTREAM.md)，第三方字体与资源说明见 [NOTICE](NOTICE)。

## 保留的能力

- 相册上传与图片编辑、照片排序、轮播、墨水屏预览和手动刷新。
- 「编辑照片 → 滤镜」提供经典四色与自然暖调，每张照片独立选择，支持预览、撤销与取消。
- 30 个内置内容模式、日历提醒、课表、天气、倒计时、自定义与 AI 内容。
- 本地模板导入导出、设备管理、配置/内容历史、语音、挂件、固件和 OTA。
- 现有喵墨 App 和 ESP32 接口；旧页面入口映射到新的工作区。

本地版移除了注册登录、账号共享和审批、邀请码与额度扣减、社区发布、运营埋点及宣传页面。天气、资讯、AI 等功能仍会访问配置的数据源；“局域网部署”不等于所有功能离线运行。

## 目录

`source/backend` 是 FastAPI 服务，`source/webapp` 是 Next.js 界面，`deployment` 提供构建、环境初始化和离线恢复工具。运行时 `data` 保存 SQLite 数据库与照片，环境文件由用户在本机生成，均不纳入版本库。源项目许可证保留在根目录 [LICENSE](LICENSE) 和 [source/LICENSE](source/LICENSE)。

## 新安装

需要 Linux、Git、Python 3、Docker 与 Docker Compose v2。Compose 使用 Linux host 网络；已在 x86_64 软路由环境验证。首次安装从源码构建镜像，需要网络下载依赖。

在主机执行以下命令，将示例 `192.168.1.50` 换成本机的固定局域网 IPv4 地址：

```sh
git clone https://github.com/3dhaoxinren/miaomo-server.git
cd miaomo-server
cp deployment/compose.yml compose.yml
python3 deployment/init_environment.py --host 192.168.1.50
docker compose build
docker compose up -d
```

在同一局域网打开 `http://192.168.1.50:3000/zh`；设备 API 为 `http://192.168.1.50:8080`。可以在 `.env` 更改地址和端口。初始化脚本为新实例生成加密密钥，保留任何已有环境文件。发布仓库不提供预设密钥或用户数据。

部署只绑定 `.env` 中指定的地址；设备通信令牌、浏览器来源检查和接口频率限制继续保留。这些检查不构成控制台账号认证，也不会自动配置路由器防火墙。请保持该地址和两个端口仅在可信局域网内可达。

手机 App 单独在 [miaomo Releases](https://github.com/3dhaoxinren/miaomo/releases) 发布。本仓库不捆绑 APK；当前服务端与喵墨本地版 0.6.7 的滤镜元数据已完成联调。

## 从现有实例升级

先备份数据库、照片、`compose.yml`、`.env` 与 `deployment/backend.env`。保留现有 `data` 目录和 `backend.env`，尤其是 `ENCRYPTION_KEY`，再更新源码、构建镜像并执行 `docker compose up -d`。本仓库保留 Compose 项目名 `inksight`，兼容原有部署；不要让新旧实例同时使用相同端口或数据目录。首次启动会将设备关联、AI 设置、自定义模式和模板迁入本地实例；不会把历史状态记录自动添加成设备。迁移可以重复启动执行。

照片默认长期保留。自动过期与容量清理默认关闭，避免相框素材因长期未访问而被删除。

## 备份与恢复

在“设置”下载备份，或使用 `GET /api/local/backup`。ZIP 包含一致的 SQLite 快照、上传照片和 SHA-256 校验清单，不包含服务器环境文件。数据库包含设备配置及加密后的 AI 设置，请妥善保存；恢复加密设置还需要原 `backend.env` 中的密钥。

恢复在主机终端执行，先将 ZIP 放到主机的绝对路径：

```sh
sh deployment/restore.sh /absolute/path/inksight-local-backup.zip
```

脚本先停止网页与后端，验证归档路径、大小、校验和与数据库完整性，再替换数据库和照片，最后重启服务。旧数据保留在 `data/restore-rollback-时间/`。缓存会重建。运行中的数据库不支持直接覆盖恢复。

按旧版路径 `/opt/inksight` 安装的软路由可继续使用原 `/etc/init.d/inksight` 开机服务；其他安装位置使用 Docker 重启策略，或自行调整开机脚本的项目路径。

## 验证与维护

后端健康检查：`GET /api/health`。内容目录：`GET /api/modes/catalog`。本地实例设置：`GET /api/local/settings`。备份恢复命令的故障会返回非零退出码。后端测试与开发依赖保留在源码中，不进入运行镜像。

开发环境和可复现的测试命令见 [DEVELOPMENT.md](docs/DEVELOPMENT.md)。

查看服务日志：`docker compose logs --tail=100 backend web`。更改环境配置后执行 `docker compose up -d`。
