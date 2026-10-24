# 开发与验证

部署和后端原生图像库以 Linux 为目标；可使用 Linux、WSL 或 Docker。后端镜像使用 Python 3.11，网页镜像使用 Node 22。原生 Windows 的动态库构建尚未适配，请使用 Linux 环境。

## 网页

从 `source/webapp` 执行：

```sh
npm ci
npm exec -- tsx --test proxy.test.ts app/api/local-proxy.test.ts app/api/uploads/route.test.ts app/config/page.test.ts app/flash/release-options.test.ts components/local/frame-panel.test.tsx lib/local-photo-source.test.ts lib/photo-color-profile.test.ts lib/photo-editor.test.ts lib/photo-workspace.test.ts
npm exec -- tsc --noEmit
npm run build
```

测试需要允许临时的本机回环监听端口。开发时可用 `npm run dev`；通过 `INKSIGHT_BACKEND_API_BASE` 指向独立的测试后端，并设置 `INKSIGHT_ALLOWED_WEB_HOSTS`。不要将开发服务器或测试接入正在使用的数据库。

## 后端回归

运行镜像不包含测试依赖。在仓库根目录构建独立测试镜像，再将测试目录以只读方式挂入，数据库使用临时目录：

```sh
docker build -f deployment/Dockerfile.backend -t miaomo-server-backend:test .
printf 'FROM miaomo-server-backend:test\nRUN pip install --no-cache-dir "pytest>=8.4,<9" "pytest-asyncio>=1.2,<2"\n' | docker build -t miaomo-server-tests:test -f - .
docker run --rm --network none --tmpfs /data \
  -v "$PWD/source/backend/tests:/app/backend/tests:ro" \
  miaomo-server-tests:test python -m pytest -q \
  tests/test_photo_color_profiles.py tests/test_eink_warm.py \
  tests/test_image_processing.py tests/test_json_renderer.py \
  tests/test_unit_renderer.py tests/test_unit_cache.py tests/test_local_edition.py
```

这组回归覆盖本地版、四色与自然暖调、照片处理和渲染。它是发布验证子集，不代表 `tests` 目录中的全部历史测试均已验证。探索完整测试集时也请使用独立容器和临时数据，勿挂载生产 `data`。

若直接在 Linux 开发环境运行，从 `source/backend` 安装 `requirements-dev.txt`，执行 `python scripts/build_native_dither.py` 后再运行上述 pytest 列表；还需 C++17 编译器、libopus、FreeType 和仓库提供的字体。

## 安装与恢复

按根目录 README 将 `deployment/compose.yml` 复制到根目录，再运行环境初始化脚本。Compose 的构建路径、数据目录和环境文件均相对项目根目录；直接从 `deployment` 运行不会得到同样的路径。

恢复到新主机前，先完成环境初始化并建立独立 `data` 目录；恢复加密设置需要备份实例原有的 `ENCRYPTION_KEY`。ZIP 不携带该环境密钥。

首次构建需要下载基础镜像及 apt、pip、npm 依赖。基础镜像和 npm 锁文件已固定，部分 Python 依赖仍使用版本范围，不保证离线或逐字节可重复构建。
