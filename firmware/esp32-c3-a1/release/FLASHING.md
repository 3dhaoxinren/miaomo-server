# 刷写与回退

这是已有 InkSight 安装的 **app0 升级包**，不含引导程序、分区表、文件系统或个人设置。适用 ESP32-C3、A1 屏及下表分区布局。新板、其他布局、其他基线不能直接使用此流程。

固件文件：`miaomo-c3-a1-20261024.app.bin`，1,202,896 字节。

SHA-256：`befb5bd8e02547f2ab21f36272e75e9b613e1a6f1c60130c6756bf1529023c10`。

| 分区 | 地址 | 大小 |
| --- | --- | --- |
| nvs | 0x9000 | 0x5000 |
| otadata | 0xE000 | 0x2000 |
| **app0（唯一写入区域）** | **0x10000** | **0x1E0000** |
| app1 | 0x1F0000 | 0x1E0000 |
| spiffs / LittleFS | 0x3D0000 | 0x20000 |
| coredump | 0x3F0000 | 0x10000 |

本版 GPIO 接法见 [WIRING.md](WIRING.md)。本说明保持原设置，刷完仍使用设备已有的 Wi-Fi 和局域网服务地址；不会将其他人的网络参数写到设备。

## 1. 安装工具并准备

安装 Python 3.10 或以上版本。下面的命令使用已验证的 esptool 5.1.0；`COMx` 必须替换成自己的串口，例如 Windows 的 `COM5`，Linux/macOS 可用 `/dev/ttyACM0` 等实际端口。

```sh
python -m pip install esptool==5.1.0
python -m serial.tools.list_ports
```

关闭占用串口的串口监视器。用支持数据传输的 USB 线连接 C3，在解压包内操作。需要手动进入下载模式时，按住 BOOT、点按 RESET，再松开 BOOT。

## 2. 备份并检查适配性

在新的工作目录保存备份；不要覆盖以前的备份。以下命令读取 4 MiB，不写设备：

```sh
python -m esptool --chip esp32c3 --port COMx --baud 460800 --after no-reset read-flash 0x0 0x400000 backup-before.bin
python check_before_flash.py --backup backup-before.bin --firmware miaomo-c3-a1-20261024.app.bin
```

**仅当检查器返回 PASS、且实物确认为 A1 时，才继续。** 检查器离线校验包内固件、备份长度、引导镜像、分区表、已验收的 OTA 选择数据和 app0 基线。它不会连接串口或刷机。未知版本、未知 OTA 数据、分区不符一律停止；不要用 `--force` 绕过。检查拒绝后，可按 RESET 恢复原程序运行。

允许的旧应用 SHA-256 为 `52a4c30da2dc0aec87da317d5a0cd22895535c1dfdbad43c48a8f32584a01af0`。检测到已安装本次修复版时，无需重复刷写。

备份包含 Wi-Fi、设备设置和图片，只在自己的电脑保管，不上传到 GitHub 或公开聊天。

## 3. 只写 app0 并核验

```sh
python -m esptool --chip esp32c3 --port COMx --baud 460800 --after no-reset write-flash 0x10000 miaomo-c3-a1-20261024.app.bin
python -m esptool --chip esp32c3 --port COMx --baud 460800 --after no-reset verify-flash 0x10000 miaomo-c3-a1-20261024.app.bin
python -m esptool --chip esp32c3 --port COMx --after watchdog-reset flash-id
```

每条命令成功后再执行下一条。只写 `0x10000` 的 app 镜像，不执行 `erase-flash`，也不把本文件写到 `0x0`。不要添加修改 Flash 模式、频率、加密或全片擦除的选项。串口传输不稳定时将 `460800` 改为 `115200`。

重新启动后，在本地服务端检查设备上线，选择原照片并点击“立即刷新”。服务端需包含 [PR #1](https://github.com/3dhaoxinren/miaomo-server/pull/1) 的兼容头修复，才能使相同照片强制刷屏。完整刷新完成后观察中线；刷写成功和实屏显示正常是两项分别检查的结果。

## 4. 回退到自己备份的原应用

保持原板与原分区表，用自己的 `backup-before.bin` 提取 app0。不要使用别人的全片备份：

```sh
python extract_app_backup.py --backup backup-before.bin --output backup-app0.bin
python -m esptool --chip esp32c3 --port COMx --baud 460800 --after no-reset write-flash 0x10000 backup-app0.bin
python -m esptool --chip esp32c3 --port COMx --baud 460800 --after no-reset verify-flash 0x10000 backup-app0.bin
python -m esptool --chip esp32c3 --port COMx --after watchdog-reset flash-id
```

只恢复原 app0，不覆盖 NVS、OTA 数据、分区表、文件系统。若此前已自行改过这些区域，本回退流程不覆盖那类情况。

命令依据：[Espressif esptool 基础命令](https://docs.espressif.com/projects/esptool/en/latest/esp32c3/esptool/basic-commands.html)。本包没有自动刷机程序，也不会在打开时连接设备。

