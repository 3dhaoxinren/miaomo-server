# 来源与改动

miaomo-server 是基于 [datascale-ai/inksight](https://github.com/datascale-ai/inksight) 的独立本地版，面向可信局域网里的软路由、浏览器、喵墨 App 与 ESP32 设备。

## InkSight 来源

- 上游仓库：https://github.com/datascale-ai/inksight
- 引入基线：[ea73138e8f69b8632d39295afeab32c3560d92c4](https://github.com/datascale-ai/inksight/tree/ea73138e8f69b8632d39295afeab32c3560d92c4)
- 上游许可证：[MIT，Copyright (c) 2026 datascale-ai](https://github.com/datascale-ai/inksight/blob/ea73138e8f69b8632d39295afeab32c3560d92c4/LICENSE)
- 原许可证完整保留于 [LICENSE](LICENSE) 与 [source/LICENSE](source/LICENSE)。

本仓库从已经运行和验证的本地版源码建立独立历史。上述提交是代码来源基线，不表示本仓库是该提交的原样镜像。

## 本地版主要改动

- 以相框为首页，提供手机与桌面布局、照片编辑、轮播、日历和设备管理。
- 收敛为一个免登录的局域网实例，移除注册登录、账号共享、邀请码、额度及社区运营流程。
- 保留设备与照片数据兼容、现有模式、设备 API、本地模型配置、备份和恢复。
- 照片编辑支持经典四色与自然暖调，按照片保存选择，并与手机 App 的预览和上传元数据配合。
- 提供 Linux Docker Compose 部署、指定局域网地址绑定与环境初始化。

## 自然暖调算法参考

自然暖调参考 [atunverse/moink](https://github.com/atunverse/moink/tree/081af81ec05c6a66f9fe6d5f598bcf229eff8723) 的 `einkwarm` 算法思路，参考版本固定为 `081af81ec05c6a66f9fe6d5f598bcf229eff8723`。

本项目独立编写 C++ 实现，并用独立数学参考样本验证；没有将该项目的网页或实现代码复制进本仓库。所采用的组合为 natural/std/Floyd–Steinberg，误差扩散强度 0.85。该参考项目的授权声明不被解释为本仓库可以重新许可其代码。

## A1 显示流程修复参考

`firmware/esp32-c3-a1` 独立实现了针对固定应用镜像的完整 A1 显示流程适配，参考并核对 [Moink 固定版本的驱动行为](https://github.com/atunverse/moink/blob/081af81ec05c6a66f9fe6d5f598bcf229eff8723/src/epd_drv.c) 和 [InkSight Huawei A1 适配](https://github.com/krstc/InkSight_adapt_HUAWEI_eink/tree/78ceea65ec754fcacc3a9a6036416b755bd2f64c)。公开内容为本项目新增适配代码、构建工具和合成测试；未捆绑第三方原始驱动实现或基础固件镜像。用户必须提供哈希匹配的基线，本仓库原有 MIT 许可证不替代基础镜像自身的权利与许可。

设备保持原 GPIO 与软件 SPI 字节接口，替换 A1 初始化、连续窗口写帧、BUSY 确认和关屏流程；没有引入 Moink 的热点、OTA 或页面更新实现。详细对照、验证范围和回退说明见 [A1_REFRESH_FIX.md](docs/A1_REFRESH_FIX.md)。

## 第三方资源

字体等第三方资源按各自许可证分发，其条款和版权声明见 [NOTICE](NOTICE) 及字体目录内的许可证。MIT 许可不替代这些资源各自的许可。
