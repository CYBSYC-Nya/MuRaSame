# MuRaSame 创作助手

> Maker: 丛雨不善言辞

A collapsible left-sidebar creative console for DeepSeek Harness:

- **AI image generation + optimisation** — Pollinations (no key), Seedream / Volcengine Ark, SiliconFlow, DashScope Wanx, or any OpenAI-compatible `/images/generations`; generate 1–4 images, then send any result straight into the optimiser.
- **AI super-resolution** — bundled Real-ESRGAN ncnn Vulkan (2×/3×/4×, photo/anime models) for generated or local images.
- **Multi-voice TTS + custom voice presets** — 20 Edge voices, 10 RVC-style timbre transforms, optional local RVC model, and recording-to-preset conversion: record/upload a sample, convert it with a DSP voice (or RVC model), save it as a custom preset for future TTS.
- **Open outputs folder** — a footer button opens the generated-products folder in Explorer; the host route is restricted to the plugin's own output root.
- **Language-guided video editing** — describe the cut (“keep the talking, drop the empty intro, about 30s”); the plugin samples frames, asks a vision LLM for source ranges, fills the timeline and can export immediately.
- **Editable API settings** — Base URL, vision model, key env and key for any OpenAI-compatible Chat Completions endpoint with image input.
- **Video editor** — trim multiple ranges, reorder a timeline, unify aspect ratio/fps/CRF, mute or mix a TTS voice track, one-click SRT soft subtitles, one-click subtitle voiceover, grab a cover frame, export MP4 with a progress job, or hand the timeline to Premiere as FCP XML.
- **Premiere hand-off (safe default)** — “PR 时间线” writes a Premiere-importable FCP XML without connecting to, reading, or modifying a running Premiere project. Live CEP/Pymiere bridging is not enabled by default; it requires explicit opt-in.
- **Voice lab** — 20 Edge neural voices, 10 RVC-style DSP timbres, rate/pitch/volume controls, automatic SRT subtitles, preview and one-click hand-off to the video editor. Optional local RVC models through a command template.

The console folds **left into the sidebar** on “收起”, leaving a vertical handle to reopen it. Everything runs locally except the chosen image-generation provider. Outputs go to `<workspace>/.creative-console/`.

## Agent tools

The plugin registers 8 DSH tools so any agent can run the workflow from chat:

`creative_image_generate`, `creative_image_upscale`, `creative_image_optimize`, `creative_voice_generate`, `creative_video_export`, `creative_subtitle_apply`, `creative_premiere_xml`, `creative_media_status`.

That makes it an agent capability layer (the model chooses and composes the tools). A dedicated agent preset with its own persona/system prompt can be added on top if needed.

See [README.zh.md](README.zh.md) for installation, provider setup, RVC setup and the full API surface.

## Requirements

- DSH `>= 0.2.0-rc.2`
- FFmpeg (auto-detected in the workspace `tools/` folder or `PATH`)
- Python + Pillow for images (the DSH runtime already includes both)
- edge-tts for speech (the DSH runtime already includes it)
- Optional: a local RVC inference command + `.pth` models
- Image generation: Pollinations by default; presets for Seedream / Volcengine Ark, SiliconFlow, DashScope Wanx, and any OpenAI-compatible endpoint
- AI upscaling: Vulkan GPU for the bundled Real-ESRGAN ncnn binaries
- Language-guided editing: an OpenAI-compatible vision model (Base URL + API key)

## Quick install

```text
plugin_manager.install_bundle("D:/DSH-Plugins/dsh-creative-console")
```

The client registers `sidebar.footer.action`; the host exposes `/api-ext/creative-console/*`.

MIT licensed.
