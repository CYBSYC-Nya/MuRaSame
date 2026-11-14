# MuRaSame 创作助手

DeepSeek Harness 多模态创作智能体：图片生成与超分、视频按描述剪辑、配音与字幕、项目成品管理。

制作者：丛雨不善言辞

## Real-ESRGAN 模型说明

GitHub 源码仓库不包含 `bin/realesrgan/` 下的模型与可执行文件（体积较大，约 45 MB）。

安装插件后，把完整的 `bin/realesrgan/` 目录放回插件根目录即可启用 2×/3×/4× AI 超分；不安装也不影响生图、视频、配音和项目功能。完整插件包见比赛提交目录的 `05_MuRaSame插件本体与安装说明/MuRaSame_DSH插件_v1.23.0.zip`。

## 安装

```text
plugin_manager.install_bundle("D:/DSH-Plugins/dsh-creative-console")
```

安装 Agent preset：

```text
plugin_manager.install_bundle("D:/DSH-Plugins/murasame-preset")
```

刷新后左侧出现 MRS 竖栏；点开进入创作台。
