# 固件参考来源

- 基础固件参考：**BarryBaBa** 发布的 Huawei A0/A1 固件附件 `firmware_merged_A1_A0.zip`。[原发布页](https://makerworld.com.cn/zh/models/2694038-hua-wei-3-98cun-mo-shui-ping-zhi-chi-a0-a1gu-jian)。本次应用镜像是在已有基础应用上加入修复后的版本，不是原作者的官方更新。
- 局域网服务与既有应用生态参考：[InkSight](https://github.com/datascale-ai/inksight)。InkSight 原 MIT 许可证单独附在 `LICENSE-InkSight.txt`，保留其原版权说明。
- Huawei A1 适配参考：[krstc/InkSight_adapt_HUAWEI_eink，78ceea65](https://github.com/krstc/InkSight_adapt_HUAWEI_eink/tree/78ceea65ec754fcacc3a9a6036416b755bd2f64c)。
- A1 寄存器、窗口和时序参考：[atunverse/moink，081af81](https://github.com/atunverse/moink/blob/081af81ec05c6a66f9fe6d5f598bcf229eff8723/src/epd_drv.c)。保留现有软件 SPI HAL，未合并 Moink 整套源码、网络或 OTA 实现。
- 本次修复与发布维护：[3dhaoxinren/miaomo-server](https://github.com/3dhaoxinren/miaomo-server)。适配源码位于 `firmware/esp32-c3-a1`。

原有组件保留各自的版权与许可。附带的 InkSight MIT 文本只对应相应组件，参考署名不改变其他来源的许可，也不表示原作者为本次修改提供背书。

