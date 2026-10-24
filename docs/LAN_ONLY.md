# 仅适用于可信局域网

miaomo-server 是家庭局域网内共同管理的墨水屏服务，控制台不设注册、登录或成员权限。能够访问网页或管理 API 的人可以管理设备、照片、轮播和服务设置。

## 部署范围

- 手机、浏览器、ESP32 与服务器应位于同一可信局域网。
- 将 `INKSIGHT_HOST` 设置为服务器的固定局域网 IPv4 地址，例如 `192.168.1.50`。避免使用 `0.0.0.0`、公网地址或会解析到公网的域名作为部署绑定地址。
- 网页默认使用 TCP 3000，设备 API 默认使用 TCP 8080。两个端口均限于可信局域网，不向访客网络或互联网开放。
- 不支持公网部署。不要配置公网端口映射、公网反向代理或内网穿透来公开此服务。

Compose 使用 Linux host 网络，由服务自身绑定 `INKSIGHT_HOST`，没有 Docker 的端口映射隔离层。Host/Origin 校验、设备令牌和限流仍保留，但它们不等同于控制台登录。该项目不会自动管理宿主机和软路由的防火墙。

## 初始化与数据

在项目根目录执行：

```sh
cp deployment/compose.yml compose.yml
python3 deployment/init_environment.py --host 192.168.1.50
docker compose build
docker compose up -d
```

请替换示例地址。初始化只创建缺失的 `.env` 和 `deployment/backend.env`，不会重置已有值或加密密钥。数据库与照片保存在 `data/`；升级和恢复时保留这些文件以及原 `ENCRYPTION_KEY`。

运行环境文件、照片、数据库、设备令牌和备份属于部署实例，不应提交到代码仓库。仓库提供 `.env.example` 和 `deployment/backend.env.example` 作为格式说明。

天气、资讯与 AI 功能会向配置的数据源发送请求；局域网部署范围描述的是入站访问边界，并不表示服务完全离线。

“仅适用于局域网”是本项目的运行与支持范围说明，原 MIT 许可证文本保持不变。
