# InkSight 本地控制台

本地版使用 Next.js + React。首页是相框工作区，主导航为相框、轮播、内容、设备、设置；不需要账号、注册或平台额度。

## 开发与构建

- 安装锁定依赖：`npm ci`
- 开发：`npm run dev`
- 构建：`npm run build`
- 检查：`npx tsc --noEmit`、`npm run lint`

`INKSIGHT_BACKEND_API_BASE` 在服务器运行时设置为 FastAPI 地址，例如 `http://127.0.0.1:8080`。未显式注册的 API 由 `app/api/[...path]/route.ts` 转发，支持 JSON、图片和 ZIP 流，不把后端地址固化在浏览器包中。`INKSIGHT_ALLOWED_WEB_HOSTS` 设置可访问控制台的主机名或局域网地址。

## 工作区

`app/config/page.tsx` 保留设备配置、动态模式设置、课表、日历、模式拼装器与图片编辑逻辑；`components/local/` 提供相框、本地设置、模板库、轮播清单和历史面板。查询参数 `section=frame|rotation|content|devices|settings` 切换工作区，`mac` 选中设备。

原 `/config`、`/profile`、`/discover`、`/preview`、`/mobile`、`/claim` 和 `/login` 路径保留轻量兼容入口。刷机、挂件和帮助页面继续可用。

照片采用原有上传与 PhotoEditor 编辑管线。相框保存保留其他配置并加入 MY_ADAPTIVE；在线设备会收到刷新通知，休眠设备在下次连接时取到设置。AI 密钥不在读取配置时回显，空密钥字段不覆盖原密钥。

设置页可下载包含数据库与照片的完整 ZIP 备份。恢复使用发行包的离线恢复命令，在停止服务后执行。

基于 [datascale-ai/inksight](https://github.com/datascale-ai/inksight)，遵循原 MIT 许可，发行包保留原项目及第三方署名。
