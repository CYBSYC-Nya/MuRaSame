/**
 * dsh-creative-console — browser half.
 *
 * Adds a collapsible 创作台 console to the left sidebar footer. Everything is
 * plain React (no build step): the panel talks to this plugin's host routes for
 * Pillow image optimisation, FFmpeg timeline export and edge-tts voice shaping.
 */
window.__ModuleLoader__.load({
  id: 'dsh-creative-console',
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useRef, useCallback, useMemo, createElement: h } = React
    let createPortal = null
    try {
      createPortal = require('react-dom').createPortal ?? null
    } catch {
      /* fall back to inline rendering if the host does not expose react-dom */
    }

    const API = '/api-ext/creative-console'
    const LS_TAB = 'dsh-creative-console.tab'

    const IMAGE_PRESETS = {
      web: { label: '网页轻量', desc: 'WebP · 1920 内 · 82 质量', format: 'webp', quality: 82, maxWidth: 1920, maxHeight: 1920, mode: 'fit', enhance: false },
      hd: { label: '高清保留', desc: 'PNG · 2560 内 · 无损', format: 'png', quality: 100, maxWidth: 2560, maxHeight: 2560, mode: 'fit', enhance: false },
      social: { label: '社交方图', desc: 'JPG · 1080² · 居中裁切', format: 'jpeg', quality: 90, maxWidth: 1080, maxHeight: 1080, mode: 'crop', enhance: true },
      avatar: { label: '头像 512', desc: 'WebP · 512² · 居中裁切', format: 'webp', quality: 88, maxWidth: 512, maxHeight: 512, mode: 'crop', enhance: false },
    }

    const UPSCALE_MODEL_LABELS = {
      'realesrgan-x4plus': '照片 / 通用',
      'realesrgan-x4plus-anime': '二次元 / 插画',
      'realesr-animevideov3-x4': '动画 / 视频帧',
    }

    const RESOLUTIONS = [      { id: '1080p', label: '1080p · 横屏', hint: '1920 × 1080' },
      { id: '720p', label: '720p · 轻量', hint: '1280 × 720' },
      { id: 'vertical', label: '竖屏 9:16', hint: '1080 × 1920' },
      { id: 'square', label: '方形 1:1', hint: '1080 × 1080' },
      { id: 'source', label: '跟随原片', hint: '第一段尺寸' },
    ]

    const LOCALE_LABEL = { 'zh-CN': '普通话', 'zh-TW': '台湾', 'zh-HK': '粤语', 'en-US': 'English', 'ja-JP': '日本語' }

    // ------------------------------------------------------------------ utils

    async function api(name, body) {
      const response = await fetch(`${API}/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const payload = await response.json().catch(() => null)
      if (!payload || payload.ok !== true) {
        throw new Error(payload?.error?.message ?? `HTTP ${response.status}`)
      }
      return payload.value
    }

    function formatBytes(bytes) {
      const value = Number(bytes)
      if (!Number.isFinite(value) || value <= 0) return '—'
      if (value < 1024) return `${value} B`
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
      if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MB`
      return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`
    }

    function formatDuration(seconds) {
      const value = Number(seconds)
      if (!Number.isFinite(value) || value <= 0) return '0:00'
      const total = Math.round(value)
      const h = Math.floor(total / 3600)
      const m = Math.floor((total % 3600) / 60)
      const s = total % 60
      return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
    }

    function shortPath(path, max = 54) {
      const value = String(path ?? '')
      if (value.length <= max) return value
      return `${value.slice(0, 18)}…${value.slice(-(max - 19))}`
    }

    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(String(text ?? ''))
        return true
      } catch {
        return false
      }
    }

    function fileToDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result ?? ''))
        reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
        reader.readAsDataURL(file)
      })
    }

    const numberValue = (value, fallback = 0) => {
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : fallback
    }

    const clamp = (value, min, max) => Math.min(max, Math.max(min, numberValue(value, min)))

    // ------------------------------------------------------------------ icons

    const ICON_PATHS = {
      sparkles: [
        'M12 3l1.7 4.6L18.5 9l-4.8 1.4L12 15l-1.7-4.6L5.5 9l4.8-1.4L12 3z',
        'M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z',
      ],
      image: ['M4 5h16v14H4z', 'M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z', 'M5 17l4.5-4.5 3 3L16 12l3.5 3.5'],
      film: ['M4 5h16v14H4z', 'M8 5v14', 'M16 5v14', 'M4 9h4', 'M4 15h4', 'M16 9h4', 'M16 15h4'],
      mic: ['M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z', 'M5.5 11a6.5 6.5 0 0 0 13 0', 'M12 17.5V21', 'M8.5 21h7'],
      chevronDown: ['M6 9l6 6 6-6'],
      chevronUp: ['M6 15l6-6 6 6'],
      chevronLeft: ['M15 6l-6 6 6 6'],
      chevronRight: ['M9 6l6 6-6 6'],
      copy: ['M8 8h11v11H8z', 'M5 16V5h11'],
      folder: ['M3 6h7l2 2h9v10H3V6z'],
      download: ['M12 3v12', 'M7 10l5 5 5-5', 'M4 21h16'],
      play: ['M8 5l11 7-11 7V5z'],
      trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 14h10l1-14'],
      plus: ['M12 5v14', 'M5 12h14'],
      arrowUp: ['M12 19V5', 'M6 11l6-6 6 6'],
      arrowDown: ['M12 5v14', 'M6 13l6 6 6-6'],
      close: ['M6 6l12 12', 'M18 6L6 18'],
      settings: ['M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z', 'M4 12h2', 'M18 12h2', 'M12 4v2', 'M12 18v2', 'M6.3 6.3l1.4 1.4', 'M16.3 16.3l1.4 1.4', 'M17.7 6.3l-1.4 1.4', 'M7.7 16.3l-1.4 1.4'],
      refresh: ['M20 11a8 8 0 1 0-2 6', 'M20 5v6h-6'],
      wand: ['M4 20l10-10', 'M14 4l1 2 2 1-2 1-1 2-1-2-2-1 2-1 1-2z', 'M19 13l.6 1.4L21 15l-1.4.6L19 17l-.6-1.4L17 15l1.4-.6L19 13z'],
    }

    function Glyph({ name, size = 16 }) {
      const paths = ICON_PATHS[name] ?? ICON_PATHS.sparkles
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        paths.map((d, index) => h('path', { key: index, d })),
      )
    }

    // ------------------------------------------------------------------ bits

    function CopyButton({ text, label = '复制路径', className = '' }) {
      const [copied, setCopied] = useState(false)
      return h(
        'button',
        {
          type: 'button',
          className: `cc-btn cc-btn-ghost ${className}`,
          onClick: async () => {
            const ok = await copyText(text)
            setCopied(ok)
            window.setTimeout(() => setCopied(false), 1400)
          },
          title: text,
        },
        h(Glyph, { name: 'copy', size: 13 }),
        copied ? '已复制' : label,
      )
    }

    function ErrorLine({ error }) {
      if (!error) return null
      return h('div', { className: 'cc-error' }, h('span', null, '!'), String(error))
    }

    function Spinner() {
      return h('span', { className: 'cc-spinner', 'aria-hidden': 'true' })
    }

    function Field({ label, hint, children }) {
      return h(
        'label',
        { className: 'cc-field' },
        h('span', { className: 'cc-field-label' }, label, hint ? h('small', null, hint) : null),
        children,
      )
    }

    function EngineDots({ status }) {
      const engines = status?.engines ?? {}
      const items = [
        ['sparkles', '生图', status?.generator?.free === true || status?.generator?.hasKey === true],
        ['image', '图片', engines.image?.ok],
        ['film', '视频', engines.video?.ok],
        ['mic', '声线', engines.tts?.ok],
        ['sparkles', 'RVC', engines.rvc?.available],
      ]
      return h(
        'div',
        { className: 'cc-engines' },
        items.map(([icon, label, ready]) =>
          h(
            'span',
            { key: label, className: `cc-engine${ready ? ' is-ready' : ''}`, title: ready ? `${label}引擎就绪` : `${label}引擎不可用` },
            h('i', null),
            label,
          ),
        ),
      )
    }

    // ------------------------------------------------------------------ status

    function useStatus() {
      const [status, setStatus] = useState(null)
      const [error, setError] = useState(null)
      const [loading, setLoading] = useState(true)
      const load = useCallback(async () => {
        try {
          const value = await api('status')
          setStatus(value)
          setError(null)
          return value
        } catch (failure) {
          setError(String(failure?.message ?? failure))
          return null
        } finally {
          setLoading(false)
        }
      }, [])
      useEffect(() => {
        void load()
      }, [load])
      return { status, error, loading, reload: load }
    }

    // ------------------------------------------------------------------ image

    const IMAGE_SIZE_OPTIONS = [
      { id: '1024x1024', label: '1:1', hint: '1024²' },
      { id: '1536x1024', label: '3:2', hint: '横图' },
      { id: '1024x1536', label: '2:3', hint: '竖图' },
      { id: '1344x768', label: '16:9', hint: '宽屏' },
      { id: '768x1344', label: '9:16', hint: '竖屏' },
    ]

    const PROMPT_STYLES = [
      ['电影感', 'cinematic lighting, film still, 35mm, shallow depth of field, detailed'],
      ['扁平插画', 'flat vector illustration, clean shapes, editorial color palette, minimal'],
      ['产品海报', 'premium product poster, studio lighting, minimal layout, negative space'],
      ['二次元', 'anime key visual, expressive eyes, detailed background, vibrant'],
    ]

    function GenerateResultCard({ image, prompt, onOptimize }) {
      return h(
        'div',
        { className: 'cc-gen-card' },
        h('img', { src: image.url, alt: prompt, loading: 'lazy' }),
        h(
          'div',
          { className: 'cc-gen-card-body' },
          h(
            'div',
            { className: 'cc-gen-card-meta' },
            h('span', null, `${image.width || '—'} × ${image.height || '—'}`),
            h('span', null, formatBytes(image.bytes)),
          ),
          h(
            'div',
            { className: 'cc-gen-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'cc-btn cc-btn-solid',
                onClick: () => onOptimize(image.path),
              },
              h(Glyph, { name: 'wand', size: 12 }),
              '\u4f18\u5316\u8fd9\u5f20',
            ),
            h(
              'a',
              {
                className: 'cc-icon-btn',
                href: image.downloadUrl,
                target: '_blank',
                rel: 'noreferrer',
                title: '下载',
              },
              h(Glyph, { name: 'download', size: 13 }),
            ),
            h(CopyButton, { text: image.path, label: '复制' }),
          ),
        ),
      )
    }

    function GenerateResults({ result, onOptimize }) {
      return h(
        'div',
        { className: 'cc-gen-results' },
        h(
          'div',
          { className: 'cc-result-head' },
          h(Glyph, { name: 'image', size: 14 }),
          h('b', null, `生成完成 · ${result.images.length} 张`),
          h('span', null, `${result.model} · ${result.size}`),
        ),
        h(
          'div',
          { className: 'cc-gen-grid' },
          result.images.map((image) =>
            h(GenerateResultCard, { key: image.id, image, prompt: result.prompt, onOptimize }),
          ),
        ),
      )
    }

    function ImageGeneratePanel({ status, onOptimize, onSettings }) {
      const generator = status?.generator
      const [prompt, setPrompt] = useState('')
      const [model, setModel] = useState(generator?.model ?? '')
      const [size, setSize] = useState(generator?.size ?? '1024x1024')
      const [count, setCount] = useState(1)
      const [quality, setQuality] = useState(generator?.quality ?? '')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [result, setResult] = useState(null)

      useEffect(() => {
        if (!generator) return
        setModel(generator.model)
        setSize(generator.size)
        setQuality(generator.quality ?? '')
      }, [generator?.provider, generator?.model, generator?.size, generator?.quality])

      const provider = generator?.provider ?? 'pollinations'
      const models = generator?.models ?? ['flux']
      const needsKey = generator && generator.hasKey === false
      const isGptImage = /gpt-image/i.test(model)

      const generate = async () => {
        if (prompt.trim() === '') {
          setError('先写一句画面描述')
          return
        }
        setBusy(true)
        setError(null)
        setResult(null)
        try {
          const value = await api('image/generate', {
            prompt: prompt.trim(),
            model,
            size,
            n: count,
            quality: isGptImage ? quality : '',
          })
          setResult(value)
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally {
          setBusy(false)
        }
      }

      const appendStyle = (text) => {
        setPrompt((current) => (current.trim() === '' ? text : `${current.trim()}, ${text}`).slice(0, 4000))
      }

      const qualityField = generator?.free
        ? h(
            Field,
            { label: '质量', hint: '免费通道固定' },
            h('input', { className: 'cc-input', value: '标准', disabled: true }),
          )
        : h(
            Field,
            { label: '质量', hint: isGptImage ? 'gpt-image' : '兼容参数' },
            h(
              'select',
              {
                className: 'cc-input',
                value: quality,
                disabled: !isGptImage,
                onChange: (event) => setQuality(event.target.value),
              },
              h('option', { value: '' }, '默认'),
              h('option', { value: 'low' }, '快速'),
              h('option', { value: 'medium' }, '均衡'),
              h('option', { value: 'high' }, '精细'),
            ),
          )

      const sizeChips = IMAGE_SIZE_OPTIONS.map((item) =>
        h(
          'button',
          {
            key: item.id,
            type: 'button',
            className: `cc-chip cc-size-chip${size === item.id ? ' is-active' : ''}`,
            onClick: () => setSize(item.id),
          },
          h('b', null, item.label),
          h('span', null, item.hint),
        ),
      )

      const countChips = [1, 2, 4].map((value) =>
        h(
          'button',
          {
            key: value,
            type: 'button',
            className: `cc-count${count === value ? ' is-active' : ''}`,
            onClick: () => setCount(value),
          },
          `${value} 张`,
        ),
      )

      return h(
        'div',
        { className: 'cc-panel cc-generate-panel' },
        h(
          'div',
          { className: 'cc-section-head' },
          h(
            'div',
            null,
            h('h3', null, 'AI 生图'),
            h(
              'p',
              null,
              provider === 'pollinations' ? '免 Key 通道，生成后可直接进入优化' : 'OpenAI 兼容 /images/generations',
            ),
          ),
          h(
            'span',
            { className: `cc-pill${provider === 'pollinations' ? ' is-free' : ''}` },
            provider === 'pollinations' ? '免 Key' : generator?.hasKey ? 'Key 已配置' : '缺 Key',
          ),
        ),
        h(
          'div',
          { className: 'cc-block' },
          h('div', { className: 'cc-block-title' }, '画面描述', h('span', null, `${prompt.length} / 4000`)),
          h('textarea', {
            className: 'cc-textarea cc-prompt',
            rows: 5,
            maxLength: 4000,
            value: prompt,
            placeholder: '例如：雨夜霓虹街头的赛博朋克猫，电影感侧逆光，浅景深，16:9',
            onChange: (event) => setPrompt(event.target.value),
          }),
          h(
            'div',
            { className: 'cc-chip-row' },
            PROMPT_STYLES.map(([label, text]) =>
              h('button', { key: label, type: 'button', className: 'cc-chip', onClick: () => appendStyle(text) }, label),
            ),
          ),
        ),
        h(
          'div',
          { className: 'cc-block' },
          h('div', { className: 'cc-block-title' }, '输出参数'),
          h(
            'div',
            { className: 'cc-grid-2' },
            h(
              Field,
              { label: '模型' },
              h(
                'select',
                { className: 'cc-input', value: model, onChange: (event) => setModel(event.target.value) },
                models.map((item) => h('option', { key: item, value: item }, item)),
              ),
            ),
            qualityField,
          ),
          h(
            'div',
            { className: 'cc-field' },
            h('span', { className: 'cc-field-label' }, '画幅', h('small', null, size.replace('x', ' × '))),
            h('div', { className: 'cc-chip-row' }, sizeChips),
          ),
          h(
            'div',
            { className: 'cc-slider-row' },
            h('span', null, '数量'),
            h('div', { className: 'cc-count-row' }, countChips),
            h('b', null, generator?.free ? '免费' : '按次计费'),
          ),
        ),
        needsKey
          ? h(
              'div',
              { className: 'cc-note is-warn' },
              `当前通道需要 API Key。点右上角齿轮填入，或把 ${generator.keyEnv} 放进 DSH 凭据/环境变量。`,
              h('button', { type: 'button', className: 'cc-inline-link', onClick: onSettings }, '去设置'),
            )
          : null,
        generator?.free
          ? h(
              'div',
              { className: 'cc-note' },
              'Pollinations 免费通道同一 IP 约 45 秒 1 张，批量生成可能被限流；Prompt 会发送到该服务，结果自动保存到工作区。',
            )
          : null,
        h(ErrorLine, { error }),
        h(
          'div',
          { className: 'cc-action-row' },
          h(
            'button',
            {
              type: 'button',
              className: 'cc-btn cc-btn-primary cc-btn-wide',
              disabled: busy || needsKey,
              onClick: () => void generate(),
            },
            busy ? h(Spinner) : h(Glyph, { name: 'sparkles', size: 15 }),
            busy ? '正在生成…可能需要几十秒' : '生成图片',
          ),
        ),
        busy
          ? h(
              'div',
              { className: 'cc-gen-progress' },
              h('i', null),
              h('span', null, '已提交生图请求，正在等待上游返回…'),
            )
          : null,
        result ? h(GenerateResults, { result, onOptimize }) : null,
      )
    }

    function ImagePanel({ status, onSettings, seedPath = '' }) {
      const [mode, setMode] = useState('generate')
      const [seed, setSeed] = useState('')

      useEffect(() => {
        if (seedPath === '') return
        setSeed(seedPath)
        setMode('optimize')
      }, [seedPath])

      return h(
        'div',
        { className: 'cc-image-shell' },
        h(
          'div',
          { className: 'cc-mode-switch', role: 'tablist' },
          [
            ['generate', 'AI 生图', 'sparkles'],
            ['optimize', '优化图片', 'wand'],
          ].map(([id, label, icon]) =>
            h(
              'button',
              {
                key: id,
                type: 'button',
                role: 'tab',
                'aria-selected': mode === id,
                className: `cc-mode${mode === id ? ' is-active' : ''}`,
                onClick: () => setMode(id),
              },
              h(Glyph, { name: icon, size: 14 }),
              label,
            ),
          ),
        ),
        mode === 'generate'
          ? h(ImageGeneratePanel, {
              status,
              onSettings,
              onOptimize: (path) => {
                setSeed(path)
                setMode('optimize')
              },
            })
          : h(ImageOptimizePanel, { status, initialPath: seed }),
      )
    }

    function ImageOptimizePanel({ status, initialPath = '' }) {
      const [path, setPath] = useState('')
      const [info, setInfo] = useState(null)
      const [presetId, setPresetId] = useState('web')
      const [format, setFormat] = useState('webp')
      const [quality, setQuality] = useState(82)
      const [maxWidth, setMaxWidth] = useState(1920)
      const [maxHeight, setMaxHeight] = useState(1920)
      const [mode, setMode] = useState('fit')
      const [enhance, setEnhance] = useState(false)
      const [strip, setStrip] = useState(true)
      const [result, setResult] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [upscaleModel, setUpscaleModel] = useState(status?.engines?.upscale?.models?.[0] ?? 'realesrgan-x4plus')
      const [upscaleScale, setUpscaleScale] = useState(4)
      const [upscaleBusy, setUpscaleBusy] = useState(false)
      const [upscaleResult, setUpscaleResult] = useState(null)
      const [upscaleError, setUpscaleError] = useState(null)
      const fileRef = useRef(null)
      const initialAppliedRef = useRef('')

      const engine = status?.engines?.image
      const upscaler = status?.engines?.upscale
      const applyPreset = (id) => {
        setPresetId(id)
        const preset = IMAGE_PRESETS[id]
        if (!preset) return
        setFormat(preset.format)
        setQuality(preset.quality)
        setMaxWidth(preset.maxWidth)
        setMaxHeight(preset.maxHeight)
        setMode(preset.mode)
        setEnhance(preset.enhance)
      }

      const inspect = async (nextPath) => {
        const value = String(nextPath ?? path).trim()
        if (value === '') return
        setBusy(true)
        setError(null)
        setResult(null)
        try {
          const data = await api('image/inspect', { path: value })
          setInfo(data)
          setPath(value)
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally {
          setBusy(false)
        }
      }

      useEffect(() => {
        if (initialPath === '' || initialAppliedRef.current === initialPath) return
        initialAppliedRef.current = initialPath
        void inspect(initialPath)
        // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot seed from the generate tab
      }, [initialPath])

      const chooseFile = async (file) => {
        if (!file) return
        setBusy(true)
        setError(null)
        try {
          const dataUrl = await fileToDataUrl(file)
          const uploaded = await api('upload', { name: file.name, kind: 'image', dataUrl })
          await inspect(uploaded.path)
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally {
          setBusy(false)
        }
      }

      const optimize = async () => {
        if (!info) return
        setBusy(true)
        setError(null)
        try {
          const data = await api('image/optimize', {
            path: info.path,
            format,
            quality,
            maxWidth,
            maxHeight,
            mode,
            enhance,
            strip,
          })
          setResult(data)
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally {
          setBusy(false)
        }
      }

      const upscale = async () => {
        if (!info) return
        setUpscaleBusy(true)
        setUpscaleError(null)
        setUpscaleResult(null)
        try {
          const value = await api('image/upscale', {
            path: info.path,
            model: upscaleModel,
            scale: upscaleScale,
          })
          setUpscaleResult(value)
        } catch (failure) {
          setUpscaleError(String(failure?.message ?? failure))
        } finally {
          setUpscaleBusy(false)
        }
      }

      const source = result ?? info

      return h(
        'div',
        { className: 'cc-panel' },
        h(
          'div',
          { className: 'cc-section-head' },
          h('div', null, h('h3', null, '优化生成图'), h('p', null, '压缩、转格式、裁切与轻量增强，保留原图不动')),
          h(
            'button',
            { type: 'button', className: 'cc-btn cc-btn-ghost', onClick: () => fileRef.current?.click(), disabled: busy },
            h(Glyph, { name: 'plus', size: 14 }),
            '选图片',
          ),
        ),
        h('input', {
          ref: fileRef,
          type: 'file',
          accept: 'image/*',
          style: { display: 'none' },
          onChange: (event) => {
            void chooseFile(event.target.files?.[0])
            event.target.value = ''
          },
        }),
        h(
          'div',
          { className: 'cc-path-row' },
          h('input', {
            className: 'cc-input cc-mono',
            value: path,
            placeholder: '粘贴 DSH 生成图的路径，或点右上角选图片',
            onChange: (event) => setPath(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') void inspect()
            },
          }),
          h(
            'button',
            { type: 'button', className: 'cc-btn cc-btn-solid', onClick: () => void inspect(), disabled: busy || path.trim() === '' },
            busy ? h(Spinner) : h(Glyph, { name: 'image', size: 14 }),
            '读取',
          ),
        ),
        h(ErrorLine, { error }),
        !engine?.ok
          ? h('div', { className: 'cc-note is-warn' }, '图片引擎不可用：未找到 Pillow。请在“设置”里指定 Python，或安装 Pillow。')
          : null,
        source
          ? h(
              'div',
              { className: 'cc-image-card' },
              h('img', {
                className: 'cc-image-preview',
                src: result?.preview ?? info?.preview,
                alt: result ? '优化结果预览' : '原图预览',
              }),
              h(
                'div',
                { className: 'cc-image-meta' },
                h(
                  'div',
                  null,
                  h('b', null, result ? '优化后' : '原图'),
                  h('span', null, `${source.width ?? source.beforeWidth} × ${source.height ?? source.beforeHeight}`),
                  h('span', null, formatBytes(source.bytes ?? source.beforeBytes)),
                ),
                result
                  ? h(
                      'div',
                      { className: 'cc-image-saved' },
                      h('strong', null, `${Math.max(0, numberValue(result.savedPercent)).toFixed(1)}%`),
                      ' 更小',
                    )
                  : h('div', { className: 'cc-image-saved is-muted' }, formatBytes(info?.bytes)),
              ),
            )
          : h(
              'div',
              { className: 'cc-empty' },
              h(Glyph, { name: 'image', size: 28 }),
              h('b', null, '先读入一张图'),
              h('span', null, '支持 PNG / JPG / WebP / AVIF / GIF；优化结果写到插件输出目录。'),
            ),
        h(
          'div',
          { className: 'cc-block cc-upscale-block' },
          h(
            'div',
            { className: 'cc-block-title' },
            'AI 超分',
            h('span', null, upscaler?.ok ? 'Real-ESRGAN' : '未安装'),
          ),
          upscaler?.ok
            ? h(
                'div',
                null,
                h(
                  'div',
                  { className: 'cc-grid-2' },
                  h(
                    Field,
                    { label: '模型' },
                    h(
                      'select',
                      {
                        className: 'cc-input',
                        value: upscaleModel,
                        onChange: (event) => setUpscaleModel(event.target.value),
                      },
                      (upscaler.models ?? []).map((item) =>
                        h('option', { key: item, value: item }, UPSCALE_MODEL_LABELS[item] ?? item),
                      ),
                    ),
                  ),
                  h(
                    Field,
                    { label: '倍率' },
                    h(
                      'select',
                      {
                        className: 'cc-input',
                        value: upscaleScale,
                        onChange: (event) => setUpscaleScale(numberValue(event.target.value, 4)),
                      },
                      [2, 3, 4].map((value) => h('option', { key: value, value }, `${value}×`)),
                    ),
                  ),
                ),
                h(
                  'div',
                  { className: 'cc-action-row' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'cc-btn cc-btn-primary cc-btn-wide',
                      disabled: !info || upscaleBusy,
                      onClick: () => void upscale(),
                    },
                    upscaleBusy ? h(Spinner) : h(Glyph, { name: 'wand', size: 14 }),
                    upscaleBusy ? 'AI 放大中…（可能 1-3 分钟）' : 'AI 超分',
                  ),
                ),
                h(
                  'div',
                  { className: 'cc-tip' },
                  '本地 Real-ESRGAN ncnn：照片用 x4plus，二次元用 anime；显存不足会自动尝试 CPU。',
                ),
              )
            : h(
                'div',
                { className: 'cc-note is-warn' },
                'AI 超分引擎未安装。把 Real-ESRGAN ncnn 放到 bin/realesrgan/ 后重试。',
              ),
          upscaleError ? h(ErrorLine, { error: upscaleError }) : null,
          upscaleResult
            ? h(
                'div',
                { className: 'cc-upscale-result' },
                h('img', { src: upscaleResult.asset?.url, alt: 'AI 超分结果' }),
                h(
                  'div',
                  { className: 'cc-upscale-body' },
                  h('b', null, 'AI 超分完成'),
                  h(
                    'span',
                    null,
                    `${upscaleResult.model} · ${upscaleResult.scale}× · ${upscaleResult.width}×${upscaleResult.height}`,
                  ),
                  h('span', null, `${formatBytes(upscaleResult.beforeBytes)} → ${formatBytes(upscaleResult.bytes)}`),
                  h(
                    'div',
                    { className: 'cc-result-actions' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'cc-btn cc-btn-solid',
                        onClick: () => void inspect(upscaleResult.path),
                      },
                      '继续优化',
                    ),
                    h(CopyButton, { text: upscaleResult.path, label: '复制' }),
                    h(
                      'a',
                      { className: 'cc-icon-btn', href: upscaleResult.asset?.downloadUrl, target: '_blank', rel: 'noreferrer', title: '下载' },
                      h(Glyph, { name: 'download', size: 13 }),
                    ),
                  ),
                ),
              )
            : null,
        ),
        h(
          'div',
          { className: 'cc-block' },
          h('div', { className: 'cc-block-title' }, '预设'),
          h(
            'div',
            { className: 'cc-chip-row' },
            Object.entries(IMAGE_PRESETS).map(([id, preset]) =>
              h(
                'button',
                {
                  key: id,
                  type: 'button',
                  className: `cc-chip cc-chip-tall${presetId === id ? ' is-active' : ''}`,
                  onClick: () => applyPreset(id),
                },
                h('b', null, preset.label),
                h('span', null, preset.desc),
              ),
            ),
          ),
        ),
        h(
          'div',
          { className: 'cc-grid-2' },
          h(
            Field,
            { label: '格式' },
            h(
              'select',
              {
                className: 'cc-input',
                value: format,
                onChange: (event) => {
                  setFormat(event.target.value)
                  setPresetId('custom')
                },
              },
              h('option', { value: 'webp' }, 'WebP（推荐）'),
              h('option', { value: 'jpeg' }, 'JPEG'),
              h('option', { value: 'png' }, 'PNG'),
              h('option', { value: 'avif' }, 'AVIF（较慢）'),
            ),
          ),
          h(
            Field,
            { label: '缩放方式' },
            h(
              'select',
              {
                className: 'cc-input',
                value: mode,
                onChange: (event) => {
                  setMode(event.target.value)
                  setPresetId('custom')
                },
              },
              h('option', { value: 'fit' }, '完整保留 · 等比缩放'),
              h('option', { value: 'crop' }, '居中裁切 · 填满画布'),
            ),
          ),
          h(
            Field,
            { label: '最大宽度', hint: 'px' },
            h('input', {
              className: 'cc-input',
              type: 'number',
              min: 16,
              max: 16384,
              value: maxWidth,
              onChange: (event) => {
                setMaxWidth(numberValue(event.target.value, 1920))
                setPresetId('custom')
              },
            }),
          ),
          h(
            Field,
            { label: '最大高度', hint: 'px' },
            h('input', {
              className: 'cc-input',
              type: 'number',
              min: 16,
              max: 16384,
              value: maxHeight,
              onChange: (event) => {
                setMaxHeight(numberValue(event.target.value, 1920))
                setPresetId('custom')
              },
            }),
          ),
        ),
        h(
          'div',
          { className: 'cc-slider-row' },
          h('span', null, '质量'),
          h('input', {
            type: 'range',
            min: 40,
            max: 100,
            value: quality,
            onChange: (event) => {
              setQuality(numberValue(event.target.value, 82))
              setPresetId('custom')
            },
          }),
          h('b', null, quality),
        ),
        h(
          'div',
          { className: 'cc-toggle-row' },
          h(
            'label',
            { className: 'cc-switch' },
            h('input', { type: 'checkbox', checked: enhance, onChange: (event) => setEnhance(event.target.checked) }),
            h('span'),
            '轻量增强（自动对比 + 锐化）',
          ),
          h(
            'label',
            { className: 'cc-switch' },
            h('input', { type: 'checkbox', checked: strip, onChange: (event) => setStrip(event.target.checked) }),
            h('span'),
            '清除元数据',
          ),
        ),
        h(
          'div',
          { className: 'cc-action-row' },
          h(
            'button',
            {
              type: 'button',
              className: 'cc-btn cc-btn-primary cc-btn-wide',
              disabled: !info || busy,
              onClick: () => void optimize(),
            },
            busy ? h(Spinner) : h(Glyph, { name: 'wand', size: 15 }),
            busy ? '处理中…' : '开始优化',
          ),
        ),
        result
          ? h(
              'div',
              { className: 'cc-result' },
              h(
                'div',
                { className: 'cc-result-head' },
                h(Glyph, { name: 'sparkles', size: 15 }),
                h('b', null, '已生成'),
                h('span', null, result.name),
              ),
              h('div', { className: 'cc-result-path', title: result.path }, shortPath(result.path)),
              h(
                'div',
                { className: 'cc-result-actions' },
                h(CopyButton, { text: result.path }),
                h(
                  'a',
                  { className: 'cc-btn cc-btn-ghost', href: result.asset?.downloadUrl ?? '#', target: '_blank', rel: 'noreferrer' },
                  h(Glyph, { name: 'download', size: 13 }),
                  '下载',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'cc-btn cc-btn-ghost',
                    onClick: () => {
                      setResult(null)
                      void inspect(result.path)
                    },
                  },
                  '继续处理',
                ),
              ),
            )
          : null,
      )
    }

    // ------------------------------------------------------------------ video

    function VideoPanel({ status, sharedAudio, setSharedAudio, onOptimizeImage, onSettings }) {
      const [path, setPath] = useState('')
      const [info, setInfo] = useState(null)
      const [clips, setClips] = useState([])
      const [clipHistory, setClipHistory] = useState([])
      const [transcript, setTranscript] = useState('')
      const [asrBusy, setAsrBusy] = useState(false)
      const [asrError, setAsrError] = useState(null)
      const [start, setStart] = useState(0)
      const [end, setEnd] = useState(10)
      const [description, setDescription] = useState('')
      const [targetSeconds, setTargetSeconds] = useState(30)
      const [planBusy, setPlanBusy] = useState(false)
      const [plan, setPlan] = useState(null)
      const [planError, setPlanError] = useState(null)
      const [resolution, setResolution] = useState('1080p')
      const [fps, setFps] = useState(30)
      const [crf, setCrf] = useState(22)
      const [mute, setMute] = useState(false)
      const [audioMode, setAudioMode] = useState('replace')
      const [useSubtitles, setUseSubtitles] = useState(true)
      const [cover, setCover] = useState(null)
      const [coverBusy, setCoverBusy] = useState(false)
      const [coverError, setCoverError] = useState(null)
      const [srtPath, setSrtPath] = useState('')
      const [subtitleInfo, setSubtitleInfo] = useState(null)
      const [subtitleVoice, setSubtitleVoice] = useState('zh-CN-XiaoxiaoNeural')
      const [subtitleBusy, setSubtitleBusy] = useState(false)
      const [subtitleResult, setSubtitleResult] = useState(null)
      const [subtitleError, setSubtitleError] = useState(null)
      const [job, setJob] = useState(null)
      const [premiere, setPremiere] = useState(null)
      const [premiereBusy, setPremiereBusy] = useState(false)
      const [premiereError, setPremiereError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [name, setName] = useState('edit')
      const fileRef = useRef(null)

      const engine = status?.engines?.video
      const llm = status?.llm
      const asr = status?.asr
      const llmReady = llm?.canUse ?? llm?.hasKey
      const duration = numberValue(info?.duration)
      const jobRunning = job?.status === 'running'

      const inspect = async (nextPath) => {
        const value = String(nextPath ?? path).trim()
        if (value === '') return
        setBusy(true)
        setError(null)
        setJob(null)
        try {
          const data = await api('video/inspect', { path: value })
          setInfo(data)
          setPath(value)
          setClips([])
        setClipHistory([])
          setStart(0)
          setEnd(Math.min(numberValue(data.duration, 10) || 10, 30))
          setName(String(data.asset?.name ?? 'edit').replace(/\.[^.]+$/, '') || 'edit')
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally {
          setBusy(false)
        }
      }

      const chooseFile = async (file) => {
        if (!file) return
        if (file.size > 80 * 1024 * 1024) {
          setError('浏览器上传单文件上限约 80MB；更大的视频请直接填路径')
          return
        }
        setBusy(true)
        setError(null)
        try {
          const dataUrl = await fileToDataUrl(file)
          const uploaded = await api('upload', { name: file.name, kind: 'video', dataUrl })
          await inspect(uploaded.path)
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally {
          setBusy(false)
        }
      }

      const commitClips = (next) => {
        setClipHistory((history) => [...history.slice(-9), clips])
        setClips(next)
      }

      const undoClips = () => {
        if (clipHistory.length === 0) return
        const previous = clipHistory[clipHistory.length - 1]
        setClipHistory((history) => history.slice(0, -1))
        setClips(previous)
      }

      const addClip = (whole = false) => {
        if (!info) return
        const total = numberValue(info.duration)
        let from = whole ? 0 : clamp(numberValue(start), 0, Math.max(0, total - 0.05))
        let to = whole ? total : clamp(numberValue(end), from + 0.05, total)
        if (!(to > from)) {
          setError('出点必须大于入点')
          return
        }
        setError(null)
        commitClips([
          ...clips,
          { path: info.asset?.path ?? path, start: round(from), end: round(to), label: info.asset?.name ?? path },
        ])
      }

      const captureCover = async () => {
        if (!info) return
        setCoverBusy(true)
        setCoverError(null)
        setCover(null)
        try {
          const value = await api('video/frame', {
            path: info.asset?.path ?? path,
            time: clamp(numberValue(start), 0, Math.max(0, numberValue(info.duration) - 0.05)),
          })
          setCover(value)
        } catch (failure) {
          setCoverError(String(failure?.message ?? failure))
        } finally {
          setCoverBusy(false)
        }
      }

      const loadSubtitle = async () => {
        if (srtPath.trim() === '') return
        setSubtitleBusy(true)
        setSubtitleError(null)
        setSubtitleInfo(null)
        try {
          const value = await api('subtitle/inspect', { path: srtPath.trim() })
          setSubtitleInfo(value)
        } catch (failure) {
          setSubtitleError(String(failure?.message ?? failure))
        } finally {
          setSubtitleBusy(false)
        }
      }

      const applySubtitle = async (mode) => {
        if (!info) {
          setSubtitleError('先读入一个视频')
          return
        }
        if (srtPath.trim() === '') {
          setSubtitleError('先填 SRT 字幕路径')
          return
        }
        setSubtitleBusy(true)
        setSubtitleError(null)
        setSubtitleResult(null)
        try {
          const value = await api('subtitle/apply', {
            videoPath: info.asset?.path ?? path,
            srtPath: srtPath.trim(),
            mode,
            voice: subtitleVoice,
            name: `${name}-${mode === 'voiceover' ? 'voiced' : 'subbed'}`,
          })
          setSubtitleResult(value)
        } catch (failure) {
          setSubtitleError(String(failure?.message ?? failure))
        } finally {
          setSubtitleBusy(false)
        }
      }

      const removeClip = (index) => commitClips(clips.filter((_, i) => i !== index))
      const moveClip = (index, delta) => {
        const target = index + delta
        if (target < 0 || target >= clips.length) return
        const next = [...clips]
        const [row] = next.splice(index, 1)
        next.splice(target, 0, row)
        commitClips(next)
      }

      const analyzeDescription = async () => {
        if (!info) {
          setPlanError('先读入一个视频')
          return
        }
        if (description.trim().length < 4) {
          setPlanError('用一句话描述你想要的画面或节奏')
          return
        }
        setPlanBusy(true)
        setPlanError(null)
        setPlan(null)
        try {
          const value = await api('video/plan', {
            path: info.asset?.path ?? path,
            prompt: description.trim(),
            transcript: transcript.trim(),
            targetSeconds: numberValue(targetSeconds),
          })
          setPlan(value)
        } catch (failure) {
          setPlanError(String(failure?.message ?? failure))
        } finally {
          setPlanBusy(false)
        }
      }

      const transcribe = async () => {
        if (!info) {
          setAsrError('先读入一个视频')
          return
        }
        setAsrBusy(true)
        setAsrError(null)
        try {
          const value = await api('video/transcribe', { path: info.asset?.path ?? path })
          setTranscript(value.text || '')
        } catch (failure) {
          setAsrError(String(failure?.message ?? failure))
        } finally {
          setAsrBusy(false)
        }
      }

      const exportVideo = async (nextClips = clips, nextName = name) => {
        if (nextClips.length === 0) {
          setError('先把至少一个片段加入时间线')
          return
        }
        setBusy(true)
        setError(null)
        setJob(null)
        try {
          const value = await api('video/export', {
            clips: nextClips,
            name: nextName,
            resolution,
            fps,
            crf,
            mute,
            audioMode: mute || !sharedAudio ? 'none' : audioMode,
            audioPath: sharedAudio?.path,
            subtitlePath: !mute && useSubtitles ? sharedAudio?.subtitle?.path : undefined,
          })
          setJob({ id: value.jobId, status: 'running', progress: 0, message: '已排队…' })
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally {
          setBusy(false)
        }
      }

      const updatePlanTime = (index, field, value) => {
        if (!plan) return
        const time = Math.max(0, numberValue(value))
        const segments = plan.segments.map((segment, i) =>
          i === index ? { ...segment, [field]: round(time) } : segment,
        )
        setPlan({
          ...plan,
          segments,
          total: round(segments.reduce((sum, item) => sum + Math.max(0, item.end - item.start), 0)),
        })
      }

      const removePlanSegment = (index) => {
        if (!plan) return
        const segments = plan.segments.filter((_, i) => i !== index)
        setPlan({
          ...plan,
          segments,
          total: round(segments.reduce((sum, item) => sum + item.end - item.start, 0)),
        })
      }

      const applyPlan = (exportNow = false) => {
        if (!plan || !info) return
        const valid = plan.segments.filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start + 0.2)
        if (valid.length === 0) {
          setPlanError('方案里没有有效片段：出点必须大于入点')
          return
        }
        const next = valid.map((segment, index) => ({
          path: info.asset?.path ?? path,
          start: round(segment.start),
          end: round(segment.end),
          label: `AI 片段 ${index + 1}`,
        }))
        setClips(next)
        setClipHistory((history) => [...history.slice(-9), clips])
        setStart(next[0]?.start ?? 0)
        setEnd(next[0]?.end ?? duration)
        setError(null)
        if (exportNow) void exportVideo(next, `${name}-ai`)
      }

      const exportPremiere = async () => {
        if (clips.length === 0) {
          setPremiereError('先把至少一个片段加入时间线')
          return
        }
        setPremiereBusy(true)
        setPremiereError(null)
        setPremiere(null)
        try {
          const value = await api('video/premiere', {
            clips,
            name,
            resolution,
            fps,
            mute,
            audioMode: mute || !sharedAudio ? 'none' : audioMode,
            audioPath: sharedAudio?.path,
          })
          setPremiere(value)
        } catch (failure) {
          setPremiereError(String(failure?.message ?? failure))
        } finally {
          setPremiereBusy(false)
        }
      }

      useEffect(() => {
        if (!job?.id || job.status !== 'running') return undefined
        let cancelled = false
        const timer = window.setInterval(async () => {
          try {
            const next = await api('job/status', { jobId: job.id })
            if (cancelled) return
            setJob(next)
          } catch (failure) {
            if (!cancelled) setError(String(failure?.message ?? failure))
          }
        }, 900)
        return () => {
          cancelled = true
          window.clearInterval(timer)
        }
      }, [job?.id, job?.status])

      const total = clips.reduce((sum, clip) => sum + Math.max(0, clip.end - clip.start), 0)

      return h(
        'div',
        { className: 'cc-panel' },
        h(
          'div',
          { className: 'cc-section-head' },
          h('div', null, h('h3', null, '剪辑视频'), h('p', null, '截取多段、统一画幅、导出 MP4；可叠 TTS 配音')),
          h(
            'button',
            { type: 'button', className: 'cc-btn cc-btn-ghost', onClick: () => fileRef.current?.click(), disabled: busy },
            h(Glyph, { name: 'plus', size: 14 }),
            '选视频',
          ),
        ),
        h('input', {
          ref: fileRef,
          type: 'file',
          accept: 'video/*',
          style: { display: 'none' },
          onChange: (event) => {
            void chooseFile(event.target.files?.[0])
            event.target.value = ''
          },
        }),
        h(
          'div',
          { className: 'cc-path-row' },
          h('input', {
            className: 'cc-input cc-mono',
            value: path,
            placeholder: '粘贴视频路径，例如 D:\\...\\clip.mp4',
            onChange: (event) => setPath(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') void inspect()
            },
          }),
          h(
            'button',
            { type: 'button', className: 'cc-btn cc-btn-solid', onClick: () => void inspect(), disabled: busy || path.trim() === '' },
            busy ? h(Spinner) : h(Glyph, { name: 'film', size: 14 }),
            '读取',
          ),
        ),
        h(ErrorLine, { error }),
        !engine?.ok
          ? h('div', { className: 'cc-note is-warn' }, 'FFmpeg 不可用。请在“设置”里指定 ffmpeg.exe，或把 ffmpeg 放进 PATH。')
          : null,
        info
          ? h(
              'div',
              { className: 'cc-video-card' },
              info.preview
                ? h('img', { className: 'cc-video-preview', src: info.preview, alt: '视频预览' })
                : h('div', { className: 'cc-video-preview is-empty' }, h(Glyph, { name: 'film', size: 28 })),
              h(
                'div',
                { className: 'cc-video-meta' },
                h('b', { title: info.asset?.name }, info.asset?.name ?? 'video'),
                h(
                  'span',
                  null,
                  `${info.width}×${info.height}`,
                  ' · ',
                  formatDuration(info.duration),
                  ' · ',
                  `${numberValue(info.fps).toFixed(0)} fps`,
                  info.hasAudio ? ' · 有音频' : ' · 无音频',
                ),
              ),
            )
          : h(
              'div',
              { className: 'cc-empty' },
              h(Glyph, { name: 'film', size: 28 }),
              h('b', null, '先读入一段视频'),
              h('span', null, '支持 MP4 / MOV / WebM / MKV；时间线按片段顺序拼接。'),
            ),
        h(
          'div',
          { className: 'cc-block cc-ai-cut' },
          h(
            'div',
            { className: 'cc-block-title' },
            '按描述剪',
            h('span', null, llmReady ? (llm?.hasKey ? '视觉模型' : '本地 API') : '需配置 API'),
          ),
          h(
            'div',
            { className: 'cc-ai-cut-copy' },
            info
              ? '用一句话说清想要什么：保留哪些画面、去掉什么、节奏和总时长。系统会抽帧理解，再把片段回填时间线。'
              : '先读入上方视频，再描述想要保留/去掉的画面；未读入时这里也可先写好描述。',
          ),
              h('textarea', {
                className: 'cc-textarea',
                rows: 3,
                maxLength: 500,
                value: description,
                placeholder: '例如：保留人物说话和产品特写，去掉开头空镜，节奏快一点，总长约 30 秒',
                onChange: (event) => setDescription(event.target.value),
              }),
              h(
                'details',
                { className: 'cc-ai-transcript' },
                h('summary', null, '有台词 / SRT？粘贴进来，按台词选段更准'),
                h('textarea', {
                  className: 'cc-textarea cc-mono',
                  rows: 4,
                  maxLength: 8000,
                  value: transcript,
                  placeholder: '例如：\n00:02 这款产品主打轻量\n00:08 价格是 199 元\n00:14 现在下单送配件',
                  onChange: (event) => setTranscript(event.target.value),
                }),
                h(
                  'div',
                  { className: 'cc-transcribe-row' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'cc-btn cc-btn-ghost',
                      disabled: asrBusy || !info || !asr?.canUse,
                      onClick: () => void transcribe(),
                    },
                    asrBusy ? h(Spinner) : h(Glyph, { name: 'mic', size: 12 }),
                    asrBusy ? '转写中…' : '自动转写',
                  ),
                  h('span', null, asr?.canUse ? '使用 ASR API 自动填台词' : '未配置 ASR API，可手动粘贴 SRT'),
                ),
                asrError ? h(ErrorLine, { error: asrError }) : null,
              ),
              h(
                'div',
                { className: 'cc-ai-cut-options' },
                h(
                  Field,
                  { label: '目标时长' },
                  h(
                    'select',
                    {
                      className: 'cc-input',
                      value: targetSeconds,
                      onChange: (event) => setTargetSeconds(numberValue(event.target.value)),
                    },
                    h('option', { value: 15 }, '15 秒'),
                    h('option', { value: 30 }, '30 秒'),
                    h('option', { value: 45 }, '45 秒'),
                    h('option', { value: 60 }, '60 秒'),
                    h('option', { value: 0 }, '按描述自然长度'),
                  ),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'cc-btn cc-btn-primary cc-btn-wide',
                    disabled: planBusy || !info || description.trim().length < 4 || !llmReady,
                    onClick: () => void analyzeDescription(),
                  },
                  planBusy ? h(Spinner) : h(Glyph, { name: 'sparkles', size: 14 }),
                  planBusy ? '抽帧分析中…' : '分析并生成剪辑',
                ),
              ),
              !llmReady
                ? h(
                    'div',
                    { className: 'cc-note is-warn cc-ai-cut-config' },
                    '需要语言剪辑 API。到「设置 → 语言剪辑 API」填 Base URL、模型和 Key；模型需支持图片输入。',
                    onSettings
                      ? h(
                          'button',
                          { type: 'button', className: 'cc-btn cc-btn-ghost', onClick: onSettings },
                          '去设置',
                        )
                      : null,
                  )
                : null,
              planError ? h(ErrorLine, { error: planError }) : null,
              plan
                ? h(
                    'div',
                    { className: 'cc-plan' },
                    h(
                      'div',
                      { className: 'cc-plan-head' },
                      h('b', null, plan.summary || '剪辑方案'),
                      h('span', null, `${Math.round(plan.total)} 秒 · ${plan.segments.length} 段 · ${plan.frames} 帧`),
                    ),
                    h(
                      'div',
                      { className: 'cc-plan-segments' },
                      plan.segments.map((segment, index) =>
                        h(
                          'div',
                          { className: 'cc-plan-segment', key: `${segment.start}-${segment.end}-${index}` },
                          h('b', null, `${index + 1}`),
                          h(
                            'div',
                            { className: 'cc-plan-time' },
                            h('input', {
                              className: 'cc-input',
                              type: 'number',
                              min: 0,
                              step: 0.1,
                              value: segment.start,
                              onChange: (event) => updatePlanTime(index, 'start', event.target.value),
                            }),
                            h('span', null, '–'),
                            h('input', {
                              className: 'cc-input',
                              type: 'number',
                              min: 0,
                              step: 0.1,
                              value: segment.end,
                              onChange: (event) => updatePlanTime(index, 'end', event.target.value),
                            }),
                          ),
                          h('em', null, segment.reason || '匹配描述'),
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'cc-plan-remove',
                              title: '移除此段',
                              onClick: () => removePlanSegment(index),
                            },
                            '×',
                          ),
                        ),
                      ),
                    ),
                    h(
                      'div',
                      { className: 'cc-action-row cc-plan-actions' },
                      h(
                        'button',
                        { type: 'button', className: 'cc-btn cc-btn-primary', onClick: () => applyPlan(true) },
                        h(Glyph, { name: 'film', size: 13 }),
                        '应用并导出',
                      ),
                      h(
                        'button',
                        { type: 'button', className: 'cc-btn cc-btn-ghost', onClick: () => applyPlan(false) },
                        '仅应用',
                      ),
                    ),
                  )
                : null,
        ),
        info
          ? h(
              'div',
              { className: 'cc-block' },
              h(
                'div',
                { className: 'cc-block-title cc-block-title-actions' },
                h('span', null, '截取片段'),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'cc-btn cc-btn-ghost cc-undo',
                    disabled: clipHistory.length === 0,
                    onClick: undoClips,
                    title: '撤销上一次片段改动',
                  },
                  '撤销上一步',
                ),
              ),
              h(
                'div',
                { className: 'cc-clip-editor' },
                h(
                  Field,
                  { label: '入点', hint: '秒' },
                  h('input', {
                    className: 'cc-input',
                    type: 'number',
                    min: 0,
                    max: Math.max(0, duration),
                    step: 0.1,
                    value: start,
                    onChange: (event) => setStart(numberValue(event.target.value)),
                  }),
                ),
                h(
                  Field,
                  { label: '出点', hint: '秒' },
                  h('input', {
                    className: 'cc-input',
                    type: 'number',
                    min: 0,
                    max: Math.max(0, duration),
                    step: 0.1,
                    value: end,
                    onChange: (event) => setEnd(numberValue(event.target.value)),
                  }),
                ),
                h(
                  'button',
                  { type: 'button', className: 'cc-btn cc-btn-solid cc-clip-add', onClick: () => addClip(false) },
                  h(Glyph, { name: 'plus', size: 14 }),
                  '加入',
                ),
              ),
              h(
                'div',
                { className: 'cc-inline-actions' },
                h('span', null, `原片时长 ${formatDuration(info.duration)}`),
                h(
                  'div',
                  { className: 'cc-inline-actions' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'cc-btn cc-btn-ghost',
                      disabled: coverBusy,
                      title: '用当前入点截取一帧，可送去图片优化',
                      onClick: () => void captureCover(),
                    },
                    coverBusy ? h(Spinner) : h(Glyph, { name: 'image', size: 12 }),
                    '截封面',
                  ),
                  h(
                    'button',
                    { type: 'button', className: 'cc-btn cc-btn-ghost', onClick: () => addClip(true) },
                    '整段加入',
                  ),
                ),
              ),
            )
          : null,
        coverError ? h(ErrorLine, { error: coverError }) : null,
        cover
          ? h(
              'div',
              { className: 'cc-cover-result' },
              h('img', { src: cover.asset?.url, alt: '视频封面' }),
              h(
                'div',
                { className: 'cc-cover-body' },
                h('b', null, '封面已截取'),
                h('span', null, `${cover.width}×${cover.height} · ${formatDuration(cover.time)}`),
                h(
                  'div',
                  { className: 'cc-result-actions' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'cc-btn cc-btn-solid',
                      onClick: () => onOptimizeImage(cover.asset?.path),
                    },
                    h(Glyph, { name: 'wand', size: 12 }),
                    '优化封面',
                  ),
                  h(CopyButton, { text: cover.asset?.path, label: '复制' }),
                ),
              ),
            )
          : null,
        h(
          'div',
          { className: 'cc-block' },
          h(
            'div',
            { className: 'cc-block-title' },
            '时间线',
            h('span', null, `${clips.length} 段 · ${formatDuration(total)}`),
          ),
          clips.length === 0
            ? h('div', { className: 'cc-timeline-empty' }, '还没有片段。读入视频后截取，或“整段加入”。')
            : h(
                'div',
                { className: 'cc-clip-list' },
                clips.map((clip, index) =>
                  h(
                    'div',
                    { key: `${clip.path}-${index}`, className: 'cc-clip' },
                    h('span', { className: 'cc-clip-index' }, index + 1),
                    h(
                      'div',
                      { className: 'cc-clip-body' },
                      h('b', { title: clip.label }, clip.label),
                      h('span', null, `${formatDuration(clip.start)} → ${formatDuration(clip.end)} · ${formatDuration(clip.end - clip.start)}`),
                    ),
                    h(
                      'button',
                      { type: 'button', className: 'cc-icon-btn', title: '上移', onClick: () => moveClip(index, -1), disabled: index === 0 },
                      h(Glyph, { name: 'arrowUp', size: 13 }),
                    ),
                    h(
                      'button',
                      { type: 'button', className: 'cc-icon-btn', title: '下移', onClick: () => moveClip(index, 1), disabled: index === clips.length - 1 },
                      h(Glyph, { name: 'arrowDown', size: 13 }),
                    ),
                    h(
                      'button',
                      { type: 'button', className: 'cc-icon-btn is-danger', title: '删除', onClick: () => removeClip(index) },
                      h(Glyph, { name: 'trash', size: 13 }),
                    ),
                  ),
                ),
              ),
        ),
        h(
          'div',
          { className: 'cc-block cc-subtitle-block' },
          h(
            'div',
            { className: 'cc-block-title' },
            '字幕 · 一键处理',
            h('span', null, subtitleInfo ? `${subtitleInfo.cues} 条 · ${formatDuration(subtitleInfo.duration)}` : 'SRT'),
          ),
          h(
            'div',
            { className: 'cc-path-row' },
            h('input', {
              className: 'cc-input cc-mono',
              value: srtPath,
              placeholder: '粘贴 .srt 路径，或用声线页生成的字幕',
              onChange: (event) => {
                setSrtPath(event.target.value)
                setSubtitleInfo(null)
              },
            }),
            h(
              'button',
              {
                type: 'button',
                className: 'cc-btn cc-btn-solid',
                disabled: subtitleBusy || srtPath.trim() === '',
                onClick: () => void loadSubtitle(),
              },
              subtitleBusy ? h(Spinner) : null,
              '读取',
            ),
          ),
          sharedAudio?.subtitle
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'cc-inline-link',
                  onClick: () => {
                    setSrtPath(sharedAudio.subtitle.path)
                    setSubtitleInfo(null)
                  },
                },
                '使用刚生成的 TTS 字幕',
              )
            : null,
          h(
            'div',
            { className: 'cc-grid-2' },
            h(
              Field,
              { label: '字幕配音声线' },
              h(
                'select',
                {
                  className: 'cc-input',
                  value: subtitleVoice,
                  onChange: (event) => setSubtitleVoice(event.target.value),
                },
                (status?.voices ?? []).map((item) => h('option', { key: item.id, value: item.id }, item.name)),
              ),
            ),
            h(
              Field,
              { label: '处理范围', hint: '当前读入视频整片' },
              h('input', { className: 'cc-input', value: info?.asset?.name ?? '未读入视频', disabled: true }),
            ),
          ),
          h(
            'div',
            { className: 'cc-action-row' },
            h(
              'button',
              {
                type: 'button',
                className: 'cc-btn cc-btn-solid cc-btn-wide',
                disabled: !info || subtitleBusy || srtPath.trim() === '',
                onClick: () => void applySubtitle('soft'),
              },
              h(Glyph, { name: 'copy', size: 13 }),
              '一键加字幕',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'cc-btn cc-btn-primary cc-btn-wide',
                disabled: !info || subtitleBusy || srtPath.trim() === '',
                onClick: () => void applySubtitle('voiceover'),
              },
              subtitleBusy ? h(Spinner) : h(Glyph, { name: 'mic', size: 13 }),
              '一键字幕配音',
            ),
          ),
          h(
            'div',
            { className: 'cc-tip' },
            '“一键加字幕”保留原声、封装软字幕；“一键字幕配音”逐句合成并按 SRT 时间对齐，最多 30 条。自动语音识别需另启用 DSH 语音输入。',
          ),
          subtitleError ? h(ErrorLine, { error: subtitleError }) : null,
          subtitleResult
            ? h(
                'div',
                { className: 'cc-subtitle-result' },
                h('video', { className: 'cc-video-result', src: subtitleResult.asset?.url, controls: true, preload: 'metadata' }),
                h(
                  'div',
                  { className: 'cc-result-path', title: subtitleResult.asset?.path },
                  shortPath(subtitleResult.asset?.path),
                ),
                h(
                  'div',
                  { className: 'cc-result-actions' },
                  h(CopyButton, { text: subtitleResult.asset?.path }),
                  h(
                    'a',
                    { className: 'cc-btn cc-btn-ghost', href: subtitleResult.asset?.downloadUrl, target: '_blank', rel: 'noreferrer' },
                    h(Glyph, { name: 'download', size: 13 }),
                    '下载',
                  ),
                ),
              )
            : null,
        ),
        h(
          'div',
          { className: 'cc-block' },
          h('div', { className: 'cc-block-title' }, '输出'),
          h(
            'div',
            { className: 'cc-grid-2' },
            h(
              Field,
              { label: '画幅' },
              h(
                'select',
                { className: 'cc-input', value: resolution, onChange: (event) => setResolution(event.target.value) },
                RESOLUTIONS.map((item) => h('option', { key: item.id, value: item.id }, `${item.label} · ${item.hint}`)),
              ),
            ),
            h(
              Field,
              { label: '帧率' },
              h(
                'select',
                { className: 'cc-input', value: fps, onChange: (event) => setFps(numberValue(event.target.value, 30)) },
                [24, 25, 30, 60].map((value) => h('option', { key: value, value }, `${value} fps`)),
              ),
            ),
            h(
              Field,
              { label: '文件名', hint: '不含扩展名' },
              h('input', {
                className: 'cc-input',
                value: name,
                maxLength: 48,
                onChange: (event) => setName(event.target.value),
              }),
            ),
            h(
              Field,
              { label: '画质', hint: 'CRF 越小越清晰' },
              h(
                'select',
                { className: 'cc-input', value: crf, onChange: (event) => setCrf(numberValue(event.target.value, 22)) },
                h('option', { value: 18 }, '高 · CRF 18'),
                h('option', { value: 22 }, '均衡 · CRF 22'),
                h('option', { value: 26 }, '轻量 · CRF 26'),
                h('option', { value: 30 }, '最小 · CRF 30'),
              ),
            ),
          ),
          h(
            'div',
            { className: 'cc-toggle-row' },
            h(
              'label',
              { className: 'cc-switch' },
              h('input', { type: 'checkbox', checked: mute, onChange: (event) => setMute(event.target.checked) }),
              h('span'),
              '静音导出',
            ),
          ),
        ),
        sharedAudio
          ? h(
              'div',
              { className: 'cc-audio-attach' },
              h(Glyph, { name: 'mic', size: 15 }),
              h(
                'div',
                { className: 'cc-audio-attach-body' },
                h('b', null, '已接入 TTS 配音'),
                h('span', { title: sharedAudio.path }, `${sharedAudio.name} · ${formatDuration(sharedAudio.duration)}`),
              ),
              h(
                'select',
                { className: 'cc-input', value: audioMode, onChange: (event) => setAudioMode(event.target.value), disabled: mute },
                h('option', { value: 'replace' }, '替换原声'),
                h('option', { value: 'mix' }, '混合原声'),
              ),
              h(
                'button',
                { type: 'button', className: 'cc-icon-btn', title: '移除配音', onClick: () => setSharedAudio(null) },
                h(Glyph, { name: 'close', size: 13 }),
              ),
            )
          : h('div', { className: 'cc-note' }, '想加配音？去“声线”页合成后点“送去视频”，会出现在这里。'),
        sharedAudio?.subtitle
          ? h(
              'div',
              { className: 'cc-subtitle-row' },
              h(
                'label',
                { className: 'cc-switch' },
                h('input', {
                  type: 'checkbox',
                  checked: useSubtitles,
                  onChange: (event) => setUseSubtitles(event.target.checked),
                  disabled: mute,
                }),
                h('span'),
                '封装软字幕（mov_text）',
              ),
              h(
                'a',
                {
                  className: 'cc-btn cc-btn-ghost',
                  href: sharedAudio.subtitle.downloadUrl,
                  target: '_blank',
                  rel: 'noreferrer',
                  title: sharedAudio.subtitle.path,
                },
                h(Glyph, { name: 'download', size: 12 }),
                'SRT',
              ),
            )
          : null,
        h(
          'div',
          { className: 'cc-action-row' },
          h(
            'button',
            {
              type: 'button',
              className: 'cc-btn cc-btn-primary cc-btn-wide',
              disabled: busy || jobRunning || clips.length === 0 || !engine?.ok,
              onClick: () => void exportVideo(),
            },
            jobRunning ? h(Spinner) : h(Glyph, { name: 'film', size: 15 }),
            jobRunning ? `渲染中 ${job?.progress ?? 0}%` : '导出视频',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'cc-btn cc-btn-solid',
              disabled: premiereBusy || clips.length === 0 || !engine?.ok,
              title: '只生成 FCP XML，不连接或修改 Premiere',
              onClick: () => void exportPremiere(),
            },
            premiereBusy ? h(Spinner) : h(Glyph, { name: 'download', size: 13 }),
            'PR 时间线',
          ),
        ),
        h(
          'div',
          { className: 'cc-note' },
          '“PR 时间线”只导出 Premiere 可导入的 FCP XML，不会连接、读取或修改你正在使用的 Premiere；导入由你手动完成。',
        ),
        premiereError ? h(ErrorLine, { error: premiereError }) : null,
        premiere
          ? h(
              'div',
              { className: 'cc-premiere-result' },
              h(
                'div',
                { className: 'cc-result-head' },
                h(Glyph, { name: 'film', size: 14 }),
                h('b', null, 'PR 时间线已生成'),
                h('span', null, `${premiere.clips} 段 · ${premiere.width}×${premiere.height} · ${formatDuration(premiere.duration)}`),
              ),
              h('div', { className: 'cc-result-path', title: premiere.path }, shortPath(premiere.path)),
              h(
                'div',
                { className: 'cc-result-actions' },
                h(CopyButton, { text: premiere.path }),
                h(
                  'a',
                  { className: 'cc-btn cc-btn-ghost', href: premiere.asset?.downloadUrl, target: '_blank', rel: 'noreferrer' },
                  h(Glyph, { name: 'download', size: 13 }),
                  '下载 XML',
                ),
              ),
              h('div', { className: 'cc-tip' }, 'Premiere：文件 → 导入 → 选择这个 .xml。未连接 PR，当前工程未被改动。'),
            )
          : null,
        job
          ? h(
              'div',
              { className: `cc-job is-${job.status}` },
              h(
                'div',
                { className: 'cc-job-head' },
                h('b', null, job.status === 'done' ? '导出完成' : job.status === 'error' ? '导出失败' : job.message),
                h('span', null, job.status === 'done' ? formatDuration(job.asset?.duration) : `${job.progress ?? 0}%`),
              ),
              h('div', { className: 'cc-progress' }, h('i', { style: { width: `${job.status === 'done' ? 100 : job.progress ?? 0}%` } })),
              job.error ? h(ErrorLine, { error: job.error }) : null,
              job.status === 'done' && job.asset
                ? h(
                    'div',
                    { className: 'cc-job-result' },
                    h('video', { className: 'cc-video-result', src: job.asset.url, controls: true, preload: 'metadata' }),
                    h('div', { className: 'cc-result-path', title: job.asset.path }, shortPath(job.asset.path)),
                    h(
                      'div',
                      { className: 'cc-result-actions' },
                      h(CopyButton, { text: job.asset.path }),
                      h(
                        'a',
                        { className: 'cc-btn cc-btn-ghost', href: job.asset.downloadUrl, target: '_blank', rel: 'noreferrer' },
                        h(Glyph, { name: 'download', size: 13 }),
                        '下载',
                      ),
                    ),
                  )
                : null,
            )
          : null,
      )
    }

    // ------------------------------------------------------------------ voice

    function VoicePanel({ status, setSharedAudio, reload }) {
      const [text, setText] = useState('欢迎来到 MuRaSame 创作助手。\n图片、视频和声音，现在都在同一个地方。')
      const [voice, setVoice] = useState('zh-CN-XiaoxiaoNeural')
      const [preset, setPreset] = useState('natural')
      const [rate, setRate] = useState(0)
      const [pitch, setPitch] = useState(0)
      const [volume, setVolume] = useState(0)
      const [query, setQuery] = useState('')
      const [rvcModel, setRvcModel] = useState('')
      const [result, setResult] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [sample, setSample] = useState(null)
      const [sampleBusy, setSampleBusy] = useState(false)
      const [recording, setRecording] = useState(false)
      const [converted, setConverted] = useState(null)
      const [convertBusy, setConvertBusy] = useState(false)
      const [customName, setCustomName] = useState('')
      const [customSaveBusy, setCustomSaveBusy] = useState(false)
      const [customMessage, setCustomMessage] = useState('')
      const [customError, setCustomError] = useState(null)
      const [presetName, setPresetName] = useState('')
      const [presetBusy, setPresetBusy] = useState('')
      const recorderRef = useRef(null)
      const chunksRef = useRef([])
      const sampleFileRef = useRef(null)

      const engines = status?.engines
      const voices = status?.voices ?? []
      const presets = status?.presets ?? []
      const rvc = engines?.rvc
      const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase()
        if (needle === '') return voices
        return voices.filter((item) =>
          [item.name, item.id, item.locale, ...(item.tags ?? [])].join(' ').toLowerCase().includes(needle),
        )
      }, [query, voices])
      const selectedVoice = voices.find((item) => item.id === voice) ?? null
      const selectedPreset = presets.find((item) => item.id === preset) ?? null

      const synthesize = async (sample = false) => {
        const input = sample
          ? `你好，我是${selectedVoice?.name ?? '晓晓'}。这是当前声线的试听。`
          : text
        if (String(input).trim() === '') {
          setError('请先输入要朗读的文本')
          return
        }
        setBusy(true)
        setError(null)
        try {
          const value = await api('tts', {
            text: input,
            voice,
            preset,
            rate,
            pitch,
            volume,
            rvcModel: rvc?.available ? rvcModel : '',
          })
          setResult(value)
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally {
          setBusy(false)
        }
      }

      const uploadSample = async (file) => {
        if (!file) return
        setSampleBusy(true)
        setCustomError(null)
        setCustomMessage('')
        setConverted(null)
        try {
          const dataUrl = await fileToDataUrl(file)
          const uploaded = await api('upload', {
            name: file.name || `recording-${Date.now()}.webm`,
            kind: 'audio',
            dataUrl,
          })
          setSample(uploaded)
        } catch (failure) {
          setCustomError(String(failure?.message ?? failure))
        } finally {
          setSampleBusy(false)
        }
      }

      const toggleRecord = async () => {
        if (recording) {
          recorderRef.current?.stop()
          setRecording(false)
          return
        }
        if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
          setCustomError('当前客户端不支持录音，请改用“上传录音”。')
          return
        }
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
          const recorder = new MediaRecorder(stream)
          chunksRef.current = []
          recorder.ondataavailable = (event) => {
            if (event.data?.size) chunksRef.current.push(event.data)
          }
          recorder.onstop = () => {
            const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
            stream.getTracks().forEach((track) => track.stop())
            recorderRef.current = null
            const file = new File([blob], `recording-${Date.now()}.webm`, { type: blob.type || 'audio/webm' })
            void uploadSample(file)
          }
          recorderRef.current = recorder
          recorder.start()
          setRecording(true)
          setCustomError(null)
        } catch (failure) {
          setCustomError(`无法打开麦克风：${failure?.message ?? failure}`)
        }
      }

      const convertSample = async () => {
        if (!sample) {
          setCustomError('先录一段音或上传录音')
          return
        }
        setConvertBusy(true)
        setCustomError(null)
        setConverted(null)
        try {
          const value = await api('voice/convert', {
            path: sample.path,
            preset,
            rvcModel: rvc?.available ? rvcModel : '',
          })
          setConverted(value)
        } catch (failure) {
          setCustomError(String(failure?.message ?? failure))
        } finally {
          setConvertBusy(false)
        }
      }

      const saveCustomPreset = async () => {
        if (!sample || !converted) {
          setCustomError('先转换试听，再保存为预设')
          return
        }
        const name = customName.trim() || `${selectedVoice?.name ?? '我'}的声线`
        setCustomSaveBusy(true)
        setCustomError(null)
        setCustomMessage('')
        try {
          const value = await api('voice/preset', {
            name,
            basePreset: preset,
            samplePath: sample.path,
            previewPath: converted.path,
            rvcModel: rvc?.available ? rvcModel : '',
          })
          setPreset(value.preset.id)
          setCustomName('')
          setCustomMessage(`已保存「${value.preset.name}」，可直接用于上方合成。`)
          if (reload) await reload()
        } catch (failure) {
          setCustomError(String(failure?.message ?? failure))
        } finally {
          setCustomSaveBusy(false)
        }
      }

      const renameCustomPreset = async () => {
        if (!selectedPreset?.custom || presetName.trim() === '') return
        setPresetBusy('rename')
        setCustomError(null)
        try {
          const value = await api('voice/preset/rename', { id: selectedPreset.id, name: presetName.trim() })
          setPreset(value.preset.id)
          setPresetName('')
          setCustomMessage('声线已重命名。')
          if (reload) await reload()
        } catch (failure) {
          setCustomError(String(failure?.message ?? failure))
        } finally {
          setPresetBusy('')
        }
      }

      const deleteCustomPreset = async () => {
        if (!selectedPreset?.custom) return
        if (!window.confirm(`删除自定义声线「${selectedPreset.name}」？`)) return
        setPresetBusy('delete')
        setCustomError(null)
        try {
          await api('voice/preset/delete', { id: selectedPreset.id })
          setPreset('natural')
          setCustomMessage('声线已删除。')
          if (reload) await reload()
        } catch (failure) {
          setCustomError(String(failure?.message ?? failure))
        } finally {
          setPresetBusy('')
        }
      }

      return h(
        'div',
        { className: 'cc-panel' },
        h(
          'div',
          { className: 'cc-section-head' },
          h('div', null, h('h3', null, '多声线合成'), h('p', null, '神经声线 × RVC 风格声线变换，一条文本多种音色')),
          h('span', { className: 'cc-pill' }, rvc?.available ? 'RVC 已接入' : 'RVC 风格 DSP'),
        ),
        h(
          'div',
          { className: 'cc-block' },
          h(
            'div',
            { className: 'cc-block-title' },
            '选择声线',
            h('span', null, `${voices.length} 个神经声线 · ${presets.length} 种声线变换`),
          ),
          h('input', {
            className: 'cc-input cc-search',
            placeholder: '搜索声线：晓晓 / 少女 / 粤语 / English…',
            value: query,
            onChange: (event) => setQuery(event.target.value),
          }),
          h(
            'div',
            { className: 'cc-voice-grid' },
            filtered.map((item) =>
              h(
                'button',
                {
                  key: item.id,
                  type: 'button',
                  className: `cc-voice${voice === item.id ? ' is-active' : ''}`,
                  onClick: () => setVoice(item.id),
                  title: item.desc,
                },
                h('span', { className: `cc-voice-avatar is-${item.gender}` }, item.name.slice(0, 1)),
                h(
                  'span',
                  { className: 'cc-voice-body' },
                  h('b', null, item.name),
                  h('small', null, `${LOCALE_LABEL[item.locale] ?? item.locale} · ${(item.tags ?? []).join(' / ')}`),
                ),
                voice === item.id ? h('i', { className: 'cc-voice-check' }, '✓') : null,
              ),
            ),
          ),
        ),
        h(
          'div',
          { className: 'cc-block' },
          h('div', { className: 'cc-block-title' }, 'RVC 风格声线'),
          h(
            'div',
            { className: 'cc-chip-row' },
            presets.map((item) =>
              h(
                'button',
                {
                  key: item.id,
                  type: 'button',
                  className: `cc-chip${preset === item.id ? ' is-active' : ''}`,
                  title: item.desc,
                  onClick: () => setPreset(item.id),
                },
                item.name,
              ),
            ),
          ),
          h(
            'div',
            { className: 'cc-preset-desc' },
            selectedPreset?.desc ?? '选择一种声线变换',
          ),
          selectedPreset?.custom
            ? h(
                'div',
                { className: 'cc-custom-preset-edit' },
                h('input', {
                  className: 'cc-input',
                  value: presetName,
                  maxLength: 30,
                  placeholder: `重命名「${selectedPreset.name}」`,
                  onChange: (event) => setPresetName(event.target.value),
                }),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'cc-btn cc-btn-ghost',
                    disabled: presetBusy !== '' || presetName.trim() === '',
                    onClick: () => void renameCustomPreset(),
                  },
                  presetBusy === 'rename' ? h(Spinner) : '重命名',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'cc-btn cc-btn-ghost cc-btn-danger',
                    disabled: presetBusy !== '',
                    onClick: () => void deleteCustomPreset(),
                  },
                  presetBusy === 'delete' ? h(Spinner) : '删除',
                ),
              )
            : null,
        ),
        rvc?.available
          ? h(
              'div',
              { className: 'cc-block' },
              h('div', { className: 'cc-block-title' }, '本地 RVC 模型'),
              h(
                'select',
                { className: 'cc-input', value: rvcModel, onChange: (event) => setRvcModel(event.target.value) },
                h('option', { value: '' }, '不转换 · 只使用 DSP 声线'),
                (rvc.models ?? []).map((model) => h('option', { key: model.id, value: model.id }, model.name)),
              ),
            )
          : null,
        h(
          'div',
          { className: 'cc-block cc-custom-voice' },
          h(
            'div',
            { className: 'cc-block-title' },
            '自定义声线',
            h('span', null, sample ? '样本已就绪' : '录音 / 上传'),
          ),
          h(
            'div',
            { className: 'cc-ai-cut-copy' },
            '录一段 5—10 秒干声，选上方声线（可选上方 RVC 模型）转换试听，满意后保存为自定义预设。',
          ),
          h('input', {
            ref: sampleFileRef,
            type: 'file',
            accept: 'audio/*',
            style: { display: 'none' },
            onChange: (event) => {
              void uploadSample(event.target.files?.[0])
              event.target.value = ''
            },
          }),
          h(
            'div',
            { className: 'cc-custom-voice-actions' },
            h(
              'button',
              {
                type: 'button',
                className: `cc-btn ${recording ? 'cc-btn-danger' : 'cc-btn-solid'}`,
                disabled: sampleBusy || convertBusy,
                onClick: () => void toggleRecord(),
              },
              h(Glyph, { name: 'mic', size: 13 }),
              recording ? '停止录音' : '录音',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'cc-btn cc-btn-ghost',
                disabled: sampleBusy || convertBusy,
                onClick: () => sampleFileRef.current?.click(),
              },
              h(Glyph, { name: 'plus', size: 12 }),
              '上传录音',
            ),
          ),
          sampleBusy ? h('div', { className: 'cc-tip' }, '录音上传中…') : null,
          sample ? h('audio', { className: 'cc-audio-player', controls: true, src: sample.asset?.url }) : null,
          sample ? h('div', { className: 'cc-tip' }, `样本：${sample.asset?.name ?? sample.path}`) : null,
          sample
            ? h(
                'div',
                null,
                h(
                  'div',
                  { className: 'cc-tip' },
                  rvc?.available && rvcModel
                    ? `转换目标：${presets.find((item) => item.id === preset)?.name ?? preset} + RVC 模型`
                    : `转换目标：${presets.find((item) => item.id === preset)?.name ?? preset}（DSP 声线）`,
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'cc-btn cc-btn-primary cc-btn-wide',
                    disabled: convertBusy || sampleBusy,
                    onClick: () => void convertSample(),
                  },
                  convertBusy ? h(Spinner) : h(Glyph, { name: 'sparkles', size: 13 }),
                  convertBusy ? '转换中…' : '转换试听',
                ),
              )
            : null,
          converted ? h('audio', { className: 'cc-audio-player', controls: true, src: converted.asset?.url }) : null,
          converted
            ? h(
                'div',
                { className: 'cc-custom-save' },
                h('input', {
                  className: 'cc-input',
                  value: customName,
                  maxLength: 30,
                  placeholder: `给声线起名，例如「我的${selectedVoice?.name ?? ''}声线」`,
                  onChange: (event) => setCustomName(event.target.value),
                }),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'cc-btn cc-btn-primary',
                    disabled: customSaveBusy,
                    onClick: () => void saveCustomPreset(),
                  },
                  customSaveBusy ? h(Spinner) : h(Glyph, { name: 'plus', size: 12 }),
                  '保存为预设',
                ),
              )
            : null,
          customError ? h(ErrorLine, { error: customError }) : null,
          customMessage ? h('div', { className: 'cc-note is-ok' }, customMessage) : null,
          h('div', { className: 'cc-tip' }, '说明：这是录音 → DSP/RVC 声线转换，不是声音克隆；不会凭一段录音生成某个人的 TTS 声库。'),
        ),
        h(
          'div',
          { className: 'cc-block' },
          h(
            'div',
            { className: 'cc-block-title' },
            '文本',
            h('span', null, `${String(text).length} / 6000`),
          ),
          h('textarea', {
            className: 'cc-textarea',
            rows: 5,
            maxLength: 6000,
            value: text,
            placeholder: '输入台词、旁白或对白…',
            onChange: (event) => setText(event.target.value),
          }),
        ),
        h(
          'div',
          { className: 'cc-slider-stack' },
          [['语速', rate, setRate, -50, 100, '%'], ['音高', pitch, setPitch, -50, 50, 'Hz'], ['音量', volume, setVolume, -50, 50, '%']].map(
            ([label, value, setter, min, max, unit]) =>
              h(
                'div',
                { key: label, className: 'cc-slider-row' },
                h('span', null, label),
                h('input', {
                  type: 'range',
                  min,
                  max,
                  value,
                  onChange: (event) => setter(numberValue(event.target.value)),
                }),
                h('b', null, `${value > 0 ? '+' : ''}${value}${unit}`),
              ),
          ),
        ),
        h(ErrorLine, { error }),
        !engines?.tts?.ok
          ? h('div', { className: 'cc-note is-warn' }, '语音引擎不可用：未找到 edge-tts。请安装 edge-tts，或在“设置”里指定路径。')
          : null,
        h(
          'div',
          { className: 'cc-action-row' },
          h(
            'button',
            {
              type: 'button',
              className: 'cc-btn cc-btn-primary cc-btn-wide',
              disabled: busy || !engines?.tts?.ok,
              onClick: () => void synthesize(false),
            },
            busy ? h(Spinner) : h(Glyph, { name: 'mic', size: 15 }),
            busy ? '合成中…' : '合成语音',
          ),
          h(
            'button',
            { type: 'button', className: 'cc-btn cc-btn-ghost', disabled: busy, onClick: () => void synthesize(true) },
            h(Glyph, { name: 'play', size: 13 }),
            '试听',
          ),
        ),
        result
          ? h(
              'div',
              { className: 'cc-tts-result' },
              h(
                'div',
                { className: 'cc-result-head' },
                h(Glyph, { name: 'sparkles', size: 15 }),
                h('b', null, '合成完成'),
                h('span', null, `${result.presetName}${result.rvcModel ? ` + RVC ${result.rvcModel}` : ''}${result.subtitle ? ' · 含字幕' : ''}`),
              ),
              h('audio', { className: 'cc-audio', src: result.asset?.url, controls: true, preload: 'metadata' }),
              h(
                'div',
                { className: 'cc-audio-meta' },
                h('span', null, formatDuration(result.duration)),
                h('span', null, formatBytes(result.asset?.bytes)),
                h('span', { title: result.textPreview }, result.textPreview),
              ),
              h('div', { className: 'cc-result-path', title: result.asset?.path }, shortPath(result.asset?.path)),
              h(
                'div',
                { className: 'cc-result-actions' },
                h(CopyButton, { text: result.asset?.path }),
                h(
                  'a',
                  { className: 'cc-btn cc-btn-ghost', href: result.asset?.downloadUrl, target: '_blank', rel: 'noreferrer' },
                  h(Glyph, { name: 'download', size: 13 }),
                  '下载',
                ),
                result.subtitle
                  ? h(
                      'a',
                      {
                        className: 'cc-btn cc-btn-ghost',
                        href: result.subtitle.downloadUrl,
                        target: '_blank',
                        rel: 'noreferrer',
                        title: result.subtitle.path,
                      },
                      h(Glyph, { name: 'copy', size: 13 }),
                      '字幕 SRT',
                    )
                  : null,
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'cc-btn cc-btn-solid',
                    onClick: () => setSharedAudio({ ...result.asset, subtitle: result.subtitle }),
                  },
                  h(Glyph, { name: 'film', size: 13 }),
                  '送去视频',
                ),
              ),
            )
          : null,
        h(
          'div',
          { className: 'cc-tip' },
          '声线变换在本地用 FFmpeg 完成，不会上传文本或声音。RVC 模型只读本地 .pth；通过设置里的命令模板接入推理器。',
        ),
      )
    }

    // ------------------------------------------------------------------ settings

    function SettingsPanel({ status, reload, onBack }) {
      const engines = status?.engines ?? {}
      const generator = status?.generator ?? {}
      const llm = status?.llm ?? {}
      const asr = status?.asr ?? {}
      const llmProviders = status?.llmProviders ?? []
      const providers = status?.imageProviders ?? []
      const [form, setForm] = useState({
        ffmpegPath: engines.video?.ffmpeg ?? '',
        pythonPath: engines.image?.python ?? '',
        edgeTtsPath: engines.tts?.command ?? '',
        rvcCommand: engines.rvc?.command ?? '',
        imageProvider: generator.provider ?? 'pollinations',
        imageBaseURL: generator.baseURL ?? '',
        imageModel: generator.model ?? '',
        imageModels: (generator.models ?? []).join(', '),
        imageApiKeyEnv: generator.keyEnv ?? 'OPENAI_API_KEY',
        imageSize: generator.size ?? '1024x1024',
        imageQuality: generator.quality ?? '',
        llmBaseURL: llm.baseURL ?? 'https://api.openai.com/v1',
        llmModel: llm.model ?? 'gpt-4o-mini',
        llmApiKeyEnv: llm.keyEnv ?? 'OPENAI_API_KEY',
        llmProvider: llm.provider ?? 'openai',
        asrBaseURL: asr.baseURL ?? 'https://api.openai.com/v1',
        asrModel: asr.model ?? 'whisper-1',
        asrApiKeyEnv: asr.keyEnv ?? 'OPENAI_API_KEY',
      })
      const [advanced, setAdvanced] = useState(false)
      const [busy, setBusy] = useState(false)
      const [saved, setSaved] = useState(false)
      const [error, setError] = useState(null)
      const [apiKey, setApiKey] = useState('')
      const [keyBusy, setKeyBusy] = useState(false)
      const [keyMessage, setKeyMessage] = useState('')
      const [llmApiKey, setLlmApiKey] = useState('')
      const [llmKeyBusy, setLlmKeyBusy] = useState(false)
      const [llmKeyMessage, setLlmKeyMessage] = useState('')
      const [asrApiKey, setAsrApiKey] = useState('')
      const [asrKeyBusy, setAsrKeyBusy] = useState(false)
      const [asrKeyMessage, setAsrKeyMessage] = useState('')
      const [testBusy, setTestBusy] = useState('')
      const [testMessage, setTestMessage] = useState('')
      const [testError, setTestError] = useState(null)

      const update = (key, value) => setForm((current) => ({ ...current, [key]: value }))

      const applyProvider = (id) => {
        const preset = providers.find((item) => item.id === id)
        setForm((current) => ({
          ...current,
          imageProvider: id,
          imageBaseURL: preset?.baseURL ?? current.imageBaseURL,
          imageModel: preset?.model ?? current.imageModel,
          imageModels: (preset?.models ?? []).join(', ') || current.imageModels,
        }))
      }

      const applyLlmProvider = (id) => {
        const preset = llmProviders.find((item) => item.id === id)
        setForm((current) => ({
          ...current,
          llmProvider: id,
          llmBaseURL: preset?.baseURL ?? current.llmBaseURL,
          llmModel: preset?.model ?? current.llmModel,
        }))
      }

      const save = async () => {
        setBusy(true)
        setError(null)
        setSaved(false)
        try {
          await api('settings', form)
          await reload()
          setSaved(true)
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally {
          setBusy(false)
        }
      }

      const saveKey = async () => {
        if (apiKey.trim() === '') return
        setKeyBusy(true)
        setError(null)
        setKeyMessage('')
        try {
          await api('image/key', { key: apiKey.trim() })
          setApiKey('')
          await reload()
          setKeyMessage('生图 Key 已保存。')
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally {
          setKeyBusy(false)
        }
      }

      const saveLlmKey = async () => {
        if (llmApiKey.trim() === '') return
        setLlmKeyBusy(true)
        setError(null)
        setLlmKeyMessage('')
        try {
          await api('llm/key', { key: llmApiKey.trim() })
          setLlmApiKey('')
          await reload()
          setLlmKeyMessage('语言剪辑 Key 已保存。')
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally {
          setLlmKeyBusy(false)
        }
      }

      const saveAsrKey = async () => {
        if (asrApiKey.trim() === '') return
        setAsrKeyBusy(true)
        setError(null)
        setAsrKeyMessage('')
        try {
          await api('asr/key', { key: asrApiKey.trim() })
          setAsrApiKey('')
          await reload()
          setAsrKeyMessage('ASR Key 已保存。')
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally {
          setAsrKeyBusy(false)
        }
      }

      const testApi = async (kind) => {
        setTestBusy(kind)
        setTestMessage('')
        setTestError(null)
        try {
          await api('settings', form)
          await reload()
          const value = await api('api/test', { kind })
          const models = Array.isArray(value.models) && value.models.length > 0
            ? ` · ${value.models.slice(0, 4).join(', ')}`
            : ''
          setTestMessage(
            kind === 'image'
              ? `连接成功${models}`
              : `连接成功 · ${value.model} · ${value.latencyMs} ms`,
          )
        } catch (failure) {
          setTestError(String(failure?.message ?? failure))
        } finally {
          setTestBusy('')
        }
      }

      const keyRow = (value, onChange, placeholder, onSave, saving, configured) =>
        h(
          'div',
          { className: 'cc-key-row' },
          h('input', {
            className: 'cc-input cc-mono',
            type: 'password',
            autoComplete: 'off',
            value,
            placeholder: configured ? '已配置；输入新 Key 可覆盖' : placeholder,
            onChange: (event) => onChange(event.target.value),
          }),
          h(
            'button',
            {
              type: 'button',
              className: 'cc-btn cc-btn-solid',
              disabled: saving || value.trim() === '',
              onClick: () => void onSave(),
            },
            saving ? h(Spinner) : null,
            '保存',
          ),
        )

      const card = (title, badge, badgeClass, children) =>
        h(
          'section',
          { className: 'cc-settings-card' },
          h(
            'div',
            { className: 'cc-settings-card-head' },
            h('b', null, title),
            badge ? h('span', { className: `cc-settings-badge ${badgeClass ?? ''}` }, badge) : null,
          ),
          children,
        )

      const engineItems = [
        ['图片', engines.image?.ok],
        ['超分', engines.upscale?.ok],
        ['视频', engines.video?.ok],
        ['配音', engines.tts?.ok],
      ]
      const selectedLlmPreset = llmProviders.find((item) => item.id === form.llmProvider) ?? null

      return h(
        'div',
        { className: 'cc-panel cc-settings-panel' },
        h(
          'div',
          { className: 'cc-section-head' },
          h('div', null, h('h3', null, '设置'), h('p', null, '常用配置只有三块，路径收在高级里')),
          h(
            'button',
            { type: 'button', className: 'cc-btn cc-btn-ghost', onClick: onBack },
            h(Glyph, { name: 'close', size: 13 }),
            '返回',
          ),
        ),
        h(
          'div',
          { className: 'cc-settings-scroll' },
          h(
            'div',
            { className: 'cc-settings-topline' },
            h('span', null, '常用设置'),
            h(
              'button',
              {
                type: 'button',
                className: `cc-settings-more${advanced ? ' is-open' : ''}`,
                onClick: () => setAdvanced((value) => !value),
              },
              advanced ? '收起高级' : '高级选项',
              h(Glyph, { name: 'chevronDown', size: 12 }),
            ),
          ),

          card(
            '生图',
            form.imageProvider === 'pollinations' ? '免 Key' : generator.hasKey ? '已配置' : '缺 Key',
            form.imageProvider === 'pollinations' || generator.hasKey ? 'is-ok' : 'is-warn',
            [
              h(
                Field,
                { key: 'provider', label: 'Provider', hint: '选一个服务' },
                h(
                  'select',
                  { className: 'cc-input', value: form.imageProvider, onChange: (event) => applyProvider(event.target.value) },
                  (providers.length > 0 ? providers : [{ id: 'pollinations', label: 'Pollinations（免 Key）' }]).map((item) =>
                    h('option', { key: item.id, value: item.id }, item.label),
                  ),
                ),
              ),
              form.imageProvider === 'pollinations'
                ? h(
                    'div',
                    { className: 'cc-settings-free' },
                    h('div', { className: 'cc-settings-note' }, 'Pollinations 免 Key，开箱可用；额度约每 IP 45 秒 1 张。'),
                    h(
                      'button',
                      { type: 'button', className: 'cc-btn cc-btn-ghost', onClick: () => applyProvider('openai') },
                      '用自己的 API · 填 Key',
                    ),
                  )
                : h(
                    'div',
                    { key: 'image-custom' },
                    h(
                      Field,
                      { label: '接口地址', hint: 'Base URL' },
                      h('input', {
                        className: 'cc-input cc-mono',
                        value: form.imageBaseURL,
                        placeholder: 'https://api.openai.com/v1',
                        onChange: (event) => update('imageBaseURL', event.target.value),
                      }),
                    ),
                    h(
                      Field,
                      { label: '模型', hint: '默认模型' },
                      h('input', {
                        className: 'cc-input cc-mono',
                        value: form.imageModel,
                        placeholder: 'gpt-image-1',
                        onChange: (event) => update('imageModel', event.target.value),
                      }),
                    ),
                    keyRow(
                      apiKey,
                      setApiKey,
                      `粘贴 ${form.imageApiKeyEnv || 'API'} Key`,
                      saveKey,
                      keyBusy,
                      generator.hasKey,
                    ),
                    keyMessage ? h('div', { className: 'cc-note is-ok' }, keyMessage) : null,
                  ),
              advanced
                ? h(
                    'div',
                    { key: 'image-advanced', className: 'cc-settings-advanced' },
                    h(
                      'div',
                      { className: 'cc-grid-2' },
                      h(
                        Field,
                        { label: '模型列表', hint: '逗号分隔' },
                        h('input', {
                          className: 'cc-input cc-mono',
                          value: form.imageModels,
                          onChange: (event) => update('imageModels', event.target.value),
                        }),
                      ),
                      h(
                        Field,
                        { label: 'Key 变量名' },
                        h('input', {
                          className: 'cc-input cc-mono',
                          value: form.imageApiKeyEnv,
                          onChange: (event) => update('imageApiKeyEnv', event.target.value),
                        }),
                      ),
                    ),
                    h(
                      'div',
                      { className: 'cc-grid-2' },
                      h(
                        Field,
                        { label: '默认画幅' },
                        h('input', {
                          className: 'cc-input cc-mono',
                          value: form.imageSize,
                          placeholder: '1024x1024',
                          onChange: (event) => update('imageSize', event.target.value),
                        }),
                      ),
                      h(
                        Field,
                        { label: '质量' },
                        h('input', {
                          className: 'cc-input cc-mono',
                          value: form.imageQuality,
                          placeholder: 'auto',
                          onChange: (event) => update('imageQuality', event.target.value),
                        }),
                      ),
                    ),
                  )
                : null,
              h(
                'div',
                { key: 'image-test', className: 'cc-test-row' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'cc-btn cc-btn-ghost',
                    disabled: testBusy !== '',
                    onClick: () => void testApi('image'),
                  },
                  testBusy === 'image' ? h(Spinner) : null,
                  testBusy === 'image' ? '测试中…' : '测试连接',
                ),
                testMessage ? h('span', null, testMessage) : null,
              ),
            ],
          ),

          card(
            '语言剪辑',
            llm.hasKey ? '已配置' : '可选',
            llm.hasKey ? 'is-ok' : '',
            [
              h('div', { key: 'llm-note', className: 'cc-settings-note' }, '用于“按描述剪”，需要支持图片输入的模型。Base URL 含 /anthropic 时自动走 Messages 协议。'),
              h(
                Field,
                { key: 'llm-provider', label: 'Provider', hint: '语言分析服务' },
                h(
                  'select',
                  { className: 'cc-input', value: form.llmProvider, onChange: (event) => applyLlmProvider(event.target.value) },
                  (llmProviders.length > 0
                    ? llmProviders
                    : [{ id: 'openai', label: 'OpenAI / 通用兼容' }]
                  ).map((item) => h('option', { key: item.id, value: item.id }, item.label)),
                ),
              ),
              selectedLlmPreset && selectedLlmPreset.vision === false
                ? h(
                    'div',
                    { className: 'cc-note is-warn' },
                    selectedLlmPreset.note || '这个模型不支持图片输入，不能直接分析视频画面；请换视觉模型。',
                  )
                : null,
              h(
                Field,
                { key: 'llm-base', label: '接口地址', hint: 'Base URL' },
                h('input', {
                  className: 'cc-input cc-mono',
                  value: form.llmBaseURL,
                  placeholder: 'https://api.openai.com/v1',
                  onChange: (event) => update('llmBaseURL', event.target.value),
                }),
              ),
              h(
                Field,
                { key: 'llm-model', label: '视觉模型' },
                h('input', {
                  className: 'cc-input cc-mono',
                  value: form.llmModel,
                  placeholder: 'gpt-4o-mini / qwen-vl-max',
                  onChange: (event) => update('llmModel', event.target.value),
                }),
              ),
              keyRow(
                llmApiKey,
                setLlmApiKey,
                `粘贴 ${form.llmApiKeyEnv || 'API'} Key`,
                saveLlmKey,
                llmKeyBusy,
                llm.hasKey,
              ),
              llmKeyMessage ? h('div', { className: 'cc-note is-ok' }, llmKeyMessage) : null,
              h(
                'div',
                { key: 'llm-test', className: 'cc-test-row' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'cc-btn cc-btn-ghost',
                    disabled: testBusy !== '',
                    onClick: () => void testApi('llm'),
                  },
                  testBusy === 'llm' ? h(Spinner) : null,
                  testBusy === 'llm' ? '测试中…' : '测试连接',
                ),
                testMessage ? h('span', null, testMessage) : null,
              ),
              advanced
                ? h(
                    Field,
                    { key: 'llm-env', label: 'Key 变量名' },
                    h('input', {
                      className: 'cc-input cc-mono',
                      value: form.llmApiKeyEnv,
                      onChange: (event) => update('llmApiKeyEnv', event.target.value),
                    }),
                  )
                : null,
            ],
          ),

          card(
            '本机引擎',
            '自动检测',
            'is-ok',
            [
              h(
                'div',
                { key: 'engine-list', className: 'cc-engine-list' },
                engineItems.map(([label, ok]) =>
                  h(
                    'span',
                    { key: label, className: `cc-engine-pill${ok ? ' is-ok' : ' is-warn'}` },
                    h('i'),
                    label,
                    ok ? '就绪' : '缺失',
                  ),
                ),
              ),
              advanced
                ? h(
                    'div',
                    { key: 'engine-paths', className: 'cc-settings-advanced' },
                    h(
                      Field,
                      { label: 'ffmpeg.exe', hint: '视频 / 声线' },
                      h('input', {
                        className: 'cc-input cc-mono',
                        value: form.ffmpegPath,
                        placeholder: '自动检测',
                        onChange: (event) => update('ffmpegPath', event.target.value),
                      }),
                    ),
                    h(
                      Field,
                      { label: 'python.exe', hint: 'Pillow' },
                      h('input', {
                        className: 'cc-input cc-mono',
                        value: form.pythonPath,
                        placeholder: '自动检测',
                        onChange: (event) => update('pythonPath', event.target.value),
                      }),
                    ),
                    h(
                      Field,
                      { label: 'edge-tts.exe', hint: '配音' },
                      h('input', {
                        className: 'cc-input cc-mono',
                        value: form.edgeTtsPath,
                        placeholder: '自动检测',
                        onChange: (event) => update('edgeTtsPath', event.target.value),
                      }),
                    ),
                  )
                : h('div', { className: 'cc-settings-note' }, '检测正常时无需填路径。'),
            ],
          ),

          advanced
            ? card(
                '语音转写 ASR',
                asr.hasKey ? '已配置' : '可选',
                asr.hasKey ? 'is-ok' : '',
                [
                  h('div', { className: 'cc-settings-note' }, '用于视频“自动转写”，OpenAI 兼容 /audio/transcriptions。'),
                  h(
                    Field,
                    { label: '接口地址', hint: 'Base URL' },
                    h('input', {
                      className: 'cc-input cc-mono',
                      value: form.asrBaseURL,
                      placeholder: 'https://api.openai.com/v1',
                      onChange: (event) => update('asrBaseURL', event.target.value),
                    }),
                  ),
                  h(
                    Field,
                    { label: '转写模型' },
                    h('input', {
                      className: 'cc-input cc-mono',
                      value: form.asrModel,
                      placeholder: 'whisper-1',
                      onChange: (event) => update('asrModel', event.target.value),
                    }),
                  ),
                  keyRow(
                    asrApiKey,
                    setAsrApiKey,
                    `粘贴 ${form.asrApiKeyEnv || 'ASR'} Key`,
                    saveAsrKey,
                    asrKeyBusy,
                    asr.hasKey,
                  ),
                  asrKeyMessage ? h('div', { className: 'cc-note is-ok' }, asrKeyMessage) : null,
                  h(
                    'div',
                    { className: 'cc-test-row' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'cc-btn cc-btn-ghost',
                        disabled: testBusy !== '',
                        onClick: () => void testApi('asr'),
                      },
                      testBusy === 'asr' ? h(Spinner) : null,
                      testBusy === 'asr' ? '测试中…' : '测试连接',
                    ),
                    testMessage ? h('span', null, testMessage) : null,
                  ),
                ],
              )
            : null,

          advanced
            ? card(
                'RVC（可选）',
                engines.rvc?.available ? '已配置' : '未配置',
                engines.rvc?.available ? 'is-ok' : '',
                [
                  h(
                    Field,
                    { label: '命令模板', hint: '使用占位符' },
                    h('textarea', {
                      className: 'cc-textarea cc-mono',
                      rows: 3,
                      value: form.rvcCommand,
                      placeholder: 'python infer_cli.py --input_path {input} --opt_path {output} --model {model} --index {index} --pitch {pitch}',
                      onChange: (event) => update('rvcCommand', event.target.value),
                    }),
                  ),
                  h(
                    'div',
                    { className: 'cc-settings-note' },
                    '占位符：{input} {output} {model} {modelPath} {modelName} {index} {indexPath} {pitch} {python}。模型放工作区 .creative-console/rvc/models。',
                  ),
                ],
              )
            : null,

          h(ErrorLine, { error }),
          testError ? h(ErrorLine, { error: testError }) : null,
          saved ? h('div', { className: 'cc-note is-ok' }, '设置已保存，引擎已重新检测。') : null,
          h('div', { className: 'cc-credit' }, 'MuRaSame 创作助手 · 制作者 丛雨不善言辞'),
          h(
            'div',
            { className: 'cc-settings-save' },
            h(
              'button',
              { type: 'button', className: 'cc-btn cc-btn-primary cc-btn-wide', disabled: busy, onClick: () => void save() },
              busy ? h(Spinner) : h(Glyph, { name: 'settings', size: 14 }),
              busy ? '保存中…' : '保存设置',
            ),
            h('span', null, advanced ? '高级字段也会一起保存' : '只保存常用项；高级项保持默认'),
          ),
        ),
      )
    }

    // ------------------------------------------------------------------ console

    function CreativeToolCard(props) {
      const { toolName, phase, block } = props
      const [copied, setCopied] = useState(false)
      const running = phase !== 'result'
      const failed = phase === 'result' && block?.isError === true
      let text = ''
      if (phase === 'result') {
        if (Array.isArray(block?.content)) {
          text = block.content
            .filter((part) => part?.type === 'text' && typeof part.text === 'string')
            .map((part) => part.text)
            .join('\n')
        } else if (typeof block?.content === 'string') {
          text = block.content
        }
        if (!text && block?.error?.message) text = String(block.error.message)
      }
      const paths = text.match(/[A-Za-z]:\\[^\n\r,]+/g) ?? []
      const firstPath = paths[0]?.trim()
      const openFolder = async () => {
        if (!firstPath) return
        try {
          await api('open-folder', { path: firstPath })
        } catch {
          /* the host rejects paths outside its own output root */
        }
      }
      const copy = async () => {
        if (!text) return
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1200)
        } catch {
          /* clipboard may be unavailable */
        }
      }
      return h(
        'div',
        { className: `cc-toolview${failed ? ' is-error' : ''}`, 'data-tool': toolName },
        h(
          'div',
          { className: 'cc-toolview-head' },
          h('span', { className: 'cc-toolview-mark' }, h(Glyph, { name: 'sparkles', size: 13 })),
          h('b', null, 'MuRaSame'),
          h('span', { className: 'cc-toolview-name' }, toolName.replace(/^creative_/, '').replaceAll('_', ' ')),
          h('span', { className: `cc-toolview-state${running ? ' is-running' : failed ? ' is-error' : ' is-ok'}` }, running ? '进行中' : failed ? '失败' : '已完成'),
        ),
        running
          ? h('div', { className: 'cc-toolview-progress' }, h('i'))
          : h('div', { className: 'cc-toolview-text' }, text || '已完成'),
        phase === 'result' && !failed
          ? h(
              'div',
              { className: 'cc-toolview-actions' },
              firstPath
                ? h(
                    'button',
                    { type: 'button', className: 'cc-btn cc-btn-ghost', onClick: () => void openFolder() },
                    h(Glyph, { name: 'folder', size: 11 }),
                    '打开所在文件夹',
                  )
                : null,
              text ? h('button', { type: 'button', className: 'cc-btn cc-btn-ghost', onClick: () => void copy() }, copied ? '已复制' : '复制结果') : null,
            )
          : null,
      )
    }

    function RecentPanel({ status, onBack }) {
      const items = status?.recent ?? []
      const [error, setError] = useState(null)
      const [projects, setProjects] = useState([])
      const [projectId, setProjectId] = useState('')
      const [projectName, setProjectName] = useState('')
      const [projectBusy, setProjectBusy] = useState('')
      const [projectMessage, setProjectMessage] = useState('')
      const selectedProject = projects.find((project) => project.id === projectId) ?? null

      const loadProjects = async () => {
        try {
          const value = await api('projects/list')
          setProjects(value.projects ?? [])
          if (!projectId && value.projects?.[0]) setProjectId(value.projects[0].id)
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        }
      }

      useEffect(() => {
        void loadProjects()
      }, [])

      const openFolder = async (path) => {
        setError(null)
        try {
          await api('open-folder', { path })
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        }
      }

      const createProject = async () => {
        if (projectName.trim() === '') return
        setProjectBusy('create')
        setError(null)
        try {
          const value = await api('projects/create', { name: projectName.trim() })
          setProjects(value.projects)
          setProjectId(value.project.id)
          setProjectName('')
          setProjectMessage('项目已创建。')
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally {
          setProjectBusy('')
        }
      }

      const deleteProject = async () => {
        if (!selectedProject || !window.confirm(`删除项目「${selectedProject.name}」？成品文件不会被删除。`)) return
        setProjectBusy('delete')
        try {
          const value = await api('projects/delete', { id: selectedProject.id })
          setProjects(value.projects)
          setProjectId(value.projects[0]?.id ?? '')
          setProjectMessage('项目已删除，成品文件仍在。')
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally {
          setProjectBusy('')
        }
      }

      const addToProject = async (item) => {
        if (!selectedProject) return
        setProjectBusy(item.path)
        try {
          const value = await api('projects/update', {
            id: selectedProject.id,
            addPath: item.path,
            kind: item.kind,
            label: item.name,
          })
          setProjects(value.projects)
          setProjectMessage(`已加入「${selectedProject.name}」。`)
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally {
          setProjectBusy('')
        }
      }

      const removeFromProject = async (path) => {
        if (!selectedProject) return
        try {
          const value = await api('projects/update', { id: selectedProject.id, removePath: path })
          setProjects(value.projects)
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        }
      }

      const restoreProject = async () => {
        if (!selectedProject) return
        setProjectBusy('restore')
        try {
          const value = await api('projects/restore', { id: selectedProject.id })
          setProjects(value.projects)
          setProjectMessage('已恢复上一版。')
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally {
          setProjectBusy('')
        }
      }

      return h(
        'div',
        { className: 'cc-panel cc-recent-panel' },
        h(
          'div',
          { className: 'cc-section-head' },
          h('div', null, h('h3', null, '作品与项目'), h('p', null, '最近成品可直接加入项目，项目只记录引用')),
          h(
            'button',
            { type: 'button', className: 'cc-btn cc-btn-ghost', onClick: onBack },
            h(Glyph, { name: 'close', size: 13 }),
            '返回',
          ),
        ),
        h(ErrorLine, { error }),
        h(
          'div',
          { className: 'cc-project-bar' },
          h(
            'select',
            { className: 'cc-input', value: projectId, onChange: (event) => setProjectId(event.target.value) },
            h('option', { value: '' }, '不加入项目'),
            projects.map((project) => h('option', { key: project.id, value: project.id }, `${project.name} · ${project.count}`)),
          ),
          h('input', {
            className: 'cc-input',
            value: projectName,
            maxLength: 40,
            placeholder: '新建项目名称',
            onChange: (event) => setProjectName(event.target.value),
          }),
          h(
            'button',
            { type: 'button', className: 'cc-btn cc-btn-solid', disabled: projectBusy !== '' || projectName.trim() === '', onClick: () => void createProject() },
            projectBusy === 'create' ? h(Spinner) : '新建',
          ),
          selectedProject
            ? h(
                'button',
                { type: 'button', className: 'cc-btn cc-btn-ghost cc-btn-danger', disabled: projectBusy !== '', onClick: () => void deleteProject() },
                '删除项目',
              )
            : null,
        ),
        projectMessage ? h('div', { className: 'cc-note is-ok' }, projectMessage) : null,
        items.length === 0
          ? h('div', { className: 'cc-empty' }, h(Glyph, { name: 'folder', size: 28 }), h('b', null, '还没有成品'), h('span', null, '生成或导出的文件会自动出现在这里。'))
          : h(
              'div',
              { className: 'cc-recent-list' },
              items.map((item) =>
                h(
                  'div',
                  { className: 'cc-recent-item', key: item.id },
                  h(
                    'div',
                    { className: `cc-recent-thumb is-${item.kind}` },
                    item.kind === 'image'
                      ? h('img', { src: item.url, alt: item.name })
                      : h(Glyph, { name: item.kind === 'video' ? 'film' : item.kind === 'audio' ? 'mic' : 'file', size: 18 }),
                  ),
                  h(
                    'div',
                    { className: 'cc-recent-body' },
                    h('b', { title: item.name }, item.name),
                    h(
                      'span',
                      null,
                      `${item.kind}${item.width ? ` · ${item.width}×${item.height}` : ''}${item.duration ? ` · ${formatDuration(item.duration)}` : ''} · ${formatBytes(item.bytes)}`,
                    ),
                    h('code', { title: item.path }, shortPath(item.path, 40)),
                    h(
                      'div',
                      { className: 'cc-result-actions' },
                      h(
                        'button',
                        { type: 'button', className: 'cc-btn cc-btn-ghost', onClick: () => void openFolder(item.path) },
                        h(Glyph, { name: 'folder', size: 11 }),
                        '所在文件夹',
                      ),
                      h(CopyButton, { text: item.path, label: '复制' }),
                      h(
                        'a',
                        { className: 'cc-icon-btn', href: item.downloadUrl, target: '_blank', rel: 'noreferrer', title: '下载' },
                        h(Glyph, { name: 'download', size: 12 }),
                      ),
                      selectedProject
                        ? h(
                            'button',
                            {
                              type: 'button',
                              className: 'cc-btn cc-btn-ghost',
                              disabled: projectBusy !== '',
                              onClick: () => void addToProject(item),
                            },
                            projectBusy === item.path ? h(Spinner) : h(Glyph, { name: 'plus', size: 10 }),
                            '加入项目',
                          )
                        : null,
                    ),
                  ),
                ),
              ),
            ),
        selectedProject
          ? h(
              'div',
              { className: 'cc-project-items' },
              h(
                'div',
                { className: 'cc-block-title' },
                h('span', null, `项目：${selectedProject.name}`),
                h('span', null, `${selectedProject.items.length} 项`),
                selectedProject.snapshots?.length
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'cc-btn cc-btn-ghost',
                        disabled: projectBusy !== '',
                        onClick: () => void restoreProject(),
                      },
                      projectBusy === 'restore' ? h(Spinner) : `恢复上一版 · ${selectedProject.snapshots.length}`,
                    )
                  : null,
              ),
              selectedProject.items.length === 0
                ? h('div', { className: 'cc-settings-note' }, '点上方成品的「加入项目」把素材收进来。')
                : selectedProject.items.map((item) =>
                    h(
                      'div',
                      { className: 'cc-project-item', key: item.path },
                      h(Glyph, { name: item.kind === 'video' ? 'film' : item.kind === 'audio' ? 'mic' : 'file', size: 12 }),
                      h('span', { title: item.path }, item.label || shortPath(item.path, 34)),
                      h(
                        'button',
                        { type: 'button', className: 'cc-icon-btn', title: '打开所在文件夹', onClick: () => void openFolder(item.path) },
                        h(Glyph, { name: 'folder', size: 11 }),
                      ),
                      h(
                        'button',
                        { type: 'button', className: 'cc-icon-btn', title: '移出项目', onClick: () => void removeFromProject(item.path) },
                        '×',
                      ),
                    ),
                  ),
            )
          : null,
      )
    }

    function ConsolePanel({ anchor, onClose, onCollapse, closing, wide }) {
      const { status, error, loading, reload } = useStatus()
      const [tab, setTab] = useState(() => {
        try {
          return window.localStorage.getItem(LS_TAB) ?? 'image'
        } catch {
          return 'image'
        }
      })
      const [settings, setSettings] = useState(false)
      const [recentOpen, setRecentOpen] = useState(false)
      const [sharedAudio, setSharedAudio] = useState(null)
      const [seedImage, setSeedImage] = useState('')
      const [folderBusy, setFolderBusy] = useState(false)
      const [folderError, setFolderError] = useState('')

      const openOutputFolder = async () => {
        setFolderBusy(true)
        setFolderError('')
        try {
          await api('open-folder', {
            path: status?.outputs ? `${status.outputs}\\outputs` : '',
          })
        } catch (failure) {
          setFolderError(String(failure?.message ?? failure))
        } finally {
          setFolderBusy(false)
        }
      }

      useEffect(() => {
        try {
          window.localStorage.setItem(LS_TAB, tab)
        } catch {
          /* storage disabled */
        }
      }, [tab])

      const changeTab = (id) => {
        setSettings(false)
        setRecentOpen(false)
        setTab(id)
      }

      const title = recentOpen ? '最近成品' : settings ? '引擎设置' : tab === 'image' ? '图片工坊' : tab === 'video' ? '视频剪辑' : '声线实验室'

      return h(
        'div',
        {
          className: `cc-console${closing ? ' is-closing' : ''}`,
          style: {
            top: `${anchor.top}px`,
            left: `${anchor.left}px`,
            height: `${anchor.height}px`,
          },
          role: 'dialog',
          'aria-label': 'MuRaSame 创作助手',
          'aria-expanded': !closing,
        },
        h(
          'div',
          { className: 'cc-header' },
          h(
            'div',
            { className: 'cc-header-main' },
            h(
              'span',
              { className: 'cc-logo' },
              h('img', { src: `${API}/icon`, alt: 'MuRaSame' }),
            ),
            h(
              'div',
              { className: 'cc-header-text' },
              h('b', null, 'MuRaSame'),
              h('span', null, title),
            ),
          ),
          h(
            'div',
            { className: 'cc-header-actions' },
            h(
              'button',
              {
                type: 'button',
                className: `cc-header-icon${recentOpen ? ' is-active' : ''}`,
                title: '最近成品',
                onClick: () => {
                  setRecentOpen((value) => !value)
                  setSettings(false)
                },
              },
              h(Glyph, { name: 'folder', size: 15 }),
            ),
            h(
              'button',
              {
                type: 'button',
                className: `cc-header-icon${settings ? ' is-active' : ''}`,
                title: '引擎设置',
                onClick: () => {
                  setSettings((value) => !value)
                  setRecentOpen(false)
                },
              },
              h(Glyph, { name: 'settings', size: 15 }),
            ),
            h(
              'button',
              { type: 'button', className: 'cc-collapse', onClick: onCollapse, title: '收起 MuRaSame 创作助手（向左折叠）' },
              wide === false ? null : '收起',
              h(Glyph, { name: 'chevronLeft', size: 15 }),
            ),
          ),
        ),
        h(
          'div',
          { className: 'cc-subhead' },
          h(EngineDots, { status }),
          h(
            'button',
            { type: 'button', className: 'cc-refresh', title: '重新检测引擎', onClick: () => void reload() },
            h(Glyph, { name: 'refresh', size: 13 }),
          ),
        ),
        !settings
          ? h(
              'div',
              { className: 'cc-tabs', role: 'tablist' },
              [
                ['image', '图片', 'image', '优化生成图'],
                ['video', '视频', 'film', '多段剪辑'],
                ['voice', '声线', 'mic', 'TTS / RVC'],
              ].map(([id, label, icon]) =>
                h(
                  'button',
                  {
                    key: id,
                    type: 'button',
                    role: 'tab',
                    'aria-selected': tab === id,
                    className: `cc-tab${tab === id ? ' is-active' : ''}`,
                    onClick: () => changeTab(id),
                  },
                  h(Glyph, { name: icon, size: 14 }),
                  label,
                ),
              ),
            )
          : null,
        h(
          'div',
          { className: 'cc-body' },
          loading
            ? h('div', { className: 'cc-loading' }, h(Spinner), '正在检测本机引擎…')
            : error
              ? h(
                  'div',
                  { className: 'cc-loading is-error' },
                  h('b', null, '宿主接口不可用'),
                  h('span', null, error),
                  h('button', { type: 'button', className: 'cc-btn cc-btn-solid', onClick: () => void reload() }, '重试'),
                )
              : null,
          status
            ? recentOpen
              ? h(RecentPanel, { status, onBack: () => setRecentOpen(false) })
              : settings
                ? h(SettingsPanel, { status, reload, onBack: () => setSettings(false) })
                : tab === 'image'
                ? h(ImagePanel, { status, seedPath: seedImage, onSettings: () => setSettings(true) })
                : tab === 'video'
                  ? h(VideoPanel, {
                      status,
                      sharedAudio,
                      setSharedAudio,
                      onOptimizeImage: (path) => {
                        setSeedImage(path)
                        setSettings(false)
                        setTab('image')
                      },
                      onSettings: () => setSettings(true),
                    })
                  : h(VoicePanel, { status, setSharedAudio, reload })
            : null,
        ),
        h(
          'div',
          { className: 'cc-footer' },
          h('span', { className: 'cc-footer-path', title: status?.outputs }, status ? `输出：${shortPath(status.outputs, 28)}` : '本机处理'),
          h(
            'div',
            { className: 'cc-footer-actions' },
            sharedAudio ? h('span', { className: 'cc-footer-chip' }, '配音就绪') : null,
            h(
              'button',
              {
                type: 'button',
                className: 'cc-footer-open',
                title: folderError || '在资源管理器中打开输出文件夹',
                disabled: folderBusy,
                onClick: () => void openOutputFolder(),
              },
              h(Glyph, { name: 'folder', size: 12 }),
              folderBusy ? '打开中…' : '打开所在文件夹',
            ),
          ),
        ),
      )
    }

    // ------------------------------------------------------------------ launcher

    function Launcher() {
      const [open, setOpen] = useState(false)
      const [closing, setClosing] = useState(false)
      const [anchor, setAnchor] = useState({ top: 64, left: 8, height: 620 })
      const [railShift, setRailShift] = useState(() => {
        try {
          const value = Number(window.localStorage.getItem('dsh-creative-console.railShift'))
          return Number.isFinite(value) ? Math.min(420, Math.max(0, value)) : 80
        } catch {
          return 80
        }
      })
      const [dragging, setDragging] = useState(false)
      const dragRef = useRef(null)
      const movedRef = useRef(false)
      const timerRef = useRef(null)
      const rootRef = useRef(null)

      const clampRailShift = (value) => Math.max(0, Math.min(420, Math.min(window.innerHeight - 280, value)))

      useEffect(() => {
        try {
          window.localStorage.setItem('dsh-creative-console.railShift', String(Math.round(railShift)))
        } catch {
          /* storage disabled */
        }
      }, [railShift])

      const expand = () => {
        window.clearTimeout(timerRef.current)
        setAnchor({ top: 64, left: 8, height: Math.max(320, window.innerHeight - 80) })
        setClosing(false)
        setOpen(true)
      }

      const close = () => {
        if (!open || closing) return
        setClosing(true)
        window.clearTimeout(timerRef.current)
        timerRef.current = window.setTimeout(() => {
          setOpen(false)
          setClosing(false)
        }, 230)
      }

      useEffect(
        () => () => {
          window.clearTimeout(timerRef.current)
        },
        [],
      )

      useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          if (rootRef.current?.contains(event.target)) return
          if (event.target?.closest?.('.cc-console')) return
          close()
        }
        const onKey = (event) => {
          if (event.key === 'Escape') close()
        }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [open, closing])

      useEffect(() => {
        const onShortcut = (event) => {
          if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'm') {
            event.preventDefault()
            if (open) close()
            else expand()
          }
        }
        document.addEventListener('keydown', onShortcut)
        return () => document.removeEventListener('keydown', onShortcut)
      }, [open, closing])

      const startRailDrag = (event) => {
        if (event.button !== 0) return
        dragRef.current = { startY: event.clientY, startShift: railShift }
        movedRef.current = false
        setDragging(true)
        event.currentTarget.setPointerCapture?.(event.pointerId)
      }

      const moveRailDrag = (event) => {
        if (!dragRef.current) return
        const delta = dragRef.current.startY - event.clientY
        if (Math.abs(delta) > 3) movedRef.current = true
        setRailShift(clampRailShift(dragRef.current.startShift + delta))
      }

      const endRailDrag = (event) => {
        if (!dragRef.current) return
        dragRef.current = null
        setDragging(false)
        event.currentTarget.releasePointerCapture?.(event.pointerId)
        window.setTimeout(() => {
          movedRef.current = false
        }, 0)
      }

      const content = h(
        'div',
        { className: 'cc-root', ref: rootRef },
        !open
          ? h(
              'button',
              {
                type: 'button',
                className: `cc-rail${dragging ? ' is-dragging' : ''}`,
                style: { '--rail-shift': `${railShift}px` },
                onClick: () => {
                  if (movedRef.current) return
                  expand()
                },
                onPointerDown: startRailDrag,
                onPointerMove: moveRailDrag,
                onPointerUp: endRailDrag,
                onPointerCancel: endRailDrag,
                title: '拖动上下移动 · 点击展开 MuRaSame 创作助手（Ctrl+Shift+M）',
                'aria-label': '展开 MuRaSame 创作助手',
              },
              h('span', { className: 'cc-rail-mark' }, h(Glyph, { name: 'sparkles', size: 14 })),
              h('span', { className: 'cc-rail-text' }, 'MRS'),
              h('span', { className: 'cc-rail-arrow' }, '›'),
            )
          : null,
        open
          ? h(ConsolePanel, {
              anchor,
              closing,
              onClose: close,
              onCollapse: close,
            })
          : null,
      )
      return createPortal ? createPortal(content, document.body) : content
    }

    // ------------------------------------------------------------------ style

    const STYLE = `
.cc-root { display: contents; }
.cc-rail {
  position: fixed; left: 8px; bottom: 112px; z-index: 2147481990;
  width: 36px; height: 180px; padding: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;
  border: 0; border-radius: 13px; cursor: pointer; color: #fff;
  background: linear-gradient(180deg, #2fbf71, #147a57);
  box-shadow: 0 10px 28px rgba(43, 45, 110, .38);
  transform: translateY(calc(-1 * var(--rail-shift, 80px)));
  transition: filter .15s ease, transform .15s ease;
  cursor: grab; touch-action: none; user-select: none;
}
.cc-rail:hover { filter: brightness(1.08); transform: translate(2px, calc(-1 * var(--rail-shift, 80px))); }
.cc-rail.is-dragging { cursor: grabbing; transition: none; }
.cc-rail-mark { display: inline-flex; align-items: center; justify-content: center; opacity: .95; }
.cc-rail-text {
  writing-mode: vertical-rl; text-orientation: mixed;
  letter-spacing: 3px; font-size: 10px; font-weight: 650;
}
.cc-rail-arrow { font-size: 14px; line-height: 1; opacity: .9; }
.cc-console.is-closing { transform: translateX(calc(-100% - 16px)); opacity: .35; }
.cc-launcher {
  display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0;
  padding: 5px 8px; border: 0; border-radius: 7px; cursor: pointer; text-align: left;
  background: transparent; color: var(--dsw-alias-label-tertiary, #9aa0aa);
  font-size: 12px; line-height: 18px;
}
.cc-launcher:hover, .cc-launcher.is-open { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); color: var(--dsw-alias-label-primary, #f3f4f6); }
.cc-launcher-mark {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: 18px; height: 18px; border-radius: 6px;
  color: #fff; background: linear-gradient(135deg, #2fbf71, #1d9663);
  box-shadow: 0 2px 8px rgba(88, 92, 255, .32);
}
.cc-launcher-body { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; }
.cc-launcher-body b { font-size: 12px; font-weight: 600; line-height: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cc-launcher-body small { font-size: 10px; line-height: 13px; color: var(--dsw-alias-label-tertiary, #9aa0aa); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cc-console {
  position: fixed; z-index: 2147482000; width: 328px; max-width: calc(100vw - 16px);
  display: flex; flex-direction: column; overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.12));
  border-radius: 14px;
  background: var(--dsw-alias-bg-layer-1, #1b1c20);
  color: var(--dsw-alias-label-primary, #f3f4f6);
  box-shadow: 0 18px 60px rgba(0,0,0,.38), 0 2px 10px rgba(0,0,0,.22);
  font-size: 12px;
  transition: transform .22s cubic-bezier(.2,.8,.2,1), box-shadow .22s ease;
  transform-origin: left center;
  animation: cc-panel-in .2s ease-out;
}
@keyframes cc-panel-in { from { opacity: 0; transform: translateX(-12px); } to { opacity: 1; transform: none; } }
.cc-header {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 12px 12px 9px;
  background:
    radial-gradient(120% 130% at 8% 0%, rgba(47,191,113,.20), transparent 54%),
    radial-gradient(100% 120% at 95% 8%, rgba(74,168,255,.14), transparent 60%);
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.09));
}
.cc-header-main { display: flex; align-items: center; gap: 9px; min-width: 0; }
.cc-logo {
  width: 30px; height: 30px; border-radius: 10px; flex: none;
  display: inline-flex; align-items: center; justify-content: center; color: #fff;
  background: linear-gradient(135deg, #2fbf71, #1d9663);
  box-shadow: 0 5px 16px rgba(47, 191, 113, .35);
  overflow: hidden;
}
.cc-logo img { width: 100%; height: 100%; object-fit: cover; display: block; border-radius: inherit; }
.cc-header-text { display: flex; flex-direction: column; min-width: 0; }
.cc-header-text b { font-size: 14px; line-height: 19px; letter-spacing: .2px; }
.cc-header-text span { font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-tertiary, #9aa0aa); }
.cc-header-actions { display: flex; align-items: center; gap: 4px; }
.cc-header-icon {
  width: 28px; height: 28px; border-radius: 8px; border: 0; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--dsw-alias-label-tertiary, #9aa0aa); background: transparent;
}
.cc-header-icon:hover, .cc-header-icon.is-active { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14)); color: var(--dsw-alias-label-primary, #f3f4f6); }
.cc-collapse {
  display: inline-flex; align-items: center; gap: 2px; padding: 5px 6px 5px 8px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.12)); border-radius: 8px;
  background: rgba(127,127,127,.06); color: var(--dsw-alias-label-secondary, #c5c9d2);
  cursor: pointer; font-size: 11px;
}
.cc-collapse:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14)); color: var(--dsw-alias-label-primary, #f3f4f6); }
.cc-subhead { display: flex; align-items: center; justify-content: space-between; padding: 7px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.07)); }
.cc-engines { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.cc-engine { display: inline-flex; align-items: center; gap: 4px; color: var(--dsw-alias-label-tertiary, #858b96); font-size: 10px; }
.cc-engine i { width: 5px; height: 5px; border-radius: 50%; background: var(--dsw-alias-state-error-primary, #ff5c5c); box-shadow: 0 0 0 2px rgba(255,92,92,.10); }
.cc-engine.is-ready { color: var(--dsw-alias-label-secondary, #b9bec8); }
.cc-engine.is-ready i { background: var(--dsw-alias-state-success-primary, #39c07a); box-shadow: 0 0 0 2px rgba(57,192,122,.12); }
.cc-refresh { border: 0; background: transparent; color: var(--dsw-alias-label-tertiary, #858b96); cursor: pointer; padding: 2px; border-radius: 5px; }
.cc-refresh:hover { color: var(--dsw-alias-label-primary, #f3f4f6); background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14)); }
.cc-tabs { display: flex; gap: 4px; padding: 7px 10px 0; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.07)); }
.cc-tab {
  flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  padding: 7px 6px 8px; border: 0; border-bottom: 2px solid transparent; cursor: pointer;
  background: transparent; color: var(--dsw-alias-label-tertiary, #8e949f); font-size: 11px;
}
.cc-tab:hover { color: var(--dsw-alias-label-primary, #f3f4f6); }
.cc-tab.is-active { color: var(--dsw-alias-label-primary, #f3f4f6); border-bottom-color: #2fbf71; }
.cc-body { overflow-y: auto; overscroll-behavior: contain; flex: 1 1 auto; min-height: 0; }
.cc-image-shell { display: flex; flex-direction: column; min-height: 0; }
.cc-mode-switch { display: flex; gap: 5px; padding: 10px 12px 0; }
.cc-mode {
  flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  padding: 6px 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.12)); border-radius: 8px;
  background: rgba(127,127,127,.04); color: var(--dsw-alias-label-tertiary, #8e949f);
  cursor: pointer; font: inherit; font-size: 11px;
}
.cc-mode:hover { color: var(--dsw-alias-label-primary, #f3f4f6); background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); }
.cc-mode.is-active { color: #fff; border-color: transparent; background: linear-gradient(135deg, #2fbf71, #147a57); box-shadow: 0 3px 12px rgba(88,92,255,.24); }
.cc-panel { padding: 12px; display: flex; flex-direction: column; gap: 11px; }
.cc-section-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.cc-section-head h3 { margin: 0; font-size: 13px; line-height: 18px; font-weight: 650; letter-spacing: .1px; }
.cc-section-head p { margin: 2px 0 0; color: var(--dsw-alias-label-tertiary, #8e949f); font-size: 10px; line-height: 15px; }
.cc-path-row { display: flex; gap: 6px; }
.cc-input {
  width: 100%; min-width: 0; box-sizing: border-box; padding: 6px 8px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.13)); border-radius: 7px;
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.06));
  color: var(--dsw-alias-label-primary, #f3f4f6); font: inherit; font-size: 11px; outline: none;
}
.cc-input:focus { border-color: rgba(47,191,113,.7); box-shadow: 0 0 0 2px rgba(47,191,113,.14); }
.cc-mono { font-family: ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace; font-size: 10px; }
.cc-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  padding: 6px 10px; border-radius: 7px; border: 1px solid transparent;
  cursor: pointer; font: inherit; font-size: 11px; white-space: nowrap; text-decoration: none;
}
.cc-btn:disabled { opacity: .45; cursor: not-allowed; }
.cc-btn-solid { border-color: var(--dsw-alias-border-l1, rgba(255,255,255,.14)); background: rgba(127,127,127,.10); color: var(--dsw-alias-label-primary, #f3f4f6); }
.cc-btn-solid:hover:not(:disabled) { background: rgba(127,127,127,.18); }
.cc-btn-primary {
  border: 0; color: #fff;
  background: linear-gradient(135deg, #2fbf71, #147a57);
  box-shadow: 0 4px 14px rgba(88, 92, 255, .28);
}
.cc-btn-primary:hover:not(:disabled) { filter: brightness(1.07); }
.cc-btn-ghost { border-color: transparent; background: transparent; color: var(--dsw-alias-label-secondary, #c5c9d2); padding: 5px 7px; }
.cc-btn-ghost:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); color: var(--dsw-alias-label-primary, #f3f4f6); }
.cc-btn-wide { flex: 1; padding: 8px 10px; }
.cc-action-row { display: flex; gap: 6px; align-items: center; }
.cc-note { padding: 7px 9px; border-radius: 7px; font-size: 10px; line-height: 15px; color: var(--dsw-alias-label-tertiary, #8e949f); background: rgba(127,127,127,.06); border: 1px solid transparent; }
.cc-note.is-warn { color: var(--dsw-alias-state-warn-label, #e7a63b); border-color: rgba(231,166,59,.28); background: rgba(231,166,59,.06); }
.cc-note.is-ok { color: var(--dsw-alias-state-success-primary, #39c07a); border-color: rgba(57,192,122,.26); background: rgba(57,192,122,.06); }
.cc-error { display: flex; gap: 6px; padding: 6px 8px; border-radius: 7px; font-size: 10px; line-height: 15px; color: var(--dsw-alias-state-error-primary, #ff6b6b); background: rgba(255,92,92,.07); border: 1px solid rgba(255,92,92,.22); }
.cc-error span { font-weight: 700; }
.cc-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px; padding: 22px 12px; border: 1px dashed var(--dsw-alias-border-l2, rgba(255,255,255,.14)); border-radius: 10px; color: var(--dsw-alias-label-tertiary, #858b96); text-align: center; }
.cc-empty b { color: var(--dsw-alias-label-secondary, #b9bec8); font-weight: 600; font-size: 11px; }
.cc-empty span { font-size: 10px; line-height: 15px; }
.cc-image-card { display: flex; gap: 10px; align-items: stretch; border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.1)); border-radius: 10px; padding: 8px; background: rgba(127,127,127,.04); }
.cc-image-preview { width: 118px; height: 88px; object-fit: contain; border-radius: 7px; background: rgba(0,0,0,.16); flex: none; }
.cc-image-meta { display: flex; flex-direction: column; justify-content: space-between; min-width: 0; flex: 1; }
.cc-image-meta > div:first-child { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.cc-image-meta b { font-size: 10px; color: var(--dsw-alias-label-tertiary, #8e949f); font-weight: 500; }
.cc-image-meta span { font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cc-image-saved { font-size: 10px; color: var(--dsw-alias-state-success-primary, #39c07a); }
.cc-image-saved strong { font-size: 16px; font-weight: 700; margin-right: 3px; }
.cc-image-saved.is-muted { color: var(--dsw-alias-label-tertiary, #8e949f); }
.cc-block { display: flex; flex-direction: column; gap: 7px; padding-top: 9px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.07)); }
.cc-block-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--dsw-alias-label-secondary, #c5c9d2); font-size: 10px; font-weight: 600; letter-spacing: .2px; }
.cc-block-title span { color: var(--dsw-alias-label-tertiary, #8e949f); font-weight: 400; font-variant-numeric: tabular-nums; }
.cc-chip-row { display: flex; flex-wrap: wrap; gap: 5px; }
.cc-chip {
  padding: 4px 8px; border-radius: 999px; cursor: pointer; font: inherit; font-size: 10px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.12)); background: transparent;
  color: var(--dsw-alias-label-secondary, #b9bec8);
}
.cc-chip:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); color: var(--dsw-alias-label-primary, #f3f4f6); }
.cc-chip.is-active { color: #fff; border-color: transparent; background: linear-gradient(135deg, #2fbf71, #147a57); }
.cc-chip-tall { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; border-radius: 8px; padding: 5px 8px; text-align: left; }
.cc-chip-tall b { font-size: 10px; font-weight: 600; }
.cc-chip-tall span { font-size: 9px; opacity: .72; }
.cc-size-chip { display: flex; flex-direction: column; align-items: center; gap: 0; padding: 4px 9px; border-radius: 7px; }
.cc-size-chip b { font-size: 10px; }
.cc-size-chip span { font-size: 8px; opacity: .7; }
.cc-count-row { display: flex; gap: 4px; }
.cc-count {
  border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.12)); border-radius: 6px;
  padding: 3px 8px; background: transparent; color: var(--dsw-alias-label-secondary, #c5c9d2);
  cursor: pointer; font: inherit; font-size: 9px;
}
.cc-count.is-active { border-color: rgba(47,191,113,.6); background: rgba(47,191,113,.13); color: #bff5c5; }
.cc-prompt { min-height: 96px; }
.cc-gen-progress { position: relative; height: 4px; border-radius: 999px; overflow: hidden; background: rgba(127,127,127,.16); }
.cc-gen-progress i { position: absolute; inset: 0; width: 34%; border-radius: inherit; background: linear-gradient(90deg, transparent, #6bdd8d, transparent); animation: cc-gen-sweep 1.25s ease-in-out infinite; }
.cc-gen-progress span { display: block; margin-top: 5px; font-size: 9px; color: var(--dsw-alias-label-tertiary, #8e949f); }
@keyframes cc-gen-sweep { 0% { transform: translateX(-100%); } 100% { transform: translateX(330%); } }
.cc-gen-results { display: flex; flex-direction: column; gap: 8px; border: 1px solid rgba(47,191,113,.26); border-radius: 10px; padding: 8px; background: rgba(47,191,113,.045); }
.cc-gen-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
.cc-gen-card { overflow: hidden; border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.1)); border-radius: 8px; background: rgba(0,0,0,.14); }
.cc-gen-card img { display: block; width: 100%; aspect-ratio: 1.35; object-fit: cover; }
.cc-gen-card-body { display: flex; flex-direction: column; gap: 4px; padding: 5px; }
.cc-gen-card-meta { display: flex; align-items: center; justify-content: space-between; gap: 4px; font-size: 8px; color: var(--dsw-alias-label-tertiary, #8e949f); font-variant-numeric: tabular-nums; }
.cc-gen-actions { display: flex; align-items: center; gap: 2px; }
.cc-gen-actions .cc-btn { padding: 4px 5px; font-size: 9px; }
.cc-gen-actions .cc-btn-ghost { padding: 4px; }
.cc-key-row { display: flex; gap: 6px; }
.cc-inline-link { border: 0; background: transparent; color: #a8f0b0; cursor: pointer; font: inherit; font-size: 10px; margin-left: 5px; text-decoration: underline; padding: 0; }
.cc-pill.is-free { color: var(--dsw-alias-state-success-primary, #39c07a); border-color: rgba(57,192,122,.3); background: rgba(57,192,122,.08); }
.cc-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.cc-field { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.cc-field-label { display: flex; align-items: baseline; justify-content: space-between; font-size: 10px; color: var(--dsw-alias-label-tertiary, #8e949f); }
.cc-field-label small { font-size: 9px; opacity: .8; }
.cc-slider-row { display: grid; grid-template-columns: 34px 1fr 54px; align-items: center; gap: 6px; }
.cc-slider-row span { font-size: 10px; color: var(--dsw-alias-label-tertiary, #8e949f); }
.cc-slider-row b { font-size: 10px; text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary, #b9bec8); }
.cc-slider-row input[type='range'] { width: 100%; accent-color: #2fbf71; height: 4px; }
.cc-slider-stack { display: flex; flex-direction: column; gap: 5px; }
.cc-toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.cc-switch { display: inline-flex; align-items: center; gap: 5px; font-size: 10px; color: var(--dsw-alias-label-tertiary, #8e949f); cursor: pointer; }
.cc-switch input { display: none; }
.cc-switch span { width: 24px; height: 14px; border-radius: 999px; background: rgba(127,127,127,.25); position: relative; transition: background .15s; flex: none; }
.cc-switch span::after { content: ''; position: absolute; width: 10px; height: 10px; left: 2px; top: 2px; border-radius: 50%; background: #fff; transition: transform .15s; }
.cc-switch input:checked + span { background: #1f9d63; }
.cc-switch input:checked + span::after { transform: translateX(10px); }
.cc-result, .cc-tts-result { border: 1px solid rgba(47,191,113,.28); border-radius: 9px; padding: 8px; background: rgba(47,191,113,.055); display: flex; flex-direction: column; gap: 6px; }
.cc-premiere-result { border: 1px solid rgba(20,122,87,.28); border-radius: 9px; padding: 8px; background: rgba(20,122,87,.05); display: flex; flex-direction: column; gap: 6px; }
.cc-result-head { display: flex; align-items: center; gap: 5px; color: var(--dsw-alias-label-primary, #f3f4f6); font-size: 10px; }
.cc-result-head span { margin-left: auto; color: var(--dsw-alias-label-tertiary, #8e949f); font-size: 9px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cc-result-path { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 9px; color: var(--dsw-alias-label-tertiary, #8e949f); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cc-result-actions { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.cc-video-card { display: flex; gap: 9px; align-items: center; border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.1)); border-radius: 9px; padding: 7px; background: rgba(127,127,127,.04); }
.cc-video-preview { width: 112px; height: 68px; border-radius: 6px; object-fit: cover; background: rgba(0,0,0,.2); flex: none; }
.cc-video-preview.is-empty { display: flex; align-items: center; justify-content: center; color: var(--dsw-alias-label-tertiary, #8e949f); }
.cc-video-meta { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.cc-video-meta b { font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cc-video-meta span { font-size: 10px; color: var(--dsw-alias-label-tertiary, #8e949f); }
.cc-clip-editor { display: grid; grid-template-columns: 1fr 1fr auto; gap: 6px; align-items: end; }
.cc-ai-cut { border-color: rgba(47,191,113,.28); background: linear-gradient(180deg, rgba(47,191,113,.055), rgba(20,122,87,.025)); }
.cc-custom-voice { border-color: rgba(57,192,122,.22); background: rgba(57,192,122,.035); }
.cc-custom-voice-actions { display: flex; gap: 6px; }
.cc-custom-voice-actions .cc-btn { flex: 1; justify-content: center; }
.cc-custom-save { display: flex; gap: 5px; margin-top: 6px; }
.cc-custom-save .cc-input { flex: 1; min-width: 0; }
.cc-audio-player { width: 100%; height: 30px; margin: 6px 0; }
.cc-btn-danger { background: rgba(220,80,90,.18); border-color: rgba(220,80,90,.35); color: #ff9aa2; }
.cc-ai-cut-copy { font-size: 10px; line-height: 1.5; color: var(--dsw-alias-label-tertiary, #8e949f); margin: -2px 0 6px; }
.cc-ai-cut-options { display: grid; grid-template-columns: 1fr; gap: 6px; margin-top: 6px; }
.cc-ai-cut-options .cc-btn-wide { justify-content: center; }
.cc-ai-cut-config { display: flex; flex-direction: column; gap: 6px; margin-top: 7px; }
.cc-plan { margin-top: 8px; border: 1px solid rgba(47,191,113,.3); border-radius: 9px; padding: 8px; background: rgba(10,12,18,.38); }
.cc-plan-head { display: flex; flex-direction: column; gap: 3px; padding-bottom: 6px; border-bottom: 1px solid rgba(255,255,255,.08); }
.cc-plan-head b { font-size: 10px; line-height: 1.45; }
.cc-plan-head span { font-size: 9px; color: var(--dsw-alias-label-tertiary, #8e949f); }
.cc-plan-segments { display: flex; flex-direction: column; gap: 4px; padding: 6px 0; }
.cc-plan-segment { display: grid; grid-template-columns: 14px 92px 1fr 14px; gap: 4px; align-items: start; font-size: 9px; line-height: 1.4; }
.cc-plan-time { display: flex; align-items: center; gap: 2px; }
.cc-plan-time .cc-input { width: 40px; padding: 2px 3px; font-size: 8px; text-align: center; }
.cc-plan-segment b { color: #a8f0b0; }
.cc-plan-segment span { color: #b8f0c8; white-space: nowrap; }
.cc-plan-segment em { font-style: normal; color: var(--dsw-alias-label-tertiary, #8e949f); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.cc-plan-remove { border: 0; background: transparent; color: #8e949f; cursor: pointer; font-size: 13px; line-height: 1; padding: 0; }
.cc-plan-remove:hover { color: #ff9aa2; }
.cc-plan-actions { display: flex; gap: 5px; flex-wrap: wrap; }
.cc-plan-actions .cc-btn { flex: 1 1 auto; justify-content: center; }
.cc-clip-add { padding: 6px 9px; }
.cc-inline-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.cc-inline-actions span { font-size: 10px; color: var(--dsw-alias-label-tertiary, #8e949f); }
.cc-timeline-empty { padding: 10px; border: 1px dashed var(--dsw-alias-border-l1, rgba(255,255,255,.12)); border-radius: 7px; font-size: 10px; color: var(--dsw-alias-label-tertiary, #8e949f); text-align: center; }
.cc-clip-list { display: flex; flex-direction: column; gap: 4px; }
.cc-clip { display: flex; align-items: center; gap: 5px; padding: 5px 6px; border-radius: 7px; background: rgba(127,127,127,.055); border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.07)); }
.cc-clip-index { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border-radius: 5px; background: rgba(47,191,113,.16); color: #a8f0b0; font-size: 9px; font-weight: 700; flex: none; }
.cc-clip-body { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.cc-clip-body b { font-size: 10px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cc-clip-body span { font-size: 9px; color: var(--dsw-alias-label-tertiary, #8e949f); font-variant-numeric: tabular-nums; }
.cc-icon-btn { width: 20px; height: 20px; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 5px; background: transparent; color: var(--dsw-alias-label-tertiary, #8e949f); cursor: pointer; flex: none; }
.cc-icon-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14)); color: var(--dsw-alias-label-primary, #f3f4f6); }
.cc-icon-btn:disabled { opacity: .25; cursor: default; }
.cc-icon-btn.is-danger:hover { color: var(--dsw-alias-state-error-primary, #ff6b6b); }
.cc-audio-attach { display: flex; align-items: center; gap: 6px; padding: 7px; border-radius: 8px; border: 1px solid rgba(57,192,122,.24); background: rgba(57,192,122,.055); }
.cc-audio-attach-body { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.cc-audio-attach-body b { font-size: 10px; color: var(--dsw-alias-state-success-primary, #39c07a); }
.cc-audio-attach-body span { font-size: 9px; color: var(--dsw-alias-label-tertiary, #8e949f); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cc-audio-attach select { width: 82px; flex: none; }
.cc-subtitle-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 5px 7px; border-radius: 7px; background: rgba(127,127,127,.045); }
.cc-subtitle-block { gap: 8px; }
.cc-subtitle-result { display: flex; flex-direction: column; gap: 6px; border: 1px solid rgba(20,122,87,.28); border-radius: 9px; padding: 8px; background: rgba(20,122,87,.05); }
.cc-job { display: flex; flex-direction: column; gap: 6px; border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.1)); border-radius: 8px; padding: 8px; }
.cc-job.is-done { border-color: rgba(57,192,122,.3); background: rgba(57,192,122,.045); }
.cc-job.is-error { border-color: rgba(255,92,92,.3); background: rgba(255,92,92,.045); }
.cc-job-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 10px; }
.cc-job-head span { color: var(--dsw-alias-label-tertiary, #8e949f); font-variant-numeric: tabular-nums; }
.cc-progress { height: 4px; border-radius: 999px; background: rgba(127,127,127,.18); overflow: hidden; }
.cc-progress i { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #2fbf71, #147a57); transition: width .3s ease; }
.cc-job-result { display: flex; flex-direction: column; gap: 6px; }
.cc-video-result { width: 100%; max-height: 210px; border-radius: 7px; background: #000; }
.cc-voice-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; max-height: 190px; overflow-y: auto; padding-right: 2px; }
.cc-voice { display: flex; align-items: center; gap: 6px; padding: 5px 6px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.08)); background: transparent; color: var(--dsw-alias-label-secondary, #c5c9d2); cursor: pointer; text-align: left; min-width: 0; }
.cc-voice:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.1)); }
.cc-voice.is-active { border-color: rgba(47,191,113,.6); background: rgba(47,191,113,.1); color: var(--dsw-alias-label-primary, #f3f4f6); }
.cc-voice-avatar { width: 22px; height: 22px; border-radius: 7px; flex: none; display: inline-flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 600; color: #fff; background: linear-gradient(135deg, #2fbf71, #2a9a61); }
.cc-voice-avatar.is-male { background: linear-gradient(135deg, #147a57, #2bbf8a); }
.cc-voice-body { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.cc-voice-body b { font-size: 10px; line-height: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cc-voice-body small { font-size: 8px; line-height: 11px; color: var(--dsw-alias-label-tertiary, #8e949f); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cc-voice-check { font-style: normal; font-size: 10px; color: #a8f0b0; }
.cc-search { margin-bottom: 1px; }
.cc-preset-desc { font-size: 9px; line-height: 14px; color: var(--dsw-alias-label-tertiary, #8e949f); }
.cc-textarea { width: 100%; box-sizing: border-box; resize: vertical; min-height: 78px; padding: 7px 8px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.13)); background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.06)); color: var(--dsw-alias-label-primary, #f3f4f6); font: inherit; font-size: 11px; line-height: 17px; outline: none; }
.cc-textarea:focus { border-color: rgba(47,191,113,.7); box-shadow: 0 0 0 2px rgba(47,191,113,.14); }
.cc-audio { width: 100%; height: 30px; }
.cc-audio-meta { display: flex; align-items: center; gap: 8px; font-size: 9px; color: var(--dsw-alias-label-tertiary, #8e949f); min-width: 0; }
.cc-audio-meta span:last-child { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cc-tip { font-size: 9px; line-height: 14px; color: var(--dsw-alias-label-tertiary, #8e949f); padding: 6px 8px; border-radius: 6px; background: rgba(127,127,127,.045); }
.cc-pill { color: #a8f0b0; border: 1px solid rgba(47,191,113,.3); background: rgba(47,191,113,.08); border-radius: 999px; padding: 2px 7px; font-size: 9px; white-space: nowrap; }
.cc-cover-result { display: flex; align-items: center; gap: 8px; padding: 7px; border: 1px solid rgba(47,191,113,.24); border-radius: 9px; background: rgba(47,191,113,.04); }
.cc-cover-result img { width: 96px; height: 58px; object-fit: cover; border-radius: 6px; background: #000; flex: none; }
.cc-cover-body { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.cc-cover-body b { font-size: 10px; }
.cc-cover-body > span { font-size: 9px; color: var(--dsw-alias-label-tertiary, #8e949f); }
.cc-cover-body .cc-result-actions { gap: 2px; }
.cc-upscale-block { gap: 8px; }
.cc-upscale-result { display: flex; gap: 8px; align-items: center; border: 1px solid rgba(47,191,113,.26); border-radius: 9px; padding: 7px; background: rgba(47,191,113,.045); }
.cc-upscale-result > img { width: 108px; height: 88px; object-fit: contain; border-radius: 6px; background: rgba(0,0,0,.18); flex: none; }
.cc-upscale-body { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.cc-upscale-body b { font-size: 10px; }
.cc-upscale-body span { font-size: 9px; color: var(--dsw-alias-label-tertiary, #8e949f); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cc-upscale-body .cc-result-actions { gap: 2px; margin-top: 2px; }
.cc-settings { display: flex; flex-direction: column; gap: 10px; }
.cc-settings-scroll { display: flex; flex-direction: column; gap: 9px; }
.cc-settings-topline { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.cc-settings-topline > span { font-size: 11px; font-weight: 650; color: var(--dsw-alias-label-secondary, #c4c8d2); }
.cc-settings-more {
  display: inline-flex; align-items: center; gap: 3px; border: 0; background: transparent;
  color: var(--dsw-alias-label-tertiary, #8e949f); font-size: 10px; cursor: pointer; padding: 3px 0;
}
.cc-settings-more:hover { color: var(--dsw-alias-label-primary, #f3f4f6); }
.cc-settings-more.is-open { color: #a8f0b0; }
.cc-settings-card {
  border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.1));
  border-radius: 10px; padding: 9px; display: flex; flex-direction: column; gap: 7px;
  background: rgba(127,127,127,.025);
}
.cc-settings-card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.cc-settings-card-head b { font-size: 12px; font-weight: 650; }
.cc-settings-badge { font-size: 9px; padding: 1px 6px; border-radius: 999px; border: 1px solid rgba(127,127,127,.25); color: var(--dsw-alias-label-tertiary, #8e949f); }
.cc-settings-badge.is-ok { color: #39c07a; border-color: rgba(57,192,122,.3); background: rgba(57,192,122,.07); }
.cc-settings-badge.is-warn { color: #e7b45a; border-color: rgba(231,180,90,.3); background: rgba(231,180,90,.07); }
.cc-settings-note { font-size: 9px; line-height: 14px; color: var(--dsw-alias-label-tertiary, #8e949f); }
.cc-settings-free { display: flex; flex-direction: column; align-items: flex-start; gap: 5px; }
.cc-settings-free .cc-btn { font-size: 10px; padding: 4px 7px; }
.cc-settings-advanced { display: flex; flex-direction: column; gap: 7px; padding-top: 7px; border-top: 1px dashed rgba(255,255,255,.09); }
.cc-engine-list { display: flex; flex-wrap: wrap; gap: 5px; }
.cc-engine-pill { display: inline-flex; align-items: center; gap: 4px; font-size: 9px; color: var(--dsw-alias-label-tertiary, #8e949f); border: 1px solid rgba(127,127,127,.2); border-radius: 999px; padding: 2px 6px; }
.cc-engine-pill i { width: 5px; height: 5px; border-radius: 50%; background: #777d8a; }
.cc-engine-pill.is-ok i { background: #39c07a; }
.cc-engine-pill.is-warn i { background: #e7b45a; }
.cc-settings-save { position: sticky; bottom: 0; z-index: 2; display: flex; flex-direction: column; gap: 4px; padding-top: 6px; background: var(--dsw-alias-bg-layer-1, #1b1c20); }
.cc-settings-save > span { text-align: center; font-size: 9px; color: var(--dsw-alias-label-tertiary, #8e949f); }
.cc-credit { text-align: center; font-size: 9px; color: var(--dsw-alias-label-tertiary, #7f8795); padding: 2px 0 1px; }
.cc-test-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.cc-test-row .cc-btn { font-size: 10px; padding: 3px 7px; }
.cc-test-row span { font-size: 9px; color: var(--dsw-alias-state-success-primary, #39c07a); line-height: 13px; }
.cc-block-title-actions { align-items: center; }
.cc-block-title-actions > span:first-child { flex: 1; }
.cc-undo { font-size: 9px; padding: 2px 6px; }
.cc-ai-transcript { margin-top: 6px; }
.cc-ai-transcript summary { cursor: pointer; font-size: 9px; color: var(--dsw-alias-label-tertiary, #8e949f); padding: 2px 0; }
.cc-ai-transcript[open] summary { color: #a8f0b0; margin-bottom: 4px; }
.cc-transcribe-row { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; margin-top: 5px; }
.cc-transcribe-row .cc-btn { font-size: 9px; padding: 3px 6px; }
.cc-transcribe-row span { font-size: 8px; color: var(--dsw-alias-label-tertiary, #8e949f); }
.cc-custom-preset-edit { display: flex; gap: 4px; margin-top: 5px; }
.cc-custom-preset-edit .cc-input { flex: 1; min-width: 0; }
.cc-custom-preset-edit .cc-btn { font-size: 9px; padding: 3px 6px; }
.cc-recent-list { display: flex; flex-direction: column; gap: 7px; }
.cc-recent-item { display: flex; gap: 8px; align-items: center; border: 1px solid rgba(127,127,127,.16); border-radius: 9px; padding: 7px; background: rgba(127,127,127,.025); }
.cc-recent-thumb { width: 56px; height: 56px; border-radius: 7px; overflow: hidden; flex: none; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.18); color: #a8f0b0; }
.cc-recent-thumb img { width: 100%; height: 100%; object-fit: cover; }
.cc-recent-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.cc-recent-body b { font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cc-recent-body span { font-size: 9px; color: var(--dsw-alias-label-tertiary, #8e949f); }
.cc-recent-body code { font-size: 8px; color: #8f989f; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cc-recent-body .cc-result-actions { gap: 2px; margin-top: 2px; }
.cc-project-bar { display: flex; flex-direction: column; gap: 5px; border: 1px solid rgba(127,127,127,.14); border-radius: 9px; padding: 7px; background: rgba(127,127,127,.025); }
.cc-project-bar .cc-input { font-size: 9px; padding: 4px 6px; }
.cc-project-bar .cc-btn { justify-content: center; font-size: 9px; padding: 4px; }
.cc-project-items { display: flex; flex-direction: column; gap: 4px; border-top: 1px solid rgba(255,255,255,.08); padding-top: 7px; }
.cc-project-item { display: flex; align-items: center; gap: 5px; font-size: 9px; color: var(--dsw-alias-label-tertiary, #8e949f); }
.cc-project-item > span { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cc-project-item .cc-icon-btn { width: 20px; height: 20px; }
.cc-toolview { border: 1px solid rgba(47,191,113,.3); border-radius: 10px; background: rgba(47,191,113,.045); margin: 4px 0 4px 4px; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.cc-toolview.is-error { border-color: rgba(255,107,107,.35); background: rgba(255,107,107,.045); }
.cc-toolview-head { display: flex; align-items: center; gap: 5px; font-size: 11px; }
.cc-toolview-mark { width: 20px; height: 20px; border-radius: 6px; background: linear-gradient(135deg, #2fbf71, #147a57); color: #fff; display: inline-flex; align-items: center; justify-content: center; flex: none; }
.cc-toolview-name { color: var(--dsw-alias-label-tertiary, #8e949f); font-size: 9px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.cc-toolview-state { font-size: 9px; padding: 1px 6px; border-radius: 999px; background: rgba(127,127,127,.12); }
.cc-toolview-state.is-running { color: #e7b45a; } .cc-toolview-state.is-ok { color: #39c07a; } .cc-toolview-state.is-error { color: #ff9aa2; }
.cc-toolview-progress { height: 2px; border-radius: 2px; background: rgba(127,127,127,.14); overflow: hidden; }
.cc-toolview-progress i { display: block; width: 35%; height: 100%; background: linear-gradient(90deg, #2fbf71, #a8f0b0); animation: cc-tool-progress 1.1s ease-in-out infinite; }
@keyframes cc-tool-progress { from { transform: translateX(-100%); } to { transform: translateX(300%); } }
.cc-toolview-text { font-size: 10px; line-height: 15px; color: var(--dsw-alias-label-secondary, #c5c9d2); white-space: pre-wrap; word-break: break-word; max-height: 90px; overflow: auto; }
.cc-toolview-actions { display: flex; gap: 4px; flex-wrap: wrap; }
.cc-toolview-actions .cc-btn { font-size: 9px; padding: 3px 7px; }
.cc-loading { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; min-height: 210px; padding: 20px; color: var(--dsw-alias-label-tertiary, #8e949f); text-align: center; font-size: 11px; }
.cc-loading.is-error b { color: var(--dsw-alias-state-error-primary, #ff6b6b); }
.cc-loading.is-error span { max-width: 300px; line-height: 16px; word-break: break-word; }
.cc-spinner { width: 12px; height: 12px; border-radius: 50%; border: 2px solid rgba(127,127,127,.28); border-top-color: #6bdd8d; display: inline-block; animation: cc-spin .7s linear infinite; flex: none; }
.cc-footer { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 6px 10px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.07)); font-size: 9px; color: var(--dsw-alias-label-tertiary, #8e949f); background: rgba(127,127,127,.025); }
.cc-footer-path { flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cc-footer-actions { display: flex; align-items: center; gap: 4px; flex: none; }
.cc-footer-open { display: inline-flex; align-items: center; gap: 3px; border: 0; background: transparent; color: #a8f0b0; font-size: 9px; padding: 2px 4px; border-radius: 4px; cursor: pointer; white-space: nowrap; }
.cc-footer-open:hover { background: rgba(47,191,113,.12); color: #c8f5d2; }
.cc-footer-open:disabled { opacity: .5; cursor: default; }
.cc-footer-chip { color: var(--dsw-alias-state-success-primary, #39c07a); flex: none; }
@keyframes cc-spin { to { transform: rotate(360deg); } }
@media (max-width: 520px) {
  .cc-console { width: calc(100vw - 16px); left: 8px !important; }
}
@media (prefers-reduced-motion: reduce) {
  .cc-spinner { animation: none; }
  .cc-progress i { transition: none; }
  .cc-console { transition: none; }
  .cc-gen-progress i { animation: none; }
}
`

    function apply(ctx) {
      const style = document.createElement('style')
      style.dataset.pluginCss = 'dsh-creative-console'
      style.textContent = STYLE
      document.head.appendChild(style)
      ctx.effect(() => () => style.remove(), 'creative-console: styles')

      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          {
            name: 'sidebar.footer.action',
            id: 'dsh-creative-console.launcher',
            order: 140,
          },
          Launcher,
        ),
      )

      ctx.slots.inject('tool.call.toolview', function* () {
        for (const key of [
          'creative_image_generate',
          'creative_image_upscale',
          'creative_image_optimize',
          'creative_video_plan',
          'creative_video_transcribe',
          'creative_video_export',
          'creative_voice_generate',
          'creative_subtitle_apply',
        ]) {
          yield ctx.slots.register({ name: 'tool.call.toolview', key }, CreativeToolCard)
        }
      })
    }

    const exported = {}
    exported.inject = ['slots']
    exported.apply = apply
    return exported
  },
})
