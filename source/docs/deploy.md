# 本地部署与自托管

本仓库的安装入口是根目录 [README](../../README.md)。它针对 Linux 软路由及家用主机，以 Docker Compose 运行 FastAPI 后端和 Next.js 控制台。

**仅适用于可信局域网，控制台免注册、免登录。** 能访问服务的局域网成员具有管理权限。不要将网页端口或设备 API 公开到互联网；完整边界见 [LAN_ONLY.md](../../docs/LAN_ONLY.md)。

## 新安装

安装 Git、Python 3、Docker 与 Docker Compose v2。从仓库根目录执行，将示例地址替换成本机固定局域网 IPv4 地址：

```sh
cp deployment/compose.yml compose.yml
python3 deployment/init_environment.py --host 192.168.1.50
docker compose build
docker compose up -d
```

网页为 `http://192.168.1.50:3000/zh`，设备 API 为 `http://192.168.1.50:8080`。Compose 使用 Linux host 网络；这两个端口只应对可信局域网开放。

初始化脚本生成 `.env` 与 `deployment/backend.env`，保留已有文件。`data` 保存数据库和照片。备份时也要保存环境文件中的加密密钥；仓库不提供真实密钥、设备数据库或照片。

## 手机与设备

[喵墨 App](https://github.com/3dhaoxinren/miaomo) 独立发布，连接此服务即可使用相框、轮播、日历和照片滤镜。当前仓库只包含服务端；设备刷机与 OTA 接口仍保留，固件需使用完整的独立固件工程或兼容的发布文件。

## 开发和维护

开发与测试命令见 [DEVELOPMENT.md](../../docs/DEVELOPMENT.md)。备份恢复与升级步骤见根目录 README。旧版云账号、邀请码、额度与 Expo 开发步骤不适用于本地版。
