# 喵墨服务端源码

本目录包含基于 [InkSight](https://github.com/datascale-ai/inksight) 修改的后端与网页控制台。安装、升级与备份说明见根目录 [README](../README.md)，来源与改动见 [UPSTREAM.md](../UPSTREAM.md)。原 MIT 许可证保留在 [LICENSE](LICENSE)，第三方资源见 [NOTICE](../NOTICE)。

**本地版免登录，仅适用于可信局域网。** 请按[局域网部署说明](../docs/LAN_ONLY.md)安装，不要将控制台或设备 API 暴露到公网。

- `backend`：FastAPI、内容渲染、照片处理、设备 API。
- `webapp`：Next.js 相框工作区和本地控制台。
- `docs`：接口及协议参考。

开发与验证命令见 [DEVELOPMENT.md](../docs/DEVELOPMENT.md)。
