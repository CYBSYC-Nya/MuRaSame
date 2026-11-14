/**
 * dsh-creative-console — host half.
 *
 * One local HTTP surface for the sidebar console:
 *   POST /api-ext/creative-console/status
 *   POST /api-ext/creative-console/image/inspect
 *   POST /api-ext/creative-console/image/optimize
 *   POST /api-ext/creative-console/video/inspect
 *   POST /api-ext/creative-console/video/export
 *   POST /api-ext/creative-console/tts
 *   POST /api-ext/creative-console/upload
 *   POST /api-ext/creative-console/job/status
 *   GET  /api-ext/creative-console/asset/:id
 *
 * Everything runs locally: Pillow for still images, ffmpeg for clips and voice
 * shaping, edge-tts for neural voices. No API key is read or stored.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { constants as fsConstants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'creative-console'

export const inject = ['webServer', 'workspaceRegistry', 'tools']

const PREFIX = '/api-ext/creative-console'
const VERSION = '1.23.0'
const MAX_JSON_BODY = 8 * 1024 * 1024
const MAX_UPLOAD_BODY = 96 * 1024 * 1024
const WORKER = fileURLToPath(new URL('./lib/image_worker.py', import.meta.url))
const PLUGIN_DIR = dirname(dirname(WORKER))

const DEFAULTS = {
  ffmpegPath: '',
  pythonPath: '',
  edgeTtsPath: '',
  rvcCommand: '',
  rvcPitch: 0,
  imageProvider: 'pollinations',
  imageBaseURL: '',
  imageModel: '',
  imageModels: '',
  imageApiKeyEnv: 'OPENAI_API_KEY',
  imageSize: '1024x1024',
  imageQuality: '',
  imageTimeoutMs: 180000,
  llmBaseURL: 'https://api.openai.com/v1',
  llmModel: 'gpt-4o-mini',
  llmApiKeyEnv: 'OPENAI_API_KEY',
  llmProvider: 'openai',
  llmProtocol: 'auto',
  llmTimeoutMs: 180000,
  asrBaseURL: 'https://api.openai.com/v1',
  asrModel: 'whisper-1',
  asrApiKeyEnv: 'OPENAI_API_KEY',
  asrTimeoutMs: 300000,
  upscalerPath: '',
  upscalerModel: 'realesrgan-x4plus',
  upscalerGpu: '0',
}

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.srt': 'application/x-subrip',
  '.xml': 'application/xml',
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.bmp'])
const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi'])
const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.flac'])

const VOICES = [
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓', gender: 'female', locale: 'zh-CN', tags: ['温暖', '通用'], desc: '自然温暖，口播与旁白都稳' },
  { id: 'zh-CN-XiaoyiNeural', name: '晓伊', gender: 'female', locale: 'zh-CN', tags: ['活泼', '少女'], desc: '明亮活泼，适合短视频和动画' },
  { id: 'zh-CN-XiaobeiNeural', name: '晓北', gender: 'female', locale: 'zh-CN', tags: ['东北话', '幽默'], desc: '辽宁方言，自带喜剧感' },
  { id: 'zh-CN-XiaoniNeural', name: '晓妮', gender: 'female', locale: 'zh-CN', tags: ['陕西话', '明亮'], desc: '陕西方言，适合地方内容' },
  { id: 'zh-CN-YunxiNeural', name: '云希', gender: 'male', locale: 'zh-CN', tags: ['少年', '阳光'], desc: '年轻阳光，适合 Vlog 和故事' },
  { id: 'zh-CN-YunxiaNeural', name: '云夏', gender: 'male', locale: 'zh-CN', tags: ['正太', '可爱'], desc: '偏少年/童声，轻快可爱' },
  { id: 'zh-CN-YunjianNeural', name: '云健', gender: 'male', locale: 'zh-CN', tags: ['热血', '解说'], desc: '体育解说式的有力男声' },
  { id: 'zh-CN-YunyangNeural', name: '云扬', gender: 'male', locale: 'zh-CN', tags: ['播音', '可靠'], desc: '新闻播音质感，专业稳定' },
  { id: 'zh-TW-HsiaoChenNeural', name: '曉臻', gender: 'female', locale: 'zh-TW', tags: ['台湾腔', '温柔'], desc: '台湾普通话女声' },
  { id: 'zh-TW-HsiaoYuNeural', name: '曉雨', gender: 'female', locale: 'zh-TW', tags: ['台湾腔', '甜美'], desc: '台湾普通话甜美女声' },
  { id: 'zh-TW-YunJheNeural', name: '雲哲', gender: 'male', locale: 'zh-TW', tags: ['台湾腔', '男声'], desc: '台湾普通话男声' },
  { id: 'zh-HK-HiuGaaiNeural', name: '曉佳', gender: 'female', locale: 'zh-HK', tags: ['粤语', '亲切'], desc: '粤语女声，自然亲切' },
  { id: 'zh-HK-HiuMaanNeural', name: '曉曼', gender: 'female', locale: 'zh-HK', tags: ['粤语', '温柔'], desc: '粤语温柔女声' },
  { id: 'zh-HK-WanLungNeural', name: '雲龍', gender: 'male', locale: 'zh-HK', tags: ['粤语', '男声'], desc: '粤语男声' },
  { id: 'en-US-AriaNeural', name: 'Aria', gender: 'female', locale: 'en-US', tags: ['English', '自信'], desc: 'Confident English female voice' },
  { id: 'en-US-JennyNeural', name: 'Jenny', gender: 'female', locale: 'en-US', tags: ['English', '友好'], desc: 'Friendly conversational English' },
  { id: 'en-US-GuyNeural', name: 'Guy', gender: 'male', locale: 'en-US', tags: ['English', '磁性'], desc: 'Deep English male voice' },
  { id: 'en-US-AvaNeural', name: 'Ava', gender: 'female', locale: 'en-US', tags: ['English', '表现力'], desc: 'Expressive English female voice' },
  { id: 'ja-JP-NanamiNeural', name: 'Nanami', gender: 'female', locale: 'ja-JP', tags: ['日本語', '自然'], desc: 'Natural Japanese female voice' },
  { id: 'ja-JP-KeitaNeural', name: 'Keita', gender: 'male', locale: 'ja-JP', tags: ['日本語', '男声'], desc: 'Japanese male voice' },
]

/**
 * RVC-style timbre presets. `pitch` is in semitones and is applied with
 * rubberband (formants follow the pitch, unlike plain resampling), then a small
 * EQ/compressor chain gives each character its own body.
 */
const IMAGE_PROVIDER_PRESETS = {
  pollinations: {
    label: 'Pollinations（免 Key）',
    baseURL: 'https://image.pollinations.ai',
    model: 'flux',
    models: ['flux', 'turbo'],
    style: 'pollinations',
  },
  seedream: {
    label: 'Seedream / 火山方舟',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seedream-3-0-t2i-250415',
    models: ['doubao-seedream-3-0-t2i-250415', 'doubao-seedream-4-0-250828'],
    style: 'seedream',
  },
  siliconflow: {
    label: 'SiliconFlow / 硅基流动',
    baseURL: 'https://api.siliconflow.cn/v1',
    model: 'Kwai-Kolors/Kolors',
    models: [
      'Kwai-Kolors/Kolors',
      'black-forest-labs/FLUX.1-schnell',
      'stabilityai/stable-diffusion-3-5-large',
    ],
    style: 'siliconflow',
  },
  dashscope: {
    label: '通义万相 / DashScope',
    baseURL: 'https://dashscope.aliyuncs.com',
    model: 'wanx2.1-t2i-turbo',
    models: ['wanx2.1-t2i-turbo', 'wanx2.1-t2i-plus', 'wanx-v1'],
    style: 'dashscope',
  },
  openai: {
    label: 'OpenAI / 自定义兼容',
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-image-1',
    models: ['gpt-image-1', 'dall-e-3', 'flux', 'seedream-4-0'],
    style: 'openai',
  },
}

const LLM_PROVIDER_PRESETS = {
  openai: {
    label: 'OpenAI / 通用兼容',
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o'],
    vision: true,
  },
  deepseek: {
    label: 'DeepSeek V4.1 / Flash',
    baseURL: 'https://api.deepseek.com/anthropic',
    model: 'deepseek-flash',
    models: ['deepseek-flash', 'deepseek-v4.1-flash', 'deepseek-chat', 'deepseek-reasoner'],
    vision: true,
    note: 'DSH 的 DeepSeek-V4.1-Flash 支持图片；Base URL 含 /anthropic 时插件自动走 Messages 协议。',
  },
  dashscope: {
    label: '通义千问 Qwen-VL',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-vl-max',
    models: ['qwen-vl-max', 'qwen-vl-plus'],
    vision: true,
  },
  siliconflow: {
    label: 'SiliconFlow 视觉模型',
    baseURL: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-VL-72B-Instruct',
    models: ['Qwen/Qwen2.5-VL-72B-Instruct', 'Qwen/Qwen2.5-VL-32B-Instruct'],
    vision: true,
  },
  zhipu: {
    label: '智谱 GLM-4V',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4v-plus',
    models: ['glm-4v-plus', 'glm-4v'],
    vision: true,
  },
  custom: {
    label: '自定义兼容',
    baseURL: '',
    model: '',
    models: [],
    vision: true,
  },
}

const VOICE_PRESETS = [  { id: 'natural', name: '原声', pitch: 0, desc: '保留所选神经声线的原始音色', filter: '' },
  { id: 'sweet', name: '甜妹', pitch: 2, desc: '音高略升，齿音更亮', filter: 'equalizer=f=3200:t=q:w=1:g=2,equalizer=f=180:t=q:w=1:g=-1' },
  { id: 'loli', name: '萝莉', pitch: 5, desc: '更高更轻的童声感', filter: 'equalizer=f=3800:t=q:w=1:g=2.5,highpass=f=90' },
  { id: 'boy', name: '少年', pitch: 3, desc: '清亮少年音，保留咬字', filter: 'equalizer=f=2500:t=q:w=1:g=1.5,acompressor=threshold=-18dB:ratio=2.5:attack=8:release=120' },
  { id: 'queen', name: '御姐', pitch: -2, desc: '低一点、更稳的成熟女声', filter: 'equalizer=f=220:t=q:w=1:g=2,equalizer=f=5000:t=q:w=1:g=-1' },
  { id: 'mature', name: '磁性', pitch: -4, desc: '压低音高，胸腔共鸣更强', filter: 'equalizer=f=150:t=q:w=1:g=3,acompressor=threshold=-20dB:ratio=3:attack=10:release=160' },
  { id: 'uncle', name: '大叔', pitch: -6, desc: '低沉旁白，适合纪录片', filter: 'equalizer=f=110:t=q:w=1:g=3.5,lowpass=f=9000,acompressor=threshold=-22dB:ratio=3.5:attack=12:release=180' },
  { id: 'robot', name: '电音', pitch: 0, desc: '合唱与失真叠加的机械感', filter: 'chorus=0.6:0.9:50|60:0.4|0.32:0.25|0.4:2|1.3,acrusher=bits=10:mix=0.22,aecho=0.8:0.7:8:0.2' },
  { id: 'whisper', name: '耳语', pitch: -1, desc: '气声更近，适合 ASMR', filter: 'highpass=f=280,lowpass=f=6800,equalizer=f=1800:t=q:w=1:g=-2,volume=0.92' },
  { id: 'radio', name: '电台', pitch: 0, desc: '窄频带 + 压缩，像深夜电台', filter: 'highpass=f=280,lowpass=f=3600,acompressor=threshold=-24dB:ratio=4:attack=5:release=100' },
]

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const round = (value, digits = 2) => Number(Number(value).toFixed(digits))
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

function jsonError(message, code = 'error') {
  const error = new Error(message)
  error.code = code
  return error
}

function cleanText(value, max = 4000) {
  if (typeof value !== 'string') return ''
  return value.replace(/\r\n/g, '\n').trim().slice(0, max)
}

function safeFileStem(value, fallback = 'creative') {
  const stem = String(value ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 54)
  return stem || fallback
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function isInside(parent, child) {
  const rel = resolve(child).slice(resolve(parent).length)
  return resolve(child) === resolve(parent) || (rel.startsWith('\\') || rel.startsWith('/'))
}

function pathFromInput(raw) {
  let value = String(raw ?? '').trim()
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim()
  }
  if (value.startsWith('~')) value = join(homedir(), value.slice(1))
  if (value.startsWith('file://')) {
    try {
      value = fileURLToPath(value)
    } catch {
      /* fall through to the plain path error */
    }
  }
  return isAbsolute(value) ? resolve(value) : resolve(process.cwd(), value)
}

async function exists(path) {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

function sniffImageExtension(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return '.png'
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return '.jpg'
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return '.webp'
  }
  if (buffer.length >= 6 && buffer.toString('ascii', 0, 3) === 'GIF') return '.gif'
  if (buffer.length >= 12 && buffer.toString('ascii', 4, 12).includes('ftypavif')) return '.avif'
  return '.png'
}

function parseImageSize(value, fallback = '1024x1024') {
  const match = /^(\d{3,4})\s*[x×]\s*(\d{3,4})$/i.exec(String(value ?? '').trim())
  if (!match) {
    const [width, height] = fallback.split('x').map(Number)
    return { width, height, text: `${width}x${height}` }
  }
  const width = clamp(Math.round(Number(match[1])), 256, 4096)
  const height = clamp(Math.round(Number(match[2])), 256, 4096)
  return { width, height, text: `${width}x${height}` }
}

function trimBaseURL(value) {
  return String(value ?? '').trim().replace(/\/+$/, '')
}

function xmlEscape(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function fileXmlUrl(path) {
  const normalized = String(path).replaceAll('\\', '/')
  return encodeURI(`file://localhost/${normalized}`).replaceAll('#', '%23').replaceAll('?', '%3F')
}

function srtSeconds(value) {
  const match = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(String(value).trim())
  if (!match) return null
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4].padEnd(3, '0')) / 1000
}

function parseSrt(text) {
  const blocks = String(text)
    .replace(/\r\n/g, '\n')
    .replace(/^\uFEFF/, '')
    .split(/\n{2,}/)
  const cues = []
  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean)
    const timeIndex = lines.findIndex((line) => line.includes('-->'))
    if (timeIndex < 0) continue
    const [from, to] = lines[timeIndex].split('-->').map((part) => part.trim().split(/\s+/)[0])
    const start = srtSeconds(from)
    const end = srtSeconds(to)
    if (start === null || end === null || end <= start) continue
    const content = lines.slice(timeIndex + 1).join('\n').trim()
    if (content === '') continue
    cues.push({ start, end, text: content })
  }
  return cues
}

async function readJsonBody(req, limit = MAX_JSON_BODY) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      throw jsonError('请求体过大', 'too-large')
    }
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (raw === '') return {}
  try {
    const value = JSON.parse(raw)
    return value !== null && typeof value === 'object' ? value : {}
  } catch {
    throw jsonError('请求体不是有效 JSON', 'bad-json')
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', Buffer.byteLength(body))
  res.end(body)
}

function ok(res, value) {
  sendJson(res, 200, { ok: true, value })
}

function fail(res, error, status = 200) {
  sendJson(res, status, {
    ok: false,
    error: {
      code: error?.code ?? 'error',
      message: String(error?.message ?? error),
    },
  })
}

function crossSiteRequest(req) {
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return true
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return false
  try {
    return new URL(origin).host !== req.headers.host
  } catch {
    return true
  }
}

function parsePathList() {
  return (process.env.PATH ?? '').split(';').filter(Boolean)
}

function commandOnPath(command) {
  if (!command) return null
  if (isAbsolute(command) || command.includes('\\') || command.includes('/')) {
    return command
  }
  const extensions = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
  for (const dir of parsePathList()) {
    for (const ext of ['', ...extensions]) {
      const candidate = join(dir, command + ext)
      try {
        if (statSync(candidate).isFile()) return candidate
      } catch {
        /* keep looking */
      }
    }
  }
  return null
}

function firstFile(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      /* next */
    }
  }
  return null
}

function tokenize(command) {
  if (Array.isArray(command)) return command.map((part) => String(part))
  const parts = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match
  while ((match = pattern.exec(String(command))) !== null) {
    parts.push(match[1] ?? match[2] ?? match[3] ?? '')
  }
  return parts
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      env: { ...process.env, ...(options.env ?? {}) },
    })
    let stdout = ''
    let stderr = ''
    const limit = options.maxBuffer ?? 16 * 1024 * 1024
    const timer = setTimeout(() => {
      child.kill()
      reject(jsonError(`执行超时：${basename(command)}`, 'timeout'))
    }, options.timeout ?? 180_000)
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
      if (stdout.length > limit) stdout = stdout.slice(-limit)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
      if (stderr.length > limit) stderr = stderr.slice(-limit)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(jsonError(`无法启动 ${basename(command)}：${error.message}`, 'spawn'))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ code: code ?? -1, stdout, stderr })
    })
  })
}

async function runJson(command, args, options) {
  const result = await run(command, args, {
    ...(options ?? {}),
    // Windows Python defaults stdio to the ANSI code page. Paths and prompts
    // are UTF-8 in the plugin, so force Python's UTF-8 mode for this worker.
    env: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...(options?.env ?? {}) },
  })
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean)
  let payload = null
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index])
      if (parsed !== null && typeof parsed === 'object') {
        payload = parsed
        break
      }
    } catch {
      /* keep looking */
    }
  }
  if (payload === null) {
    throw jsonError(
      result.stderr.trim() || result.stdout.trim() || `子进程退出码 ${result.code}`,
      'worker',
    )
  }
  if (payload.ok !== true) {
    throw jsonError(payload.error ?? '本地处理失败', 'worker')
  }
  return payload
}

function parseDuration(text) {
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text)
  if (!match) return 0
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

function parseFps(value) {
  if (typeof value !== 'string' || value === '') return 0
  const [a, b] = value.split('/').map(Number)
  if (Number.isFinite(a) && Number.isFinite(b) && b !== 0) return a / b
  return Number(value) || 0
}

function ffmpegProbeFallback(text) {
  const duration = parseDuration(text)
  const videoLine = text.split(/\r?\n/).find((line) => /Stream #\d+:\d+.*Video:/.test(line)) ?? ''
  const audioLine = text.split(/\r?\n/).find((line) => /Stream #\d+:\d+.*Audio:/.test(line)) ?? ''
  const size = /(\d{2,5})x(\d{2,5})/.exec(videoLine)
  const fps = /([\d.]+)\s*fps/.exec(videoLine)
  const codec = /Video:\s*([^\s,]+)/.exec(videoLine)
  const audioCodec = /Audio:\s*([^\s,]+)/.exec(audioLine)
  return {
    duration,
    width: size ? Number(size[1]) : 0,
    height: size ? Number(size[2]) : 0,
    fps: fps ? Number(fps[1]) : 0,
    videoCodec: codec ? codec[1] : '',
    audioCodec: audioCodec ? audioCodec[1] : '',
    hasAudio: audioLine !== '',
    hasVideo: videoLine !== '',
  }
}

function mediaAssetKind(ext) {
  if (IMAGE_EXT.has(ext)) return 'image'
  if (VIDEO_EXT.has(ext)) return 'video'
  if (AUDIO_EXT.has(ext)) return 'audio'
  return 'file'
}

export function apply(ctx, rowConfig) {
  const config = { ...DEFAULTS, ...(rowConfig ?? {}) }
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  // The host process runs with the profile directory as cwd, which is often on
  // C:. Resolve the active workspace from DSH instead so outputs, temporary
  // files and RVC models stay beside the user's project.
  let workspacePath = ''
  try {
    const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
    const list = registry?.list?.()
    if (Array.isArray(list)) {
      const candidate = list.find((workspace) => typeof workspace?.path === 'string' && workspace.path !== '')
      if (candidate) workspacePath = candidate.path
    }
  } catch {
    /* workspace registry is optional */
  }
  // FFmpeg can be blocked by some Windows security suites when writing under
  // the user profile (observed with Huorong). The current workspace is both
  // writable and more discoverable, so the console defaults its outputs there.
  // DSH_CREATIVE_CONSOLE_HOME can move it explicitly.
  const root =
    process.env.DSH_CREATIVE_CONSOLE_HOME && process.env.DSH_CREATIVE_CONSOLE_HOME.trim() !== ''
      ? resolve(process.env.DSH_CREATIVE_CONSOLE_HOME)
      : join(workspacePath || process.cwd(), '.creative-console')
  const outputs = {
    image: join(root, 'outputs', 'images'),
    generated: join(root, 'outputs', 'generated'),
    upscaled: join(root, 'outputs', 'upscaled'),
    video: join(root, 'outputs', 'videos'),
    premiere: join(root, 'outputs', 'premiere'),
    audio: join(root, 'outputs', 'audio'),
    upload: join(root, 'uploads'),
    tmp: join(root, 'tmp'),
  }
  const assetsFile = join(root, 'assets.json')
  const configFile = join(root, 'config.json')
  const customVoicesFile = join(root, 'voices.json')
  const projectsFile = join(root, 'projects.json')

  const jobs = new Map()
  const assets = new Map()
  const recent = []
  let persistTimer = null
  let engineCache = null
  let engineCachedAt = 0
  let engines = null
  let customVoices = []
  let projects = []

  // ------------------------------------------------------------------ config

  async function loadConfig() {
    try {
      const raw = JSON.parse(await readFile(configFile, 'utf8'))
      if (raw && typeof raw === 'object') {
        for (const key of Object.keys(DEFAULTS)) {
          if (typeof raw[key] === typeof DEFAULTS[key]) config[key] = raw[key]
        }
      }
    } catch {
      /* first run */
    }
  }

  async function saveConfig(patch) {
    for (const key of Object.keys(DEFAULTS)) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        if (typeof patch[key] === 'string') config[key] = patch[key].trim()
        else if (typeof patch[key] === 'number') config[key] = patch[key]
      }
    }
    await mkdir(root, { recursive: true })
    await writeFile(configFile, JSON.stringify(config, null, 2), 'utf8')
    engineCache = null
    engineCachedAt = 0
  }

  // ------------------------------------------------------------------ image generation config

  function imageProviderName() {
    return Object.prototype.hasOwnProperty.call(IMAGE_PROVIDER_PRESETS, config.imageProvider)
      ? config.imageProvider
      : 'pollinations'
  }

  function imageProviderConfig() {
    const provider = imageProviderName()
    const preset = IMAGE_PROVIDER_PRESETS[provider]
    const models = String(config.imageModels ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    const model = String(config.imageModel ?? '').trim() || preset.model
    const allModels = models.length > 0 ? models : preset.models
    if (!allModels.includes(model)) allModels.unshift(model)
    return {
      provider,
      label: preset.label,
      style: preset.style ?? 'openai',
      baseURL: trimBaseURL(config.imageBaseURL) || preset.baseURL,
      model,
      models: allModels,
      size: parseImageSize(config.imageSize),
      quality: String(config.imageQuality ?? '').trim(),
      timeoutMs: clamp(Number(config.imageTimeoutMs) || 180000, 15000, 900000),
      keyEnv: String(config.imageApiKeyEnv ?? '').trim() || 'OPENAI_API_KEY',
      free: provider === 'pollinations',
    }
  }

  async function resolveImageKey() {
    const settings = imageProviderConfig()
    if (settings.free) return 'pollinations'
    try {
      const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
      if (credentials && typeof credentials.resolve === 'function') {
        const hit = await credentials.resolve(settings.keyEnv)
        if (hit?.value) return hit.value
      }
    } catch {
      /* fall back to the environment */
    }
    return process.env[settings.keyEnv] ?? ''
  }

  async function imageGeneratorStatus() {
    const settings = imageProviderConfig()
    const key = await resolveImageKey()
    return {
      ...settings,
      size: settings.size.text,
      hasKey: key !== '',
      keySource: settings.free ? 'free' : key !== '' ? 'credentials-or-env' : 'missing',
    }
  }

  async function saveImageKey(key) {
    const settings = imageProviderConfig()
    if (settings.free) return { saved: true, hasKey: true }
    const value = String(key ?? '').trim()
    if (value === '') throw jsonError('API Key 不能为空', 'empty-key')
    const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
    if (!credentials || typeof credentials.set !== 'function') {
      throw jsonError('DSH 凭据服务不可用，无法安全保存 Key', 'no-credentials')
    }
    await credentials.set(settings.keyEnv, value)
    return { saved: true, hasKey: true, keyEnv: settings.keyEnv }
  }

  // ------------------------------------------------------------------ language edit config

  function llmConfig() {
    const provider = Object.prototype.hasOwnProperty.call(LLM_PROVIDER_PRESETS, config.llmProvider)
      ? config.llmProvider
      : 'openai'
    const preset = LLM_PROVIDER_PRESETS[provider]
    const baseURL = trimBaseURL(config.llmBaseURL) || preset.baseURL
    const protocol =
      config.llmProtocol === 'anthropic' || config.llmProtocol === 'openai'
        ? config.llmProtocol
        : /\/anthropic(?:\/|$)/i.test(baseURL)
          ? 'anthropic'
          : 'openai'
    return {
      provider,
      label: preset.label,
      baseURL,
      protocol,
      model: String(config.llmModel ?? '').trim() || preset.model,
      models: preset.models,
      vision: preset.vision,
      note: preset.note ?? '',
      keyEnv: String(config.llmApiKeyEnv ?? '').trim() || 'OPENAI_API_KEY',
      timeoutMs: clamp(Number(config.llmTimeoutMs) || 180000, 15000, 600000),
    }
  }

  async function resolveLlmKey() {
    const settings = llmConfig()
    try {
      const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
      if (credentials && typeof credentials.resolve === 'function') {
        const hit = await credentials.resolve(settings.keyEnv)
        if (hit?.value) return hit.value
      }
    } catch {
      /* fall back to the environment */
    }
    return process.env[settings.keyEnv] ?? ''
  }

  async function llmStatus() {
    const settings = llmConfig()
    const key = await resolveLlmKey()
    return {
      ...settings,
      hasKey: key !== '',
      keySource: key !== '' ? 'credentials-or-env' : 'missing',
      canUse: key !== '' || /^https?:\/\/(127\.0\.0\.1|localhost)/i.test(settings.baseURL),
    }
  }

  function asrConfig() {
    return {
      baseURL: trimBaseURL(config.asrBaseURL) || 'https://api.openai.com/v1',
      model: String(config.asrModel ?? '').trim() || 'whisper-1',
      keyEnv: String(config.asrApiKeyEnv ?? '').trim() || 'OPENAI_API_KEY',
      timeoutMs: clamp(Number(config.asrTimeoutMs) || 300000, 15000, 900000),
    }
  }

  async function resolveAsrKey() {
    const settings = asrConfig()
    try {
      const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
      if (credentials && typeof credentials.resolve === 'function') {
        const hit = await credentials.resolve(settings.keyEnv)
        if (hit?.value) return hit.value
      }
    } catch {
      /* fall through */
    }
    return process.env[settings.keyEnv] ?? ''
  }

  async function asrStatus() {
    const settings = asrConfig()
    const key = await resolveAsrKey()
    return { ...settings, hasKey: key !== '', canUse: key !== '' }
  }

  async function saveAsrKey(key) {
    const settings = asrConfig()
    const value = String(key ?? '').trim()
    if (value === '') throw jsonError('API Key 不能为空', 'empty-key')
    const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
    if (!credentials || typeof credentials.set !== 'function') {
      throw jsonError('DSH 凭据服务不可用，无法安全保存 Key', 'no-credentials')
    }
    await credentials.set(settings.keyEnv, value)
    return { saved: true, hasKey: true, keyEnv: settings.keyEnv }
  }

  async function saveLlmKey(key) {
    const settings = llmConfig()
    const value = String(key ?? '').trim()
    if (value === '') throw jsonError('API Key 不能为空', 'empty-key')
    const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
    if (!credentials || typeof credentials.set !== 'function') {
      throw jsonError('DSH 凭据服务不可用，无法安全保存 Key', 'no-credentials')
    }
    await credentials.set(settings.keyEnv, value)
    return { saved: true, hasKey: true, keyEnv: settings.keyEnv }
  }

  async function testApiConnection(body) {
    const kind = String(body?.kind ?? 'llm')
    if (kind === 'asr') {
      const settings = asrConfig()
      const key = await resolveAsrKey()
      if (key === '') throw jsonError(`缺少 ${settings.keyEnv}，请先保存 Key`, 'missing-key')
      const response = await fetch(`${settings.baseURL.replace(/\/+$/, '')}/models`, {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(20_000),
      }).catch((error) => {
        throw jsonError(`连接失败：${error?.message ?? error}`, 'api-fetch')
      })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw jsonError(`HTTP ${response.status}${text ? `：${text.slice(0, 300)}` : ''}`, 'api-http')
      }
      const payload = await response.json().catch(() => null)
      const models = Array.isArray(payload?.data)
        ? payload.data.map((item) => item?.id).filter((item) => typeof item === 'string' && item !== '')
        : []
      return { ok: true, kind, models, note: models.length > 0 ? '已读取模型列表' : 'Key 已通过鉴权' }
    }
    if (kind === 'image') {
      const settings = imageProviderConfig()
      if (settings.free) return { ok: true, kind, free: true, message: 'Pollinations 免 Key 通道可用', models: settings.models }
      const key = await resolveImageKey()
      if (key === '') throw jsonError(`缺少 ${settings.keyEnv}，请先保存 Key`, 'missing-key')
      const base = settings.baseURL.replace(/\/+$/, '')
      const response = await fetch(`${base}/models`, {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(20_000),
      }).catch((error) => {
        throw jsonError(`连接失败：${error?.message ?? error}`, 'api-fetch')
      })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw jsonError(`HTTP ${response.status}${text ? `：${text.slice(0, 300)}` : ''}`, 'api-http')
      }
      const payload = await response.json().catch(() => null)
      const models = Array.isArray(payload?.data)
        ? payload.data.map((item) => item?.id).filter((item) => typeof item === 'string' && item !== '')
        : settings.models
      return {
        ok: true,
        kind,
        models,
        note: Array.isArray(payload?.data) ? '已读取模型列表' : '服务未返回模型列表，Key 已通过鉴权',
      }
    }

    const settings = llmConfig()
    const key = await resolveLlmKey()
    if (key === '' && !/^https?:\/\/(127\.0\.0\.1|localhost)/i.test(settings.baseURL)) {
      throw jsonError(`缺少 ${settings.keyEnv}，请先保存 Key`, 'missing-key')
    }
    const started = Date.now()
    const isAnthropic = settings.protocol === 'anthropic'
    const baseRoot = settings.baseURL.replace(/\/+$/, '').replace(/\/v1$/i, '')
    const endpoint = isAnthropic ? `${baseRoot}/v1/messages` : `${baseRoot}/chat/completions`
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key !== '' ? { authorization: `Bearer ${key}` } : {}),
        ...(isAnthropic && key !== '' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : {}),
      },
      body: JSON.stringify(
        isAnthropic
          ? {
              model: settings.model,
              max_tokens: 4,
              messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply OK.' }] }],
            }
          : {
              model: settings.model,
              max_tokens: 4,
              messages: [{ role: 'user', content: 'Reply OK.' }],
            },
      ),
      signal: AbortSignal.timeout(25_000),
    }).catch((error) => {
      throw jsonError(`连接失败：${error?.message ?? error}`, 'api-fetch')
    })
    const text = await response.text()
    if (!response.ok) {
      throw jsonError(`HTTP ${response.status}${text ? `：${text.slice(0, 400)}` : ''}`, 'api-http')
    }
    return {
      ok: true,
      kind,
      model: settings.model,
      protocol: settings.protocol,
      latencyMs: Date.now() - started,
      reply: text.slice(0, 120),
    }
  }

  // ------------------------------------------------------------------ assets

  function assetId(path) {
    return createHash('sha256').update(path).digest('hex').slice(0, 18)
  }

  function publicAsset(asset) {
    return {
      id: asset.id,
      name: asset.name,
      path: asset.path,
      kind: asset.kind,
      mime: asset.mime,
      bytes: asset.bytes,
      width: asset.width ?? null,
      height: asset.height ?? null,
      duration: asset.duration ?? null,
      createdAt: asset.createdAt,
      url: `${PREFIX}/asset/${asset.id}`,
      downloadUrl: `${PREFIX}/asset/${asset.id}?download=1`,
    }
  }

  function remember(asset) {
    assets.set(asset.id, asset)
    const index = recent.findIndex((item) => item.id === asset.id)
    if (index >= 0) recent.splice(index, 1)
    recent.unshift(asset)
    if (recent.length > 36) recent.length = 36
    if (persistTimer !== null) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null
      void persistAssets()
    }, 300)
    if (typeof persistTimer.unref === 'function') persistTimer.unref()
    return asset
  }

  async function persistAssets() {
    try {
      await mkdir(root, { recursive: true })
      const rows = []
      for (const asset of recent) {
        if (!(await exists(asset.path))) continue
        rows.push({
          id: asset.id,
          name: asset.name,
          path: asset.path,
          kind: asset.kind,
          mime: asset.mime,
          bytes: asset.bytes,
          width: asset.width ?? null,
          height: asset.height ?? null,
          duration: asset.duration ?? null,
          createdAt: asset.createdAt,
        })
      }
      await writeFile(assetsFile, JSON.stringify({ version: 1, assets: rows }, null, 2), 'utf8')
    } catch {
      /* history is a convenience, never a hard failure */
    }
  }

  async function loadCustomVoices() {
    try {
      const raw = JSON.parse(await readFile(customVoicesFile, 'utf8'))
      const rows = Array.isArray(raw?.voices) ? raw.voices : Array.isArray(raw) ? raw : []
      customVoices = rows
        .filter((row) => row && typeof row.id === 'string' && typeof row.name === 'string')
        .slice(0, 40)
    } catch {
      customVoices = []
    }
  }

  async function saveCustomVoices() {
    await mkdir(root, { recursive: true })
    await writeFile(customVoicesFile, JSON.stringify({ voices: customVoices }, null, 2), 'utf8')
  }

  function allVoicePresets() {
    return [...VOICE_PRESETS, ...customVoices]
  }

  async function loadProjects() {
    try {
      const raw = JSON.parse(await readFile(projectsFile, 'utf8'))
      const rows = Array.isArray(raw?.projects) ? raw.projects : []
      projects = rows.filter((row) => row && typeof row.id === 'string' && typeof row.name === 'string').slice(0, 40)
    } catch {
      projects = []
    }
  }

  async function saveProjects() {
    await mkdir(root, { recursive: true })
    await writeFile(projectsFile, JSON.stringify({ projects }, null, 2), 'utf8')
  }

  async function projectList() {
    return { projects: projects.map((project) => ({ ...project, count: project.items.length })) }
  }

  async function projectCreate(body) {
    const name = cleanText(body.name, 40)
    if (name === '') throw jsonError('项目名称不能为空', 'empty-project-name')
    const project = {
      id: `project-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
      name,
      items: [],
      snapshots: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    projects = [project, ...projects].slice(0, 40)
    await saveProjects()
    return { project: { ...project, count: 0 }, projects: (await projectList()).projects }
  }

  async function projectUpdate(body) {
    const id = String(body.id ?? '')
    const project = projects.find((item) => item.id === id)
    if (!project) throw jsonError('项目不存在', 'no-project')
    if (typeof body.name === 'string') {
      const name = cleanText(body.name, 40)
      if (name === '') throw jsonError('项目名称不能为空', 'empty-project-name')
      project.name = name
    }
    const before = (project.items ?? []).map((item) => ({ ...item }))
    const beforeCount = (project.items ?? []).length
    if (body.addPath) {
      const target = pathFromInput(body.addPath)
      if (!(await exists(target))) throw jsonError('成品文件不存在', 'missing-file')
      if (!isInside(root, target)) throw jsonError('只能添加创作台输出目录里的成品', 'outside-root')
      if (!project.items.some((item) => item.path === target)) {
        project.items.push({
          path: target,
          kind: String(body.kind ?? 'file'),
          label: cleanText(body.label, 80) || basename(target),
          addedAt: new Date().toISOString(),
        })
      }
    }
    if (body.removePath) {
      const target = pathFromInput(body.removePath)
      project.items = project.items.filter((item) => item.path !== target)
    }
    if (beforeCount !== project.items.length) {
      project.snapshots = [
        ...(Array.isArray(project.snapshots) ? project.snapshots : []),
        { at: new Date().toISOString(), items: before },
      ].slice(-20)
    }
    project.updatedAt = new Date().toISOString()
    await saveProjects()
    return { project: { ...project, count: project.items.length }, projects: (await projectList()).projects }
  }

  async function projectDelete(body) {
    const id = String(body.id ?? '')
    projects = projects.filter((item) => item.id !== id)
    await saveProjects()
    return { projects: (await projectList()).projects }
  }

  async function projectRestore(body) {
    const id = String(body.id ?? '')
    const project = projects.find((item) => item.id === id)
    if (!project) throw jsonError('项目不存在', 'no-project')
    const snapshots = Array.isArray(project.snapshots) ? project.snapshots : []
    if (snapshots.length === 0) throw jsonError('没有可恢复的历史版本', 'no-snapshot')
    const snapshot = snapshots[snapshots.length - 1]
    project.snapshots = [
      ...snapshots.slice(0, -1),
      { at: new Date().toISOString(), items: project.items.map((item) => ({ ...item })) },
    ].slice(-20)
    project.items = Array.isArray(snapshot.items) ? snapshot.items : []
    project.updatedAt = new Date().toISOString()
    await saveProjects()
    return { project: { ...project, count: project.items.length }, projects: (await projectList()).projects }
  }

  async function loadAssets() {    try {
      const raw = JSON.parse(await readFile(assetsFile, 'utf8'))
      const rows = Array.isArray(raw?.assets) ? raw.assets : []
      for (const row of rows.slice(0, 36)) {
        if (typeof row?.path !== 'string' || !(await exists(row.path))) continue
        const asset = {
          ...row,
          id: typeof row.id === 'string' && row.id !== '' ? row.id : assetId(row.path),
          kind: row.kind ?? mediaAssetKind(extname(row.path).toLowerCase()),
          mime: row.mime ?? MIME_BY_EXT[extname(row.path).toLowerCase()] ?? 'application/octet-stream',
          createdAt: Number(row.createdAt) || Date.now(),
        }
        assets.set(asset.id, asset)
        recent.push(asset)
      }
    } catch {
      /* no history */
    }
  }

  async function registerOutput(path, extra = {}) {
    const info = await stat(path)
    const ext = extname(path).toLowerCase()
    const asset = {
      id: assetId(path),
      name: basename(path),
      path,
      kind: mediaAssetKind(ext),
      mime: MIME_BY_EXT[ext] ?? 'application/octet-stream',
      bytes: info.size,
      createdAt: Date.now(),
      ...extra,
    }
    remember(asset)
    return publicAsset(asset)
  }

  function serveAsset(req, res, asset, download) {
    const range = req.headers.range
    const total = asset.bytes
    const headers = {
      'content-type': asset.mime,
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=120',
    }
    if (download) {
      const encoded = encodeURIComponent(asset.name)
      headers['content-disposition'] = `attachment; filename*=UTF-8''${encoded}`
    }
    if (typeof range === 'string' && /^bytes=\d*-\d*$/.test(range)) {
      const [startRaw, endRaw] = range.slice(6).split('-')
      let start = startRaw === '' ? null : Number(startRaw)
      let end = endRaw === '' ? null : Number(endRaw)
      if (start === null && end !== null) {
        start = Math.max(0, total - end)
        end = total - 1
      } else {
        start = start ?? 0
        end = end === null ? total - 1 : Math.min(end, total - 1)
      }
      if (start > end || start >= total) {
        res.writeHead(416, { 'content-range': `bytes */${total}` })
        res.end()
        return
      }
      headers['content-range'] = `bytes ${start}-${end}/${total}`
      headers['content-length'] = String(end - start + 1)
      res.writeHead(206, headers)
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      createReadStream(asset.path, { start, end }).pipe(res)
      return
    }
    headers['content-length'] = String(total)
    res.writeHead(200, headers)
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(asset.path).pipe(res)
  }

  // ------------------------------------------------------------------ engines

  async function detectEngines(force = false) {
    if (!force && engineCache !== null && Date.now() - engineCachedAt < 15_000) return engineCache

    const runtimePython = join(
      dshHome,
      'dsh-runtimes',
      'dsh-primary-runtime',
      'dependencies',
      'python',
      'python.exe',
    )
    const pythonCandidates = [
      config.pythonPath,
      process.env.DSH_PYTHON,
      runtimePython,
      commandOnPath('python'),
      commandOnPath('python3'),
    ].filter(Boolean)
    const python = firstFile(pythonCandidates)

    const ffmpegCandidates = [
      config.ffmpegPath,
      process.env.DSH_FFMPEG,
      join(root, 'bin', 'ffmpeg.exe'),
      join(workspacePath, 'tools', 'ffmpeg.exe'),
      join(process.cwd(), 'tools', 'ffmpeg.exe'),
      commandOnPath('ffmpeg'),
      'ffmpeg',
    ].filter(Boolean)
    const ffmpeg = firstFile(ffmpegCandidates) ?? (await commandExists('ffmpeg') ? 'ffmpeg' : null)

    const ffprobeCandidates = [
      ffmpeg && extname(ffmpeg).toLowerCase() === '.exe' ? join(dirname(ffmpeg), 'ffprobe.exe') : '',
      process.env.DSH_FFPROBE,
      commandOnPath('ffprobe'),
      'ffprobe',
    ].filter(Boolean)
    const ffprobe = firstFile(ffprobeCandidates) ?? (await commandExists('ffprobe') ? 'ffprobe' : null)

    const edgeCandidates = [
      config.edgeTtsPath,
      process.env.DSH_EDGE_TTS,
      python && extname(python).toLowerCase() === '.exe'
        ? join(dirname(python), 'Scripts', 'edge-tts.exe')
        : '',
      commandOnPath('edge-tts'),
    ].filter(Boolean)
    const edgeTts = firstFile(edgeCandidates)

    const upscaleCandidates = [
      config.upscalerPath,
      process.env.DSH_REALESRGAN,
      join(PLUGIN_DIR, 'bin', 'realesrgan', 'realesrgan-ncnn-vulkan.exe'),
      join(root, 'bin', 'realesrgan', 'realesrgan-ncnn-vulkan.exe'),
      commandOnPath('realesrgan-ncnn-vulkan'),
    ].filter(Boolean)
    const upscaler = firstFile(upscaleCandidates)
    const upscaleModels = []
    if (upscaler) {
      const modelDir = join(dirname(upscaler), 'models')
      for (const name of ['realesrgan-x4plus', 'realesrgan-x4plus-anime', 'realesr-animevideov3-x4']) {
        if (await exists(join(modelDir, `${name}.param`)) && await exists(join(modelDir, `${name}.bin`))) {
          upscaleModels.push(name)
        }
      }
    }

    let pillow = null
    let edgeVersion = null
    if (python) {
      try {
        const result = await run(python, ['-c', 'import PIL; print(PIL.__version__)'], { timeout: 15_000 })
        if (result.code === 0) pillow = result.stdout.trim()
      } catch {
        /* image engine unavailable */
      }
    }
    if (edgeTts) {
      try {
        const result = await run(edgeTts, ['--version'], { timeout: 15_000 })
        if (result.code === 0) edgeVersion = result.stdout.trim()
      } catch {
        /* version is optional */
      }
    }

    const rvc = await detectRvc(python)

    engineCache = {
      image: {
        ok: Boolean(python && pillow),
        engine: 'Pillow',
        version: pillow,
        python,
      },
      video: {
        ok: Boolean(ffmpeg),
        engine: 'FFmpeg',
        ffmpeg,
        ffprobe,
        version: ffmpeg ? await ffmpegVersion(ffmpeg) : null,
      },
      tts: {
        ok: Boolean(edgeTts || python),
        engine: 'edge-tts',
        version: edgeVersion,
        command: edgeTts,
        python,
      },
      upscale: {
        ok: Boolean(upscaler && upscaleModels.length > 0),
        engine: 'Real-ESRGAN ncnn',
        path: upscaler,
        models: upscaleModels,
      },
      rvc,
    }
    engineCachedAt = Date.now()
    return engineCache
  }

  async function commandExists(command) {
    const result = await run('where.exe', [command], { timeout: 5000 }).catch(() => null)
    return Boolean(result && result.code === 0 && result.stdout.trim() !== '')
  }

  async function ffmpegVersion(path) {
    try {
      const result = await run(path, ['-version'], { timeout: 12_000 })
      return result.stdout.split(/\r?\n/)[0]?.replace(/^ffmpeg version\s*/i, '') ?? null
    } catch {
      return null
    }
  }

  async function detectRvc(python) {
    const command = config.rvcCommand || process.env.DSH_RVC_CMD || ''
    const searchRoots = [
      join(root, 'rvc'),
      join(root, 'rvc', 'models'),
      join(process.env.USERPROFILE ?? homedir(), 'RVC'),
      join(process.env.USERPROFILE ?? homedir(), 'RVC', 'models'),
    ]
    const models = []
    const seen = new Set()
    for (const dir of searchRoots) {
      if (!(await exists(dir))) continue
      await walkFiles(dir, 3, async (file) => {
        const ext = extname(file).toLowerCase()
        if (ext !== '.pth' || seen.has(file)) return
        seen.add(file)
        const stem = basename(file, ext)
        let index = ''
        try {
          const siblings = await readdir(dirname(file))
          const found = siblings.find(
            (name) => name.toLowerCase().endsWith('.index') && name.toLowerCase().includes(stem.toLowerCase()),
          )
          if (found) index = join(dirname(file), found)
        } catch {
          /* index optional */
        }
        models.push({
          id: createHash('sha1').update(file).digest('hex').slice(0, 12),
          name: stem,
          path: file,
          index,
        })
      })
    }
    return {
      available: command !== '' && models.length > 0,
      hasCommand: command !== '',
      command,
      models,
      note:
        command === ''
          ? '未配置 RVC 引擎；内置 DSP 声线仍可用。设置 DSH_RVC_CMD 后可接入本地 RVC 模型。'
          : models.length === 0
            ? '已配置 RVC 命令，但未找到 .pth 模型（可放到工作区 .creative-console/rvc/models）'
            : `已找到 ${models.length} 个本地 RVC 模型`,
    }
  }

  async function walkFiles(dir, depth, visit) {
    if (depth < 0) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walkFiles(path, depth - 1, visit)
      else if (entry.isFile()) await visit(path)
    }
  }

  function statusPayload() {
    return {
      version: VERSION,
      platform: process.platform,
      outputs: root,
      workspace: workspacePath || null,
      imageProviders: Object.entries(IMAGE_PROVIDER_PRESETS).map(([id, preset]) => ({
        id,
        label: preset.label,
        baseURL: preset.baseURL,
        model: preset.model,
        models: preset.models,
      })),
      llmProviders: Object.entries(LLM_PROVIDER_PRESETS).map(([id, preset]) => ({
        id,
        label: preset.label,
        baseURL: preset.baseURL,
        model: preset.model,
        models: preset.models,
        vision: preset.vision,
        note: preset.note ?? '',
      })),
      engines,
      voices: VOICES,
      presets: allVoicePresets(),
      recent: recent.slice(0, 18).map(publicAsset),
      limits: {
        text: 6000,
        clips: 20,
        uploadMb: Math.round(MAX_UPLOAD_BODY / 1024 / 1024),
      },
    }
  }

  // ------------------------------------------------------------------ image

  async function imageInspect(body) {
    const engines = await detectEngines()
    if (!engines.image.ok) {
      throw jsonError('图片引擎不可用：没有找到 Pillow。请检查 Python 安装。', 'no-image-engine')
    }
    const path = pathFromInput(body.path)
    if (!(await exists(path))) throw jsonError(`图片不存在：${path}`, 'missing-file')
    const result = await runJson(engines.image.python, [WORKER, 'inspect', path], { timeout: 60_000 })
    const asset = await registerOutput(path, {
      width: result.width,
      height: result.height,
      kind: 'image',
    })
    return { ...result, asset }
  }

  async function imageOptimize(body) {
    const engines = await detectEngines()
    if (!engines.image.ok) {
      throw jsonError('图片引擎不可用：没有找到 Pillow。请检查 Python 安装。', 'no-image-engine')
    }
    const path = pathFromInput(body.path)
    if (!(await exists(path))) throw jsonError(`图片不存在：${path}`, 'missing-file')

    const format = ['webp', 'jpeg', 'png', 'avif'].includes(String(body.format)) ? body.format : 'webp'
    const ext = format === 'jpeg' ? 'jpg' : format
    const out = join(outputs.image, `${stamp()}-${safeFileStem(basename(path, extname(path)))}.${ext}`)
    await mkdir(outputs.image, { recursive: true })

    const args = [
      WORKER,
      'optimize',
      '--input',
      path,
      '--output',
      out,
      '--format',
      format,
      '--quality',
      String(clamp(Number(body.quality) || 82, 1, 100)),
      '--max-width',
      String(clamp(Number(body.maxWidth) || 1920, 16, 16384)),
      '--max-height',
      String(clamp(Number(body.maxHeight) || 1920, 16, 16384)),
      '--mode',
      body.mode === 'crop' ? 'crop' : 'fit',
    ]
    if (body.enhance === true) args.push('--enhance')
    if (body.strip !== false) args.push('--strip')

    const result = await runJson(engines.image.python, args, { timeout: 120_000 })
    const asset = await registerOutput(result.path, {
      width: result.width,
      height: result.height,
      kind: 'image',
      mime: result.mime,
      beforeBytes: result.beforeBytes,
      savedPercent: result.savedPercent,
    })
    return { ...result, asset }
  }

  // ------------------------------------------------------------------ image generation

  async function imageMeta(path) {
    try {
      const engines = await detectEngines()
      if (!engines.image.ok) return { width: 0, height: 0 }
      const info = await runJson(engines.image.python, [WORKER, 'inspect', path], { timeout: 30_000 })
      return { width: info.width, height: info.height }
    } catch {
      return { width: 0, height: 0 }
    }
  }

  async function saveGeneratedImage(buffer, prompt, index) {
    await mkdir(outputs.generated, { recursive: true })
    const ext = sniffImageExtension(buffer)
    const name = `${stamp()}-${safeFileStem(prompt.slice(0, 28))}-${index + 1}-${Math.random()
      .toString(36)
      .slice(2, 5)}${ext}`
    const path = join(outputs.generated, name)
    await writeFile(path, buffer)
    const meta = await imageMeta(path)
    return registerOutput(path, { width: meta.width, height: meta.height, kind: 'image' })
  }

  async function fetchImageBuffer(url, timeoutMs) {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw jsonError(`下载生成图失败（HTTP ${response.status}）${text ? `：${text.slice(0, 300)}` : ''}`, 'image-download')
    }
    const length = Number(response.headers.get('content-length') ?? 0)
    if (length > 64 * 1024 * 1024) throw jsonError('生成图超过 64MB，已拒绝', 'image-too-large')
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length < 256) throw jsonError('生成图内容为空', 'empty-image')
    if (buffer.length > 64 * 1024 * 1024) throw jsonError('生成图超过 64MB，已拒绝', 'image-too-large')
    return buffer
  }

  async function generateImagesPollinations(settings, prompt, size, n) {
    const images = []
    for (let index = 0; index < n; index += 1) {
      const seed = Math.floor(Math.random() * 2_000_000_000)
      const url =
        `${settings.baseURL.replace(/\/+$/, '')}/prompt/${encodeURIComponent(prompt)}` +
        `?width=${size.width}&height=${size.height}&model=${encodeURIComponent(settings.model)}` +
        `&nologo=true&seed=${seed}`
      const buffer = await fetchImageBuffer(url, settings.timeoutMs)
      images.push(await saveGeneratedImage(buffer, prompt, index))
    }
    return images
  }

  async function generateImagesOpenAI(settings, prompt, size, n, quality, style = 'openai') {
    const key = await resolveImageKey()
    if (key === '') {
      throw jsonError(
        `缺少生图 API Key。请在“设置”里填入，或把 ${settings.keyEnv} 放进 DSH 凭据/环境变量。`,
        'missing-image-key',
      )
    }
    if (style === 'seedream' && n > 1) {
      const images = []
      for (let index = 0; index < n; index += 1) {
        images.push(...(await generateImagesOpenAI(settings, prompt, size, 1, quality, style)))
      }
      return images
    }
    const endpoint = `${settings.baseURL.replace(/\/+$/, '')}/images/generations`
    const payload = { model: settings.model, prompt }
    if (style === 'seedream') {
      payload.size = size.text
      payload.n = 1
      payload.response_format = 'b64_json'
      payload.watermark = false
    } else if (style === 'siliconflow') {
      payload.image_size = size.text
      payload.batch_size = n
      payload.num_inference_steps = 20
      payload.guidance_scale = 7.5
    } else {
      payload.n = n
      payload.size = size.text
      if (quality && /gpt-image/i.test(settings.model)) payload.quality = quality
    }
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(settings.timeoutMs),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw jsonError(
        `生图服务返回 HTTP ${response.status}${text ? `：${text.slice(0, 600)}` : ''}`,
        'image-provider',
      )
    }
    const contentType = response.headers.get('content-type') ?? ''
    const images = []
    if (contentType.startsWith('image/')) {
      images.push(await saveGeneratedImage(Buffer.from(await response.arrayBuffer()), prompt, 0))
      return images
    }
    const result = await response.json().catch(() => null)
    const items = Array.isArray(result?.data) ? result.data : Array.isArray(result?.images) ? result.images : []
    if (items.length === 0) {
      throw jsonError('生图服务没有返回图片数据', 'image-provider')
    }
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]
      let buffer = null
      if (typeof item?.b64_json === 'string' && item.b64_json !== '') {
        buffer = Buffer.from(item.b64_json, 'base64')
      } else if (typeof item?.url === 'string' && /^https?:\/\//i.test(item.url)) {
        buffer = await fetchImageBuffer(item.url, settings.timeoutMs)
      } else if (typeof item?.image === 'string' && item.image.startsWith('data:image/')) {
        buffer = Buffer.from(item.image.split(',')[1] ?? '', 'base64')
      }
      if (buffer === null || buffer.length < 256) continue
      images.push(await saveGeneratedImage(buffer, prompt, index))
    }
    if (images.length === 0) throw jsonError('生图服务返回的数据里没有可用图片', 'image-provider')
    return images
  }

  async function generateImagesDashScope(settings, prompt, size, n) {
    const key = await resolveImageKey()
    if (key === '') {
      throw jsonError(
        `缺少通义万相 API Key。请在“设置”里填入，或把 ${settings.keyEnv} 放进 DSH 凭据/环境变量。`,
        'missing-image-key',
      )
    }
    const base = settings.baseURL.replace(/\/+$/, '').replace(/\/api\/v1$/i, '')
    const endpoint = `${base}/api/v1/services/aigc/text2image/image-synthesis`
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
        'X-DashScope-Async': 'enable',
      },
      body: JSON.stringify({
        model: settings.model,
        input: { prompt },
        parameters: { size: `${size.width}*${size.height}`, n },
      }),
      signal: AbortSignal.timeout(settings.timeoutMs),
    })
    const text = await response.text()
    if (!response.ok) {
      throw jsonError(`通义万相返回 HTTP ${response.status}：${text.slice(0, 600)}`, 'image-provider')
    }
    let task
    try {
      task = JSON.parse(text)
    } catch {
      throw jsonError('通义万相返回了无法解析的任务', 'image-provider')
    }
    const taskId = task?.output?.task_id
    if (!taskId) throw jsonError(text.slice(0, 400) || '通义万相没有返回 task_id', 'image-provider')
    const deadline = Date.now() + settings.timeoutMs
    while (Date.now() < deadline) {
      await sleep(2000)
      const poll = await fetch(`${base}/api/v1/tasks/${encodeURIComponent(taskId)}`, {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(30_000),
      })
      const pollText = await poll.text()
      if (!poll.ok) {
        throw jsonError(`通义万相任务查询失败 HTTP ${poll.status}：${pollText.slice(0, 400)}`, 'image-provider')
      }
      let status
      try {
        status = JSON.parse(pollText)
      } catch {
        continue
      }
      const state = String(status?.output?.task_status ?? '').toUpperCase()
      if (state === 'FAILED' || state === 'CANCELED') {
        throw jsonError(status?.output?.message ?? status?.message ?? `通义万相任务 ${state}`, 'image-provider')
      }
      if (state !== 'SUCCEEDED') continue
      const results = Array.isArray(status?.output?.results) ? status.output.results : []
      const images = []
      for (let index = 0; index < results.length; index += 1) {
        const item = results[index]
        let buffer = null
        if (typeof item?.url === 'string' && /^https?:\/\//i.test(item.url)) {
          buffer = await fetchImageBuffer(item.url, settings.timeoutMs)
        } else if (typeof item?.b64_image === 'string') {
          buffer = Buffer.from(item.b64_image, 'base64')
        }
        if (buffer && buffer.length >= 256) images.push(await saveGeneratedImage(buffer, prompt, index))
      }
      if (images.length === 0) throw jsonError('通义万相任务完成，但没有可用图片', 'image-provider')
      return images
    }
    throw jsonError('通义万相任务超时', 'image-timeout')
  }

  async function imageGenerate(body) {
    const prompt = cleanText(body.prompt, 4000)
    if (prompt === '') throw jsonError('请先输入生图提示词', 'empty-prompt')
    const settings = imageProviderConfig()
    const model = String(body.model ?? '').trim() || settings.model
    if (!settings.models.includes(model)) {
      throw jsonError(`模型 ${model} 不在当前允许列表：${settings.models.join(', ')}`, 'image-model')
    }
    const size = parseImageSize(body.size, settings.size.text)
    const n = clamp(Math.round(Number(body.n) || 1), 1, 4)
    const quality = ['low', 'medium', 'high', 'auto'].includes(body.quality) ? body.quality : settings.quality
    const scoped = { ...settings, model }

    const images =
      settings.style === 'pollinations'
        ? await generateImagesPollinations(scoped, prompt, size, n)
        : settings.style === 'dashscope'
          ? await generateImagesDashScope(scoped, prompt, size, n)
          : await generateImagesOpenAI(scoped, prompt, size, n, quality, settings.style)

    return {
      prompt,
      provider: settings.provider,
      providerLabel: settings.label,
      model,
      size: size.text,
      quality: quality || null,
      images,
    }
  }

  // ------------------------------------------------------------------ media probe

  async function probeMedia(path) {
    const engines = await detectEngines()
    if (!engines.video.ok) throw jsonError('FFmpeg 不可用，无法读取媒体信息', 'no-ffmpeg')
    if (engines.video.ffprobe) {
      const result = await run(
        engines.video.ffprobe,
        ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
        { timeout: 60_000 },
      )
      if (result.code !== 0) throw jsonError(result.stderr.trim() || 'ffprobe 读取失败', 'probe')
      let parsed
      try {
        parsed = JSON.parse(result.stdout)
      } catch {
        throw jsonError('ffprobe 返回了无法解析的结果', 'probe')
      }
      const streams = Array.isArray(parsed.streams) ? parsed.streams : []
      const video = streams.find((stream) => stream.codec_type === 'video')
      const audio = streams.find((stream) => stream.codec_type === 'audio')
      const duration = Number(parsed.format?.duration ?? video?.duration ?? audio?.duration ?? 0)
      return {
        duration: Number.isFinite(duration) ? duration : 0,
        width: Number(video?.width) || 0,
        height: Number(video?.height) || 0,
        fps: parseFps(video?.avg_frame_rate ?? video?.r_frame_rate),
        videoCodec: video?.codec_name ?? '',
        audioCodec: audio?.codec_name ?? '',
        hasAudio: Boolean(audio),
        hasVideo: Boolean(video),
      }
    }
    const result = await run(engines.video.ffmpeg, ['-hide_banner', '-i', path], { timeout: 60_000 })
    const meta = ffmpegProbeFallback(result.stderr)
    if (!meta.duration && !meta.hasVideo && !meta.hasAudio) {
      throw jsonError(result.stderr.trim().split(/\r?\n/).pop() || '无法读取媒体', 'probe')
    }
    return meta
  }

  async function makeThumbnail(path, duration) {
    const engines = await detectEngines()
    if (!engines.video.ok) return null
    const tmp = join(outputs.tmp, `thumb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`)
    await mkdir(outputs.tmp, { recursive: true })
    const seek = duration > 1.2 ? Math.min(duration / 2, 8) : 0
    const result = await run(
      engines.video.ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        String(seek),
        '-i',
        path,
        '-frames:v',
        '1',
        '-vf',
        'scale=680:-2:force_original_aspect_ratio=decrease',
        '-q:v',
        '4',
        '-y',
        tmp,
      ],
      { timeout: 60_000 },
    )
    if (result.code !== 0) return null
    try {
      const data = await readFile(tmp)
      return `data:image/jpeg;base64,${data.toString('base64')}`
    } catch {
      return null
    } finally {
      void unlink(tmp).catch(() => {})
    }
  }

  async function videoInspect(body) {
    const path = pathFromInput(body.path)
    if (!(await exists(path))) throw jsonError(`视频不存在：${path}`, 'missing-file')
    const meta = await probeMedia(path)
    if (!meta.hasVideo) throw jsonError('这个文件里没有视频轨道', 'no-video')
    const preview = await makeThumbnail(path, meta.duration)
    const asset = await registerOutput(path, {
      width: meta.width,
      height: meta.height,
      duration: meta.duration,
      kind: 'video',
    })
    return { ...meta, preview, asset }
  }

  async function audioInspect(body) {
    const path = pathFromInput(body.path)
    if (!(await exists(path))) throw jsonError(`音频不存在：${path}`, 'missing-file')
    const meta = await probeMedia(path)
    const asset = await registerOutput(path, { duration: meta.duration, kind: 'audio' })
    return { ...meta, asset }
  }

  // ------------------------------------------------------------------ language-guided edit

  function parsePlanTime(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    const text = String(value ?? '').trim()
    if (/^\d+(\.\d+)?$/.test(text)) return Number(text)
    const parts = text.split(':').map(Number)
    if (parts.length === 3 && parts.every(Number.isFinite)) return parts[0] * 3600 + parts[1] * 60 + parts[2]
    if (parts.length === 2 && parts.every(Number.isFinite)) return parts[0] * 60 + parts[1]
    return NaN
  }

  async function transcribeVideo(body) {
    const engines = await detectEngines()
    if (!engines.video.ok) throw jsonError('转写需要 FFmpeg', 'no-ffmpeg')
    const path = pathFromInput(body.path)
    if (!(await exists(path))) throw jsonError(`视频不存在：${path}`, 'missing-file')
    const settings = asrConfig()
    const key = await resolveAsrKey()
    if (key === '') throw jsonError(`缺少 ${settings.keyEnv}，请先保存 ASR API Key`, 'missing-key')
    await mkdir(outputs.tmp, { recursive: true })
    const wav = join(outputs.tmp, `asr-${stamp()}-${Math.random().toString(36).slice(2, 6)}.wav`)
    const prepared = await run(
      engines.video.ffmpeg,
      ['-hide_banner', '-y', '-i', path, '-vn', '-ac', '1', '-ar', '16000', wav],
      { timeout: 180_000 },
    )
    if (prepared.code !== 0) throw jsonError('提取音频失败', 'ffmpeg')
    try {
      const form = new FormData()
      form.append('file', new Blob([await readFile(wav)], { type: 'audio/wav' }), 'audio.wav')
      form.append('model', settings.model)
      form.append('response_format', 'verbose_json')
      form.append('timestamp_granularities[]', 'segment')
      const response = await fetch(`${settings.baseURL.replace(/\/+$/, '')}/audio/transcriptions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}` },
        body: form,
        signal: AbortSignal.timeout(settings.timeoutMs),
      })
      const text = await response.text()
      if (!response.ok) throw jsonError(`转写 API 返回 HTTP ${response.status}：${text.slice(0, 400)}`, 'asr-http')
      let payload
      try {
        payload = JSON.parse(text)
      } catch {
        throw jsonError('转写 API 返回的不是 JSON', 'asr-json')
      }
      const segments = Array.isArray(payload?.segments)
        ? payload.segments
            .filter((item) => item && Number.isFinite(Number(item.start)) && typeof item.text === 'string')
            .map((item) => ({
              start: Number(item.start),
              end: Number(item.end),
              text: String(item.text).trim(),
            }))
        : []
      const stampText = (seconds) => {
        const m = Math.floor(seconds / 60)
        const s = Math.floor(seconds % 60)
        return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      }
      const lines = segments.map((item) => `${stampText(item.start)} ${item.text}`).join('\n')
      return {
        text: lines || String(payload?.text ?? '').trim(),
        segments,
        model: settings.model,
        language: payload?.language ?? '',
      }
    } finally {
      await unlink(wav).catch(() => {})
    }
  }

  async function videoPlan(body) {
    const engines = await detectEngines()
    if (!engines.video.ok) throw jsonError('FFmpeg 不可用，无法分析视频', 'no-ffmpeg')
    const path = pathFromInput(body.path)
    if (!(await exists(path))) throw jsonError(`视频不存在：${path}`, 'missing-file')
    const prompt = String(body.prompt ?? '').trim()
    const transcript = cleanText(body.transcript, 8000)
    if (prompt.length < 4) throw jsonError('请用一句话描述想要的剪辑效果', 'empty-prompt')
    const meta = await probeMedia(path)
    if (!meta.hasVideo) throw jsonError('这个文件里没有视频轨道', 'no-video')
    const llm = llmConfig()
    const key = await resolveLlmKey()
    if (key === '' && !/^https?:\/\/(127\.0\.0\.1|localhost)/i.test(llm.baseURL)) {
      throw jsonError('语言剪辑 API 未配置 Key。请到“设置 → 语言剪辑 API”填写。', 'no-llm-key')
    }
    const duration = Math.max(0.1, Number(meta.duration) || 0.1)
    const targetSeconds = clamp(Number(body.targetSeconds) || 0, 0, duration)
    const frameCount = Math.min(12, Math.max(4, Math.ceil(duration / 5)))
    const times = Array.from({ length: frameCount }, (_, i) => (duration * (i + 0.5)) / frameCount)
    await mkdir(outputs.tmp, { recursive: true })
    const images = []
    try {
      for (let i = 0; i < times.length; i += 1) {
        const out = join(outputs.tmp, `plan-${stamp()}-${i}.jpg`)
        const result = await run(
          engines.video.ffmpeg,
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-ss',
            times[i].toFixed(3),
            '-i',
            path,
            '-frames:v',
            '1',
            '-vf',
            'scale=640:-2:force_original_aspect_ratio=decrease',
            '-q:v',
            '4',
            '-y',
            out,
          ],
          { timeout: 60_000 },
        )
        if (result.code === 0 && (await exists(out))) {
          images.push({
            time: times[i],
            data: `data:image/jpeg;base64,${(await readFile(out)).toString('base64')}`,
          })
          await unlink(out).catch(() => {})
        }
      }
    } catch {
      /* keep whatever frames were extracted */
    }
    if (images.length === 0) throw jsonError('无法从视频中抽取画面', 'no-frames')

    const frameText = images
      .map((image, i) => `Frame ${i + 1}: t=${image.time.toFixed(2)}s`)
      .join('\n')
    const system =
      'You are a professional short-video editor. You will see sampled frames from one video with their timestamps. ' +
      'Choose the contiguous source ranges that best satisfy the user request. Return ONLY valid JSON, no markdown. ' +
      'Use source seconds (not output seconds). Each range must have start < end and be inside the source duration. ' +
      'Prefer 2-6 ranges, each 1-12 seconds; avoid cutting inside a word/action when possible. ' +
      'JSON shape: {"summary":"one sentence","segments":[{"start":0,"end":5.2,"reason":"why"}]}'
    const userText =
      `Source duration: ${duration.toFixed(2)}s\n` +
      (targetSeconds > 0 ? `Target total duration: about ${targetSeconds.toFixed(1)}s\n` : '') +
      `User request: ${prompt}\n\n` +
      (transcript ? `Transcript / subtitle cues (use these timestamps and text when choosing ranges):\n${transcript}\n\n` : '') +
      `Sampled frames:\n${frameText}\n\n` +
      'Select the source ranges. The output order is the playback order.'
    const content = [{ type: 'text', text: userText }]
    const isAnthropic = llm.protocol === 'anthropic'
    for (const image of images) {
      if (isAnthropic) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: image.data.split(',')[1] ?? '' },
        })
      } else {
        content.push({ type: 'image_url', image_url: { url: image.data } })
      }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), llm.timeoutMs)
    let response
    const baseRoot = llm.baseURL.replace(/\/+$/, '').replace(/\/v1$/i, '')
    const endpoint = isAnthropic ? `${baseRoot}/v1/messages` : `${baseRoot}/chat/completions`
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(key !== '' ? { authorization: `Bearer ${key}` } : {}),
          ...(isAnthropic && key !== '' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : {}),
        },
        body: JSON.stringify(
          isAnthropic
            ? {
                model: llm.model,
                temperature: 0.2,
                max_tokens: 1200,
                system,
                messages: [{ role: 'user', content }],
              }
            : {
                model: llm.model,
                temperature: 0.2,
                max_tokens: 1200,
                messages: [
                  { role: 'system', content: system },
                  { role: 'user', content },
                ],
              },
        ),
        signal: controller.signal,
      })
    } catch (error) {
      clearTimeout(timer)
      throw jsonError(`语言剪辑 API 请求失败：${error?.message ?? error}`, 'llm-fetch')
    }
    clearTimeout(timer)
    const text = await response.text()
    if (!response.ok) {
      throw jsonError(`语言剪辑 API 返回 HTTP ${response.status}：${text.slice(0, 300)}`, 'llm-http')
    }
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      throw jsonError(`语言剪辑 API 返回的不是 JSON：${text.slice(0, 200)}`, 'llm-json')
    }
    let raw = ''
    if (Array.isArray(payload?.content)) {
      raw = payload.content
        .filter((part) => part?.type === 'text')
        .map((part) => part?.text ?? '')
        .join('')
    } else {
      raw = payload?.choices?.[0]?.message?.content ?? payload?.content ?? ''
      if (Array.isArray(raw)) raw = raw.map((part) => part?.text ?? '').join('')
    }
    raw = String(raw).trim()
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start >= 0 && end > start) raw = raw.slice(start, end + 1)
    let plan
    try {
      plan = JSON.parse(raw)
    } catch {
      throw jsonError('视觉模型没有返回可解析的剪辑方案，请换一个支持图片输入的模型。', 'llm-plan-json')
    }
    const list = Array.isArray(plan?.segments) ? plan.segments : Array.isArray(plan?.clips) ? plan.clips : []
    const segments = []
    for (const item of list.slice(0, 8)) {
      let from = parsePlanTime(item?.start)
      let to = parsePlanTime(item?.end)
      if (!Number.isFinite(from) || !Number.isFinite(to)) continue
      from = clamp(from, 0, Math.max(0, duration - 0.05))
      to = clamp(to, from + 0.3, duration)
      if (!(to > from + 0.2)) continue
      segments.push({
        start: round(from),
        end: round(to),
        reason: String(item?.reason ?? '').slice(0, 160),
      })
    }
    if (segments.length === 0) throw jsonError('视觉模型没有选出有效片段，请把描述写得更具体。', 'llm-empty-plan')
    return {
      prompt,
      summary: String(plan?.summary ?? '已根据描述生成剪辑方案').slice(0, 240),
      segments,
      model: llm.model,
      frames: images.length,
      duration,
      targetSeconds,
      total: round(segments.reduce((sum, item) => sum + item.end - item.start, 0)),
    }
  }

  // ------------------------------------------------------------------ video export

  async function videoFrame(body) {
    const engines = await detectEngines()
    if (!engines.video.ok) throw jsonError('FFmpeg 不可用，无法截取封面', 'no-ffmpeg')
    const path = pathFromInput(body.path)
    if (!(await exists(path))) throw jsonError(`视频不存在：${path}`, 'missing-file')
    const meta = await probeMedia(path)
    if (!meta.hasVideo) throw jsonError('这个文件里没有视频轨道', 'no-video')
    const at = clamp(Number(body.time) || 0, 0, Math.max(0, meta.duration - 0.05))
    await mkdir(outputs.image, { recursive: true })
    const out = join(
      outputs.image,
      `cover-${stamp()}-${safeFileStem(basename(path, extname(path)))}.jpg`,
    )
    const result = await run(
      engines.video.ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-ss', at.toFixed(3), '-i', path, '-frames:v', '1', '-q:v', '2', '-y', out],
      { timeout: 60_000 },
    )
    if (result.code !== 0) {
      throw jsonError(result.stderr.trim().split(/\r?\n/).slice(-4).join('\n') || '截取封面失败', 'frame')
    }
    const frameMeta = await imageMeta(out)
    const asset = await registerOutput(out, {
      kind: 'image',
      width: frameMeta.width,
      height: frameMeta.height,
      coverTime: at,
    })
    return { asset, time: at, duration: meta.duration, width: frameMeta.width, height: frameMeta.height }
  }

  async function videoExport(body) {
    const engines = await detectEngines()
    if (!engines.video.ok) throw jsonError('FFmpeg 不可用，无法导出视频', 'no-ffmpeg')

    const clips = Array.isArray(body.clips) ? body.clips.slice(0, 20) : []
    if (clips.length === 0) throw jsonError('至少需要一个视频片段', 'no-clips')

    const prepared = []
    for (const clip of clips) {
      const path = pathFromInput(clip.path)
      if (!(await exists(path))) throw jsonError(`片段不存在：${path}`, 'missing-file')
      const meta = await probeMedia(path)
      if (!meta.hasVideo) throw jsonError(`没有视频轨道：${basename(path)}`, 'no-video')
      const duration = Math.max(0.05, meta.duration || 0.05)
      const start = clamp(Number(clip.start) || 0, 0, Math.max(0, duration - 0.05))
      let end = clamp(Number(clip.end) || duration, start + 0.05, duration)
      if (!(end > start)) end = duration
      prepared.push({ path, start, end, duration: end - start, meta })
    }

    const resolution = String(body.resolution ?? '1080p')
    let width = 1920
    let height = 1080
    if (resolution === 'source') {
      const first = prepared[0].meta
      width = Math.max(2, (first.width || 1920) - ((first.width || 1920) % 2))
      height = Math.max(2, (first.height || 1080) - ((first.height || 1080) % 2))
    } else if (resolution === '720p') {
      width = 1280
      height = 720
    } else if (resolution === 'vertical') {
      width = 1080
      height = 1920
    } else if (resolution === 'square') {
      width = 1080
      height = 1080
    }
    const fps = [24, 25, 30, 60].includes(Number(body.fps)) ? Number(body.fps) : 30
    const crf = clamp(Number(body.crf) || 22, 14, 32)
    const mute = body.mute === true
    const audioMode = ['replace', 'mix'].includes(body.audioMode) ? body.audioMode : 'none'
    const audioPath = body.audioPath ? pathFromInput(body.audioPath) : null
    if (audioMode !== 'none') {
      if (!audioPath || !(await exists(audioPath))) throw jsonError('配音音轨不存在', 'missing-audio')
    }
    const subtitlePath = body.subtitlePath ? pathFromInput(body.subtitlePath) : null
    if (subtitlePath && !(await exists(subtitlePath))) throw jsonError('字幕文件不存在', 'missing-subtitle')

    const total = prepared.reduce((sum, clip) => sum + clip.duration, 0)
    if (total <= 0) throw jsonError('片段总时长为 0', 'empty-timeline')

    const jobId = createHash('sha1').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 12)
    const out = join(outputs.video, `${stamp()}-${safeFileStem(body.name || 'edit')}.mp4`)
    await mkdir(outputs.video, { recursive: true })
    await mkdir(outputs.tmp, { recursive: true })

    const args = ['-hide_banner', '-y']
    for (const clip of prepared) {
      args.push('-ss', clip.start.toFixed(3), '-t', clip.duration.toFixed(3), '-i', clip.path)
    }
    let externalAudioIndex = -1
    if (audioMode !== 'none') {
      args.push('-stream_loop', '-1', '-i', audioPath)
      externalAudioIndex = prepared.length
    }
    let subtitleIndex = -1
    if (subtitlePath) {
      subtitleIndex = prepared.length + (audioMode !== 'none' ? 1 : 0)
      args.push('-i', subtitlePath)
    }

    const filters = []
    for (let index = 0; index < prepared.length; index += 1) {
      const clip = prepared[index]
      filters.push(
        `[${index}:v]trim=duration=${clip.duration.toFixed(3)},setpts=PTS-STARTPTS,` +
          `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
          `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}[v${index}]`,
      )
      if (!mute) {
        if (clip.meta.hasAudio) {
          filters.push(
            `[${index}:a]atrim=duration=${clip.duration.toFixed(3)},asetpts=PTS-STARTPTS,` +
              `aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${index}]`,
          )
        } else {
          filters.push(
            `anullsrc=r=44100:cl=stereo,atrim=duration=${clip.duration.toFixed(3)},` +
              `aformat=sample_fmts=fltp:channel_layouts=stereo[a${index}]`,
          )
        }
      }
    }

    const concatInputs = prepared.map((_, index) => (mute ? `[v${index}]` : `[v${index}][a${index}]`)).join('')
    filters.push(
      `${concatInputs}concat=n=${prepared.length}:v=1:a=${mute ? 0 : 1}[vout]${mute ? '' : '[aout]'}`,
    )
    if (!mute && audioMode === 'replace') {
      filters.push(
        `[${externalAudioIndex}:a]atrim=duration=${total.toFixed(3)},asetpts=PTS-STARTPTS,` +
          `aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=1.0[voice]`,
      )
      // The concat filter must still have its audio output consumed, even
      // though the original audio is replaced by the voice track.
      filters.push('[aout]anullsink')
    } else if (!mute && audioMode === 'mix') {
      filters.push(
        `[${externalAudioIndex}:a]atrim=duration=${total.toFixed(3)},asetpts=PTS-STARTPTS,` +
          `aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=0.42[voice]`,
      )
      filters.push(
        `[aout][voice]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout2]`,
      )
    }

    args.push('-filter_complex', filters.join(';'))
    args.push('-map', '[vout]')
    if (!mute) {
      args.push('-map', audioMode === 'none' ? '[aout]' : audioMode === 'mix' ? '[aout2]' : '[voice]')
    }
    args.push(
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      String(crf),
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
    )
    if (!mute) args.push('-c:a', 'aac', '-b:a', '192k')
    if (subtitleIndex >= 0) {
      args.push(
        '-map',
        `${subtitleIndex}:s:0`,
        '-c:s',
        'mov_text',
        '-metadata:s:s:0',
        'language=zho',
      )
    }
    args.push('-t', total.toFixed(3), '-progress', 'pipe:1', '-nostats', out)

    const job = {
      id: jobId,
      status: 'running',
      progress: 0,
      message: '正在剪辑…',
      createdAt: Date.now(),
      output: out,
      total,
      asset: null,
      error: null,
      log: '',
    }
    jobs.set(jobId, job)

    // Keep the HTTP response quick; the browser polls job/status.
    void (async () => {
      try {
        await new Promise((resolvePromise, reject) => {
          const child = spawn(engines.video.ffmpeg, args, { windowsHide: true })
          let stderr = ''
          let stdout = ''
          let killed = false
          const timer = setTimeout(() => {
            killed = true
            child.kill()
            reject(jsonError('视频导出超时（30 分钟）', 'timeout'))
          }, 30 * 60 * 1000)
          child.stdout.on('data', (chunk) => {
            stdout += chunk.toString('utf8')
            let index
            while ((index = stdout.indexOf('\n')) >= 0) {
              const line = stdout.slice(0, index).trim()
              stdout = stdout.slice(index + 1)
              if (line.startsWith('out_time=')) {
                const parts = line.slice(9).split(':').map(Number)
                if (parts.length === 3 && parts.every(Number.isFinite)) {
                  const seconds = parts[0] * 3600 + parts[1] * 60 + parts[2]
                  job.progress = clamp(Math.round((seconds / total) * 100), 0, 99)
                  job.message = `正在渲染 ${job.progress}%`
                }
              } else if (line === 'progress=end') {
                job.progress = 99
              }
            }
          })
          child.stderr.on('data', (chunk) => {
            stderr += chunk.toString('utf8')
            if (stderr.length > 16_000) stderr = stderr.slice(-16_000)
            job.log = stderr
          })
          child.on('error', (error) => {
            clearTimeout(timer)
            reject(jsonError(`FFmpeg 启动失败：${error.message}`, 'spawn'))
          })
          child.on('close', (code) => {
            clearTimeout(timer)
            if (killed) return
            if (code === 0) resolvePromise()
            else reject(jsonError(stderr.trim().split(/\r?\n/).slice(-6).join('\n') || `FFmpeg 退出码 ${code}`, 'ffmpeg'))
          })
        })
        const meta = await probeMedia(out)
        const asset = await registerOutput(out, {
          width,
          height,
          duration: meta.duration,
          kind: 'video',
          clips: prepared.length,
          total,
          subtitles: subtitleIndex >= 0,
        })
        job.status = 'done'
        job.progress = 100
        job.message = '导出完成'
        job.asset = asset
      } catch (error) {
        job.status = 'error'
        job.error = String(error?.message ?? error)
        job.message = '导出失败'
        void unlink(out).catch(() => {})
      }
    })()

    return { jobId, total, width, height, fps, clips: prepared.length }
  }

  async function jobStatus(body) {
    const job = jobs.get(String(body.jobId ?? ''))
    if (!job) throw jsonError('找不到这个导出任务', 'no-job')
    return {
      id: job.id,
      status: job.status,
      progress: job.progress,
      message: job.message,
      error: job.error,
      asset: job.asset,
      total: job.total,
      createdAt: job.createdAt,
    }
  }

  // ------------------------------------------------------------------ Premiere XML

  async function videoPremiere(body) {
    const clips = Array.isArray(body.clips) ? body.clips.slice(0, 20) : []
    if (clips.length === 0) throw jsonError('至少需要一个视频片段', 'no-clips')

    const prepared = []
    for (const clip of clips) {
      const path = pathFromInput(clip.path)
      if (!(await exists(path))) throw jsonError(`片段不存在：${path}`, 'missing-file')
      const meta = await probeMedia(path)
      if (!meta.hasVideo) throw jsonError(`没有视频轨道：${basename(path)}`, 'no-video')
      const duration = Math.max(0.05, meta.duration || 0.05)
      const start = clamp(Number(clip.start) || 0, 0, Math.max(0, duration - 0.05))
      let end = clamp(Number(clip.end) || duration, start + 0.05, duration)
      if (!(end > start)) end = duration
      prepared.push({ path, start, end, duration: end - start, meta })
    }

    const resolution = String(body.resolution ?? '1080p')
    let width = 1920
    let height = 1080
    if (resolution === 'source') {
      const first = prepared[0].meta
      width = Math.max(2, (first.width || 1920) - ((first.width || 1920) % 2))
      height = Math.max(2, (first.height || 1080) - ((first.height || 1080) % 2))
    } else if (resolution === '720p') {
      width = 1280
      height = 720
    } else if (resolution === 'vertical') {
      width = 1080
      height = 1920
    } else if (resolution === 'square') {
      width = 1080
      height = 1080
    }
    const fps = [24, 25, 30, 60].includes(Number(body.fps)) ? Number(body.fps) : 30
    const mute = body.mute === true
    const audioMode = ['replace', 'mix'].includes(body.audioMode) ? body.audioMode : 'none'
    const audioPath = body.audioPath ? pathFromInput(body.audioPath) : null
    if (audioMode !== 'none' && (!audioPath || !(await exists(audioPath)))) {
      throw jsonError('配音音轨不存在', 'missing-audio')
    }
    const totalSeconds = prepared.reduce((sum, clip) => sum + clip.duration, 0)
    const totalFrames = Math.max(1, Math.round(totalSeconds * fps))
    const toFrames = (seconds) => Math.max(0, Math.round(seconds * fps))

    let nextFileId = 1
    let nextClipId = 1

    const fileXml = (path, meta, includeAudio, includeVideo = true) => {
      const id = `file-${nextFileId}`
      nextFileId += 1
      const sourceFrames = Math.max(1, Math.round((meta.duration || totalSeconds) * fps))
      const sourceFps = [24, 25, 30, 60].includes(Math.round(meta.fps)) ? Math.round(meta.fps) : fps
      const audioXml = includeAudio
        ? `<audio><samplecharacteristics><depth>16</depth><samplerate>44100</samplerate></samplecharacteristics><channelcount>2</channelcount></audio>`
        : ''
      const videoXml = includeVideo
        ? `<video><samplecharacteristics>` +
          `<rate><timebase>${sourceFps}</timebase><ntsc>FALSE</ntsc></rate>` +
          `<width>${Math.max(2, meta.width || width)}</width><height>${Math.max(2, meta.height || height)}</height>` +
          `<anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance>` +
          `</samplecharacteristics></video>`
        : ''
      return (
        `<file id="${id}">` +
        `<name>${xmlEscape(basename(path))}</name>` +
        `<pathurl>${xmlEscape(fileXmlUrl(path))}</pathurl>` +
        `<rate><timebase>${sourceFps}</timebase><ntsc>FALSE</ntsc></rate>` +
        `<duration>${sourceFrames}</duration>` +
        `<media>${videoXml}${audioXml}</media></file>`
      )
    }

    const videoItems = []
    let timelineFrame = 0
    for (const clip of prepared) {
      const startFrame = timelineFrame
      const clipFrames = Math.max(1, toFrames(clip.duration))
      const endFrame = startFrame + clipFrames
      const inFrame = toFrames(clip.start)
      const outFrame = inFrame + clipFrames
      videoItems.push(
        `<clipitem id="clipitem-${nextClipId}">` +
          `<name>${xmlEscape(basename(clip.path))}</name>` +
          `<duration>${Math.max(1, toFrames(clip.meta.duration || clip.duration))}</duration>` +
          `<rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate>` +
          `<start>${startFrame}</start><end>${endFrame}</end>` +
          `<in>${inFrame}</in><out>${outFrame}</out>` +
          fileXml(clip.path, clip.meta, true, true) +
          `</clipitem>`,
      )
      nextClipId += 1
      timelineFrame = endFrame
    }

    const audioItems = []
    if (!mute && audioMode !== 'replace') {
      let audioFrame = 0
      for (const clip of prepared) {
        if (!clip.meta.hasAudio) {
          audioFrame += Math.max(1, toFrames(clip.duration))
          continue
        }
        const clipFrames = Math.max(1, toFrames(clip.duration))
        audioItems.push(
          `<clipitem id="clipitem-${nextClipId}">` +
            `<name>${xmlEscape(basename(clip.path))}</name>` +
            `<duration>${Math.max(1, toFrames(clip.meta.duration || clip.duration))}</duration>` +
            `<rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate>` +
            `<start>${audioFrame}</start><end>${audioFrame + clipFrames}</end>` +
            `<in>${toFrames(clip.start)}</in><out>${toFrames(clip.start) + clipFrames}</out>` +
            fileXml(clip.path, clip.meta, true, false) +
            `<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>` +
            `</clipitem>`,
        )
        nextClipId += 1
        audioFrame += clipFrames
      }
    }

    const voiceItems = []
    if (!mute && audioMode !== 'none' && audioPath) {
      const voiceMeta = await probeMedia(audioPath)
      const voiceFrames = Math.max(1, Math.min(totalFrames, toFrames(voiceMeta.duration || totalSeconds)))
      voiceItems.push(
        `<clipitem id="clipitem-${nextClipId}">` +
          `<name>${xmlEscape(basename(audioPath))}</name>` +
          `<duration>${voiceFrames}</duration>` +
          `<rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate>` +
          `<start>0</start><end>${voiceFrames}</end><in>0</in><out>${voiceFrames}</out>` +
          fileXml(audioPath, voiceMeta, true, false) +
          `<sourcetrack><mediatype>audio</mediatype><trackindex>${audioItems.length > 0 ? 2 : 1}</trackindex></sourcetrack>` +
          `</clipitem>`,
      )
      nextClipId += 1
    }

    const videoTrack = `<track>${videoItems.join('')}</track>`
    const audioTracks = []
    if (audioItems.length > 0) audioTracks.push(`<track>${audioItems.join('')}</track>`)
    if (voiceItems.length > 0) audioTracks.push(`<track>${voiceItems.join('')}</track>`)
    const audioBlock =
      audioTracks.length > 0
        ? `<audio><format><samplecharacteristics><depth>16</depth><samplerate>44100</samplerate></samplecharacteristics></format>` +
          `<outputs><group><index>1</index><numchannels>2</numchannels><downmix>0</downmix></group></outputs>` +
          audioTracks.join('') +
          `</audio>`
        : ''

    const sequenceName = safeFileStem(body.name || 'DSH Creative Console', 'DSH Sequence')
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="4">\n` +
      `<sequence id="sequence-1">` +
      `<name>${xmlEscape(sequenceName)}</name>` +
      `<duration>${totalFrames}</duration>` +
      `<rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate>` +
      `<timecode><rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate><string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>` +
      `<media><video><format><samplecharacteristics>` +
      `<rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate>` +
      `<width>${width}</width><height>${height}</height>` +
      `<anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance>` +
      `</samplecharacteristics></format>${videoTrack}</video>${audioBlock}</media>` +
      `</sequence>\n</xmeml>\n`

    await mkdir(outputs.premiere, { recursive: true })
    const path = join(outputs.premiere, `${stamp()}-${safeFileStem(body.name || 'premiere')}.xml`)
    await writeFile(path, xml, 'utf8')
    const asset = await registerOutput(path, {
      kind: 'file',
      width,
      height,
      duration: totalSeconds,
      premiere: true,
      clips: prepared.length,
    })
    return {
      asset,
      path,
      width,
      height,
      fps,
      duration: totalSeconds,
      clips: prepared.length,
      audioTracks: audioTracks.length,
      note: 'FCP XML 已生成；未连接 Premiere。请在 Premiere 中选择“文件 → 导入”手动导入。',
    }
  }

  // ------------------------------------------------------------------ subtitles

  async function subtitleInspect(body) {
    const path = pathFromInput(body.path)
    if (!(await exists(path))) throw jsonError(`字幕文件不存在：${path}`, 'missing-file')
    const cues = parseSrt(await readFile(path, 'utf8'))
    if (cues.length === 0) throw jsonError('没有解析到有效字幕条目', 'empty-subtitle')
    return {
      path,
      name: basename(path),
      cues: cues.length,
      duration: cues[cues.length - 1].end,
      first: cues.slice(0, 5).map((cue) => cue.text),
    }
  }

  async function subtitleApply(body) {
    const engines = await detectEngines()
    if (!engines.video.ok) throw jsonError('FFmpeg 不可用，无法处理字幕', 'no-ffmpeg')
    const videoPath = pathFromInput(body.videoPath)
    const srtPath = pathFromInput(body.srtPath)
    if (!(await exists(videoPath))) throw jsonError(`视频不存在：${videoPath}`, 'missing-file')
    if (!(await exists(srtPath))) throw jsonError(`字幕不存在：${srtPath}`, 'missing-subtitle')
    const cues = parseSrt(await readFile(srtPath, 'utf8'))
    if (cues.length === 0) throw jsonError('没有解析到有效字幕条目', 'empty-subtitle')
    if (cues.length > 30) throw jsonError('一键字幕配音最多支持 30 条字幕，请拆分 SRT', 'too-many-cues')
    const meta = await probeMedia(videoPath)
    if (!meta.hasVideo) throw jsonError('这个文件里没有视频轨道', 'no-video')
    const duration = Math.max(0.1, meta.duration || cues[cues.length - 1].end)
    const mode = body.mode === 'voiceover' ? 'voiceover' : 'soft'
    await mkdir(outputs.video, { recursive: true })
    await mkdir(outputs.tmp, { recursive: true })
    const jobId = createHash('sha1').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 10)
    const out = join(
      outputs.video,
      `${stamp()}-${safeFileStem(body.name || basename(videoPath, extname(videoPath)))}-${mode}.mp4`,
    )

    if (mode === 'soft') {
      const result = await run(
        engines.video.ffmpeg,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          videoPath,
          '-i',
          srtPath,
          '-map',
          '0:v:0',
          '-map',
          '0:a?',
          '-map',
          '1:s:0',
          '-c',
          'copy',
          '-c:s',
          'mov_text',
          '-metadata:s:s:0',
          'language=zho',
          '-t',
          duration.toFixed(3),
          '-y',
          out,
        ],
        { timeout: 5 * 60 * 1000 },
      )
      if (result.code !== 0) {
        throw jsonError(result.stderr.trim().split(/\r?\n/).slice(-5).join('\n') || '字幕封装失败', 'subtitle-mux')
      }
    } else {
      if (!engines.tts.ok) throw jsonError('语音引擎不可用，无法一键字幕配音', 'no-tts-engine')
      const voice =
        typeof body.voice === 'string' && /^[a-z]{2,3}-[A-Za-z]{2,4}-[A-Za-z0-9]+Neural$/.test(body.voice)
          ? body.voice
          : 'zh-CN-XiaoxiaoNeural'
      const preset = allVoicePresets().find((item) => item.id === body.preset) ?? VOICE_PRESETS[0]
      const workDir = join(outputs.tmp, `sub-${jobId}`)
      await mkdir(workDir, { recursive: true })
      const tempFiles = []
      const args = []
      try {
        for (let index = 0; index < cues.length; index += 1) {
          const cue = cues[index]
          const mp3 = join(workDir, `cue-${index}.mp3`)
          const wav = join(workDir, `cue-${index}.wav`)
          tempFiles.push(mp3, wav)
          const command = engines.tts.command
          const ttsArgs = command
            ? [
                '--voice',
                voice,
                '--text',
                cue.text,
                '--rate=+0%',
                '--pitch=+0Hz',
                '--volume=+0%',
                '--write-media',
                mp3,
              ]
            : [
                '-m',
                'edge_tts',
                '--voice',
                voice,
                '--text',
                cue.text,
                '--rate=+0%',
                '--pitch=+0Hz',
                '--volume=+0%',
                '--write-media',
                mp3,
              ]
          const ttsResult = await (async () => {
            let last = null
            for (let attempt = 0; attempt < 3; attempt += 1) {
              if (attempt > 0) {
                await unlink(mp3).catch(() => {})
                await sleep(800 * attempt)
              }
              last = await run(command ?? engines.tts.python, ttsArgs, { timeout: 60_000 })
              if (last.code === 0) {
                try {
                  const info = await stat(mp3)
                  if (info.size > 0) return last
                } catch {
                  /* retry */
                }
              }
            }
            return last
          })()
          if (!ttsResult || ttsResult.code !== 0) {
            throw jsonError(
              ttsResult?.stderr?.trim().split(/\r?\n/).slice(-3).join(' ') || `字幕 ${index + 1} 配音失败（已重试）`,
              'tts-failed',
            )
          }
          const convert = await run(
            engines.video.ffmpeg,
            ['-hide_banner', '-loglevel', 'error', '-i', mp3, '-ar', '44100', '-ac', '1', '-y', wav],
            { timeout: 60_000 },
          )
          if (convert.code !== 0) throw jsonError(`字幕 ${index + 1} 音频转换失败`, 'subtitle-audio')
          args.push('-i', wav)
        }

        const filters = []
        for (let index = 0; index < cues.length; index += 1) {
          const cue = cues[index]
          const target = Math.max(0.35, Math.min(cue.end, duration) - cue.start)
          const info = await probeMedia(join(workDir, `cue-${index}.wav`)).catch(() => ({ duration: target }))
          const spoken = Math.max(0.1, info.duration || target)
          const tempo = clamp(spoken / target, 0.5, 2)
          const speed = Math.abs(tempo - 1) > 0.02 ? `atempo=${tempo.toFixed(5)},` : ''
          filters.push(
            `[${index}:a]${speed}aresample=44100,aformat=sample_fmts=fltp:channel_layouts=mono,` +
              `apad=whole_dur=${target.toFixed(3)},atrim=0:${target.toFixed(3)},` +
              `adelay=${Math.round(cue.start * 1000)}:all=1[c${index}]`,
          )
        }
        const mixInputs = cues.map((_, index) => `[c${index}]`).join('')
        const presetFilters = []
        if (preset.filter) presetFilters.push(preset.filter)
        if (preset.pitch !== 0) {
          presetFilters.unshift(`rubberband=pitch=${Math.pow(2, preset.pitch / 12).toFixed(5)}:formant=shifted`)
        }
        presetFilters.push('loudnorm=I=-16:TP=-1.5:LRA=11')
        presetFilters.push('aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo')
        presetFilters.push(`apad=whole_dur=${duration.toFixed(3)},atrim=0:${duration.toFixed(3)}`)
        filters.push(
          `${mixInputs}amix=inputs=${cues.length}:duration=longest:normalize=0,` +
            `${presetFilters.join(',')}[aout]`,
        )
        const voiceWav = join(workDir, 'voice.wav')
        tempFiles.push(voiceWav)
        const mix = await run(
          engines.video.ffmpeg,
          ['-hide_banner', '-y', ...args, '-filter_complex', filters.join(';'), '-map', '[aout]', voiceWav],
          { timeout: 10 * 60 * 1000 },
        )
        if (mix.code !== 0) {
          throw jsonError(mix.stderr.trim().split(/\r?\n/).slice(-5).join('\n') || '字幕配音混音失败', 'subtitle-mix')
        }

        const mux = await run(
          engines.video.ffmpeg,
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-i',
            videoPath,
            '-i',
            voiceWav,
            '-i',
            srtPath,
            '-map',
            '0:v:0',
            '-map',
            '1:a:0',
            '-map',
            '2:s:0',
            '-c:v',
            'copy',
            '-c:a',
            'aac',
            '-b:a',
            '192k',
            '-ar',
            '44100',
            '-ac',
            '2',
            '-c:s',
            'mov_text',
            '-metadata:s:s:0',
            'language=zho',
            '-shortest',
            '-t',
            duration.toFixed(3),
            '-y',
            out,
          ],
          { timeout: 10 * 60 * 1000 },
        )
        if (mux.code !== 0) {
          throw jsonError(mux.stderr.trim().split(/\r?\n/).slice(-5).join('\n') || '字幕配音封装失败', 'subtitle-mux')
        }
      } finally {
        for (const file of tempFiles) void unlink(file).catch(() => {})
        setTimeout(() => {
          void rm(workDir, { recursive: true, force: true }).catch(() => {})
        }, 2000).unref?.()
      }
    }

    const outMeta = await probeMedia(out)
    const asset = await registerOutput(out, {
      kind: 'video',
      width: outMeta.width || meta.width,
      height: outMeta.height || meta.height,
      duration: outMeta.duration || duration,
      subtitles: true,
      voiceover: mode === 'voiceover',
      cues: cues.length,
    })
    return {
      asset,
      mode,
      cues: cues.length,
      duration: outMeta.duration || duration,
      width: outMeta.width || meta.width,
      height: outMeta.height || meta.height,
      voiceover: mode === 'voiceover',
    }
  }

  // ------------------------------------------------------------------ AI upscale

  async function imageUpscale(body) {
    const engines = await detectEngines()
    if (!engines.upscale?.ok) {
      throw jsonError(
        'AI 超分引擎未安装：需要 bin/realesrgan/realesrgan-ncnn-vulkan.exe 与 models。',
        'no-upscaler',
      )
    }
    const path = pathFromInput(body.path)
    if (!(await exists(path))) throw jsonError(`图片不存在：${path}`, 'missing-file')
    const scale = [2, 3, 4].includes(Number(body.scale)) ? Number(body.scale) : 4
    const model = engines.upscale.models.includes(body.model) ? body.model : engines.upscale.models[0]
    const gpu = String(config.upscalerGpu || '0')
    const before = await stat(path)
    const beforeMeta = await imageMeta(path)
    await mkdir(outputs.upscaled, { recursive: true })
    const out = join(
      outputs.upscaled,
      `${stamp()}-${safeFileStem(basename(path, extname(path)))}-${model}-${scale}x.png`,
    )
    const baseArgs = ['-i', path, '-o', out, '-n', model, '-s', String(scale), '-f', 'png']
    let result = await run(engines.upscale.path, [...baseArgs, '-g', gpu, '-j', '1:2:2'], {
      timeout: 15 * 60 * 1000,
    })
    if (result.code !== 0) {
      throw jsonError(
        result.stderr.trim().split(/\r?\n/).slice(-6).join('\n') ||
          result.stdout.trim().split(/\r?\n/).slice(-6).join('\n') ||
          'AI 超分失败（需要可用的 Vulkan GPU）',
        'upscale-failed',
      )
    }
    if (!(await exists(out))) throw jsonError('AI 超分没有生成输出文件', 'upscale-empty')
    const after = await stat(out)
    const meta = await imageMeta(out)
    const asset = await registerOutput(out, {
      kind: 'image',
      width: meta.width,
      height: meta.height,
      upscaled: true,
      model,
      scale,
    })
    return {
      asset,
      path: out,
      model,
      scale,
      width: meta.width,
      height: meta.height,
      beforeWidth: beforeMeta.width,
      beforeHeight: beforeMeta.height,
      beforeBytes: before.size,
      bytes: after.size,
      elapsedNote: 'Real-ESRGAN ncnn',
    }
  }

  // ------------------------------------------------------------------ custom voice preset

  function presetFilterChain(preset) {
    const filters = []
    if (preset.filter) filters.push(preset.filter)
    if (preset.pitch !== 0) {
      const factor = Math.pow(2, preset.pitch / 12)
      filters.unshift(`rubberband=pitch=${factor.toFixed(5)}:formant=shifted`)
    }
    return filters
  }

  async function voiceConvert(body) {
    const engines = await detectEngines()
    if (!engines.video.ok) throw jsonError('录音转换需要 FFmpeg', 'no-ffmpeg')
    const path = pathFromInput(body.path)
    if (!(await exists(path))) throw jsonError(`录音不存在：${path}`, 'missing-file')
    const preset = allVoicePresets().find((item) => item.id === body.preset) ?? VOICE_PRESETS[0]
    const useRvc = String(body.rvcModel ?? '')
    const rvcModel = useRvc ? engines.rvc.models.find((model) => model.id === useRvc || model.name === useRvc) : null
    if (useRvc && !rvcModel) throw jsonError('找不到选择的 RVC 模型', 'no-rvc-model')
    if (rvcModel && !engines.rvc.hasCommand) throw jsonError('未配置 RVC 命令，无法使用模型', 'no-rvc-engine')
    await mkdir(outputs.tmp, { recursive: true })
    await mkdir(outputs.audio, { recursive: true })
    let source = path
    let rvcWav = ''
    if (rvcModel) {
      const wav = join(outputs.tmp, `custom-in-${Date.now()}.wav`)
      const prepared = await run(engines.video.ffmpeg, ['-hide_banner', '-y', '-i', path, '-ar', '44100', '-ac', '1', wav], {
        timeout: 60_000,
      })
      if (prepared.code !== 0) throw jsonError('准备 RVC 输入音频失败', 'ffmpeg')
      rvcWav = join(outputs.tmp, `custom-rvc-${Date.now()}.wav`)
      await runRvc(engines.rvc, rvcModel, wav, rvcWav, clamp(Number(body.rvcPitch) || 0, -24, 24), engines.image.python)
      source = rvcWav
      await unlink(wav).catch(() => {})
    }
    const filters = presetFilterChain(preset)
    filters.push('loudnorm=I=-16:TP=-1.5:LRA=11')
    const out = join(
      outputs.audio,
      `${stamp()}-voice-${safeFileStem(preset.name, 'custom')}-${Math.random().toString(36).slice(2, 6)}.mp3`,
    )
    const result = await run(
      engines.video.ffmpeg,
      ['-hide_banner', '-y', '-i', source, '-af', filters.join(','), '-ar', '44100', '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '192k', out],
      { timeout: 180_000 },
    )
    if (rvcWav) await unlink(rvcWav).catch(() => {})
    if (result.code !== 0) {
      throw jsonError(result.stderr.trim().split(/\r?\n/).slice(-4).join('\n') || '录音声线转换失败', 'voice-failed')
    }
    const probe = await probeMedia(out).catch(() => ({ duration: 0 }))
    const asset = await registerOutput(out, {
      duration: probe.duration,
      kind: 'audio',
      preset: preset.id,
      rvcModel: rvcModel?.name ?? null,
      customVoicePreview: true,
    })
    return { asset, path: out, presetId: preset.id, presetName: preset.name, rvcModel: rvcModel?.name ?? null, duration: probe.duration }
  }

  async function voicePreset(body) {    const base = allVoicePresets().find((item) => item.id === body.basePreset)
    if (!base) throw jsonError('找不到目标声线', 'no-voice-preset')
    const name = cleanText(body.name, 30)
    if (name === '') throw jsonError('请给自定义声线起个名字', 'empty-voice-name')
    const samplePath = pathFromInput(body.samplePath)
    if (!(await exists(samplePath))) throw jsonError('录音样本文件不存在', 'missing-file')
    const engines = await detectEngines()
    const rvcId = String(body.rvcModel ?? '')
    const rvcModel = rvcId ? engines.rvc.models.find((model) => model.id === rvcId || model.name === rvcId) : null
    if (rvcId && !rvcModel) throw jsonError('找不到选择的 RVC 模型', 'no-rvc-model')
    const previewPath = body.previewPath ? pathFromInput(body.previewPath) : ''
    const preset = {
      id: `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
      name,
      custom: true,
      pitch: Number(base.pitch) || 0,
      filter: String(base.filter ?? ''),
      desc: `录音转换自定义声线 · 基于「${base.name}」${rvcModel ? ` + RVC ${rvcModel.name}` : ''}`,
      basePreset: base.id,
      baseName: base.name,
      rvcModel: rvcModel?.id ?? '',
      rvcModelName: rvcModel?.name ?? '',
      samplePath,
      previewPath: previewPath && (await exists(previewPath)) ? previewPath : '',
      createdAt: new Date().toISOString(),
    }
    customVoices = [...customVoices, preset].slice(-40)
    await saveCustomVoices()
    return { preset, presets: allVoicePresets() }
  }

  async function renameVoicePreset(body) {
    const id = String(body.id ?? '')
    const preset = customVoices.find((item) => item.id === id)
    if (!preset) throw jsonError('自定义声线不存在', 'no-custom-voice')
    const name = cleanText(body.name, 30)
    if (name === '') throw jsonError('名称不能为空', 'empty-voice-name')
    preset.name = name
    await saveCustomVoices()
    return { preset, presets: allVoicePresets() }
  }

  async function deleteVoicePreset(body) {
    const id = String(body.id ?? '')
    if (!customVoices.some((item) => item.id === id)) throw jsonError('自定义声线不存在', 'no-custom-voice')
    customVoices = customVoices.filter((item) => item.id !== id)
    await saveCustomVoices()
    return { deleted: id, presets: allVoicePresets() }
  }

  // ------------------------------------------------------------------ text-to-speech

  function edgeFlag(value, suffix) {
    const number = Math.round(Number(value) || 0)
    return `${number >= 0 ? '+' : ''}${number}${suffix}`
  }

  async function tts(body) {
    const engines = await detectEngines()
    if (!engines.tts.ok) {
      throw jsonError(
        '语音引擎不可用：请安装 edge-tts（pip install edge-tts），或检查设置。',
        'no-tts-engine',
      )
    }
    const text = cleanText(body.text, 6000)
    if (text === '') throw jsonError('请先输入要朗读的文本', 'empty-text')
    const voice =
      typeof body.voice === 'string' && /^[a-z]{2,3}-[A-Za-z]{2,4}-[A-Za-z0-9]+Neural$/.test(body.voice)
        ? body.voice
        : 'zh-CN-XiaoxiaoNeural'
    const preset = allVoicePresets().find((item) => item.id === body.preset) ?? VOICE_PRESETS[0]
    const rate = clamp(Number(body.rate) || 0, -50, 100)
    const pitch = clamp(Number(body.pitch) || 0, -50, 50)
    const volume = clamp(Number(body.volume) || 0, -50, 50)
    const useRvc = body.rvcModel ? String(body.rvcModel) : String(preset.rvcModel ?? '')
    const rvcModel = useRvc ? engines.rvc.models.find((model) => model.id === useRvc || model.name === useRvc) : null
    if (useRvc && !rvcModel) throw jsonError('找不到选择的 RVC 模型', 'no-rvc-model')
    if (rvcModel && !engines.rvc.hasCommand) throw jsonError('未配置 RVC 命令，无法使用模型', 'no-rvc-engine')

    const runId = createHash('sha1').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 10)
    await mkdir(outputs.tmp, { recursive: true })
    await mkdir(outputs.audio, { recursive: true })
    const raw = join(outputs.tmp, `${runId}-raw.mp3`)
    const rawSrt = join(outputs.tmp, `${runId}-raw.srt`)
    const wav = join(outputs.tmp, `${runId}-raw.wav`)
    const rvcWav = join(outputs.tmp, `${runId}-rvc.wav`)
    const final = join(
      outputs.audio,
      `${stamp()}-${safeFileStem(voice.split('-').slice(2).join('-').replace(/Neural$/, ''))}-${preset.id}.mp3`,
    )
    const finalSrt = final.replace(/\.mp3$/i, '.srt')

    const commonArgs = [
      '--voice',
      voice,
      '--text',
      text,
      `--rate=${edgeFlag(rate, '%')}`,
      `--pitch=${edgeFlag(pitch, 'Hz')}`,
      `--volume=${edgeFlag(volume, '%')}`,
    ]

    // edge-tts reaches a Microsoft endpoint and occasionally answers with an
    // empty stream (NoAudioReceived) even for valid text. Two short retries
    // turn a transient edge failure into a non-event for the console user.
    let lastError = ''
    let synthesized = false
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) {
        await unlink(raw).catch(() => {})
        await unlink(rawSrt).catch(() => {})
        await sleep(900 * attempt)
      }
      const command = engines.tts.command
      const args = command
        ? [...commonArgs, '--write-media', raw, '--write-subtitles', rawSrt]
        : ['-m', 'edge_tts', ...commonArgs, '--write-media', raw, '--write-subtitles', rawSrt]
      const result = await run(command ?? engines.tts.python, args, { timeout: 180_000 })
      if (result.code === 0) {
        try {
          const info = await stat(raw)
          if (info.size > 0) {
            synthesized = true
            break
          }
        } catch {
          /* retry */
        }
      }
      lastError =
        result.stderr.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' ') ||
        (result.code === 0 ? 'edge-tts 返回空音频' : `edge-tts 退出码 ${result.code}`)
    }
    if (!synthesized) {
      throw jsonError(`语音合成失败（已重试 3 次）：${lastError}`, 'tts-failed')
    }

    let source = raw
    if (rvcModel) {
      const result = await run(engines.video.ffmpeg, ['-hide_banner', '-y', '-i', raw, '-ar', '44100', '-ac', '1', wav], {
        timeout: 60_000,
      }).catch(() => null)
      if (!result || result.code !== 0) throw jsonError('准备 RVC 输入音频失败', 'ffmpeg')
      await runRvc(engines.rvc, rvcModel, wav, rvcWav, clamp(Number(body.rvcPitch) || 0, -24, 24), engines.image.python)
      source = rvcWav
    }

    const filters = []
    if (preset.filter) filters.push(preset.filter)
    if (preset.pitch !== 0) {
      const factor = Math.pow(2, preset.pitch / 12)
      filters.unshift(`rubberband=pitch=${factor.toFixed(5)}:formant=shifted`)
    }
    if (!engines.video.ok && (filters.length > 0 || rvcModel)) {
      throw jsonError('声线处理需要 FFmpeg，请先安装或配置 FFmpeg', 'no-ffmpeg')
    }
    if (filters.length === 0 && !rvcModel) {
      await copyFile(raw, final)
    } else {
      filters.push('loudnorm=I=-16:TP=-1.5:LRA=11')
      const result = await run(
        engines.video.ffmpeg,
        [
          '-hide_banner',
          '-y',
          '-i',
          source,
          '-af',
          filters.join(','),
          '-ar',
          '44100',
          '-ac',
          '2',
          '-c:a',
          'libmp3lame',
          '-b:a',
          '192k',
          final,
        ],
        { timeout: 180_000 },
      )
      if (result.code !== 0) {
        throw jsonError(result.stderr.trim().split(/\r?\n/).slice(-4).join('\n') || '声线处理失败', 'voice-failed')
      }
    }

    const probe = engines.video.ok ? await probeMedia(final).catch(() => ({ duration: 0 })) : { duration: 0 }
    const asset = await registerOutput(final, {
      duration: probe.duration,
      kind: 'audio',
      voice,
      preset: preset.id,
      rvcModel: rvcModel?.name ?? null,
      textPreview: text.slice(0, 80),
    })
    let subtitle = null
    try {
      const info = await stat(rawSrt)
      if (info.size > 0) {
        await copyFile(rawSrt, finalSrt)
        subtitle = await registerOutput(finalSrt, {
          kind: 'file',
          mime: 'application/x-subrip',
          textPreview: text.slice(0, 80),
          subtitle: true,
        })
      }
    } catch {
      /* subtitles are optional; audio is still valid */
    }
    void cleanup([raw, rawSrt, wav, rvcWav])
    return {
      asset,
      subtitle,
      duration: probe.duration,
      voice,
      preset: preset.id,
      presetName: preset.name,
      rvcModel: rvcModel?.name ?? null,
      textPreview: text.slice(0, 160),
    }
  }

  async function runRvc(rvc, model, input, output, pitch, python) {
    const template = tokenize(rvc.command)
    if (template.length === 0) throw jsonError('RVC 命令为空', 'rvc-config')
    const replacements = {
      '{input}': input,
      '{output}': output,
      '{model}': model.path,
      '{modelPath}': model.path,
      '{modelName}': model.name,
      '{index}': model.index || '',
      '{indexPath}': model.index || '',
      '{pitch}': String(pitch),
      '{python}': python || 'python',
    }
    const args = template.map((part) => {
      let next = part
      for (const [key, value] of Object.entries(replacements)) next = next.split(key).join(value)
      return next
    })
    const command = args.shift()
    if (!command) throw jsonError('RVC 命令为空', 'rvc-config')
    const result = await run(command === 'python' && python ? python : command, args, {
      cwd: dirname(model.path),
      timeout: 10 * 60 * 1000,
    })
    if (result.code !== 0) {
      throw jsonError(result.stderr.trim().split(/\r?\n/).slice(-4).join('\n') || 'RVC 转换失败', 'rvc-failed')
    }
    if (!(await exists(output))) throw jsonError('RVC 没有生成输出文件，请检查命令模板', 'rvc-output')
    return output
  }

  async function cleanup(paths) {
    await sleep(500)
    for (const path of paths) void unlink(path).catch(() => {})
  }

  // ------------------------------------------------------------------ upload

  async function upload(body) {
    const kind = ['image', 'video', 'audio'].includes(body.kind) ? body.kind : 'image'
    const dataUrl = String(body.dataUrl ?? '')
    const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl)
    if (!match) throw jsonError('上传内容不是有效的 base64 data URL', 'bad-upload')
    const mime = match[1]
    const allowed =
      kind === 'image' ? mime.startsWith('image/') : kind === 'video' ? mime.startsWith('video/') : mime.startsWith('audio/')
    if (!allowed) throw jsonError(`文件类型与 ${kind} 不匹配`, 'bad-upload')
    const declared = String(body.name ?? '')
    const ext = extname(declared).toLowerCase() || (mime === 'image/png' ? '.png' : mime === 'video/mp4' ? '.mp4' : '.bin')
    if (![...IMAGE_EXT, ...VIDEO_EXT, ...AUDIO_EXT].includes(ext)) throw jsonError('不支持的文件扩展名', 'bad-upload')
    const data = Buffer.from(match[2], 'base64')
    if (data.length > MAX_UPLOAD_BODY) throw jsonError('文件过大', 'too-large')
    await mkdir(outputs.upload, { recursive: true })
    const name = `${stamp()}-${safeFileStem(basename(declared, extname(declared)), 'upload')}${ext}`
    const path = join(outputs.upload, name)
    await writeFile(path, data)
    const asset = await registerOutput(path, { kind })
    return { asset, path }
  }

  // ------------------------------------------------------------------ open output folder

  async function openOutputFolder(body) {
    let target = body?.path ? pathFromInput(body.path) : join(root, 'outputs')
    if (!(await exists(target))) throw jsonError(`目录不存在：${target}`, 'missing-folder')
    const info = await stat(target)
    if (info.isFile()) target = dirname(target)
    if (!isInside(root, target)) throw jsonError('只能打开创作台自己的输出目录', 'outside-root')
    const opener = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
    const child = spawn(opener, [target], { detached: true, stdio: 'ignore' })
    child.unref()
    return { opened: true, path: target }
  }

  // ------------------------------------------------------------------ HTTP

  async function handler(req, res) {
    try {
      if (crossSiteRequest(req)) {
        sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'cross-site request blocked' } })
        return
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const pathname = decodeURIComponent(url.pathname)
      if (!pathname.startsWith(PREFIX)) {
        sendJson(res, 404, { ok: false, error: { code: 'not-found', message: 'not found' } })
        return
      }

      if (pathname === `${PREFIX}/icon`) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { ok: false, error: { code: 'method', message: 'method not allowed' } })
          return
        }
        const icon = await readFile(join(PLUGIN_DIR, 'icon.png'))
        res.writeHead(200, {
          'content-type': 'image/png',
          'content-length': String(icon.length),
          'cache-control': 'no-cache',
        })
        if (req.method === 'HEAD') res.end()
        else res.end(icon)
        return
      }

      if (pathname.startsWith(`${PREFIX}/asset/`)) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { ok: false, error: { code: 'method', message: 'method not allowed' } })
          return
        }
        const id = pathname.slice(`${PREFIX}/asset/`.length)
        const asset = assets.get(id)
        if (!asset) {
          sendJson(res, 404, { ok: false, error: { code: 'not-found', message: 'asset not found' } })
          return
        }
        if (!(await exists(asset.path))) {
          sendJson(res, 404, { ok: false, error: { code: 'not-found', message: 'file no longer exists' } })
          return
        }
        serveAsset(req, res, asset, url.searchParams.get('download') === '1')
        return
      }

      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: { code: 'method', message: 'method not allowed' } })
        return
      }

      const sub = pathname.slice(PREFIX.length).replace(/^\/+/, '')
      if (sub === 'upload') {
        const body = await readJsonBody(req, MAX_UPLOAD_BODY)
        return ok(res, await upload(body))
      }

      const body = await readJsonBody(req, MAX_JSON_BODY)
      switch (sub) {
        case 'status': {
          const payload = statusPayload()
          payload.generator = await imageGeneratorStatus()
          payload.llm = await llmStatus()
          payload.asr = await asrStatus()
          ok(res, payload)
          return
        }
        case 'image/inspect':
          ok(res, await imageInspect(body))
          return
        case 'projects/list':
          ok(res, await projectList())
          return
        case 'projects/create':
          ok(res, await projectCreate(body))
          return
        case 'projects/update':
          ok(res, await projectUpdate(body))
          return
        case 'projects/delete':
          ok(res, await projectDelete(body))
          return
        case 'projects/restore':
          ok(res, await projectRestore(body))
          return
        case 'image/optimize':
          ok(res, await imageOptimize(body))
          return
        case 'image/upscale':
          ok(res, await imageUpscale(body))
          return
        case 'image/generate':
          ok(res, await imageGenerate(body))
          return
        case 'image/key':
          ok(res, await saveImageKey(body.key))
          return
        case 'llm/key':
          ok(res, await saveLlmKey(body.key))
          return
        case 'api/test':
          ok(res, await testApiConnection(body))
          return
        case 'video/plan':
          ok(res, await videoPlan(body))
          return
        case 'video/transcribe':
          ok(res, await transcribeVideo(body))
          return
        case 'asr/key':
          ok(res, await saveAsrKey(body.key))
          return
        case 'video/inspect':
          ok(res, await videoInspect(body))
          return
        case 'video/frame':
          ok(res, await videoFrame(body))
          return
        case 'audio/inspect':
          ok(res, await audioInspect(body))
          return
        case 'video/export':
          ok(res, await videoExport(body))
          return
        case 'video/premiere':
          ok(res, await videoPremiere(body))
          return
        case 'subtitle/inspect':
          ok(res, await subtitleInspect(body))
          return
        case 'subtitle/apply':
          ok(res, await subtitleApply(body))
          return
        case 'tts':
          ok(res, await tts(body))
          return
        case 'voice/convert':
          ok(res, await voiceConvert(body))
          return
        case 'voice/preset':
          ok(res, await voicePreset(body))
          return
        case 'voice/preset/rename':
          ok(res, await renameVoicePreset(body))
          return
        case 'voice/preset/delete':
          ok(res, await deleteVoicePreset(body))
          return
        case 'open-folder':
          ok(res, await openOutputFolder(body))
          return
        case 'job/status':
          ok(res, await jobStatus(body))
          return
        case 'settings':
          await saveConfig(body)
          engines = await detectEngines(true)
          ok(res, { saved: true, engines, outputs: root })
          return
        default:
          sendJson(res, 404, { ok: false, error: { code: 'not-found', message: `unknown endpoint: ${sub}` } })
      }
    } catch (error) {
      fail(res, error)
    }
  }

  // ------------------------------------------------------------------ agent tools

  const clipParameterSchema = {
    type: 'array',
    required: true,
    description: 'Ordered video clips. Each path is a local video file; start/end are seconds.',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', required: true, description: 'Absolute local video path.' },
        start: { type: 'number', description: 'Trim in-point in seconds; default 0.' },
        end: { type: 'number', description: 'Trim out-point in seconds; default full clip.' },
      },
    },
  }

  const TOOL_OUTPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      summary: { type: 'string', required: true },
      files: {
        type: 'array',
        required: true,
        items: { type: 'string' },
      },
    },
  }

  const toolOutput = (summary, files = []) => ({
    ok: true,
    summary,
    files: files.filter((file) => typeof file === 'string' && file !== ''),
  })

  // The shorthand `required: true` inside a property is convenient to write but
  // DSH's registry expects standard JSON Schema `required: [...]` arrays.
  function normalizeToolSchema(node) {
    if (Array.isArray(node)) return node.map(normalizeToolSchema)
    if (node === null || typeof node !== 'object') return node
    const out = { ...node }
    if (out.properties && typeof out.properties === 'object') {
      const required = []
      const properties = {}
      for (const [key, value] of Object.entries(out.properties)) {
        const next = normalizeToolSchema(value)
        if (next.required === true) {
          required.push(key)
          delete next.required
        } else if (Array.isArray(next.required)) {
          // Already a standard nested schema; keep it.
        }
        properties[key] = next
      }
      out.properties = properties
      if (required.length > 0) out.required = [...new Set([...(out.required ?? []), ...required])]
    }
    if (out.items) out.items = normalizeToolSchema(out.items)
    return out
  }

  const creativeTools = [
    {
      name: 'creative_image_generate',
      description:
        'Generate images with the DSH creative console. Providers: Pollinations, Seedream/Volcengine Ark, SiliconFlow, DashScope Wanx, or any OpenAI-compatible image API. ' +
        'Use for 生图/画图/配图. Returns saved local image paths; then optionally call creative_image_upscale or creative_image_optimize.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          prompt: { type: 'string', required: true, description: 'Full visual prompt.' },
          size: { type: 'string', description: 'WxH, e.g. 1024x1024, 1344x768, 768x1344.' },
          n: { type: 'integer', description: 'Number of images, 1-4.' },
          model: { type: 'string', description: 'Model id from status; omit for configured default.' },
          quality: { type: 'string', description: 'low | medium | high | auto (gpt-image only).' },
        },
      },
      output: {
        schema: TOOL_OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      timeoutMs: 10 * 60 * 1000,
      async execute(args) {
        const value = await imageGenerate(args)
        return toolOutput(
          `Generated ${value.images.length} image(s) with ${value.provider}/${value.model} at ${value.size}: ` +
            value.images.map((image) => image.path).join(', '),
          value.images.map((image) => image.path),
        )
      },
    },
    {
      name: 'creative_image_upscale',
      description:
        'AI super-resolution with local Real-ESRGAN ncnn. Upscales a local image 2x/3x/4x using photo or anime models. ' +
        'Use after image generation when a larger image is needed.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true, description: 'Local image path.' },
          scale: { type: 'integer', description: '2, 3, or 4. Default 4.' },
          model: {
            type: 'string',
            description: 'realesrgan-x4plus (photo) | realesrgan-x4plus-anime | realesr-animevideov3-x4.',
          },
        },
      },
      output: {
        schema: TOOL_OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      timeoutMs: 20 * 60 * 1000,
      async execute(args) {
        const value = await imageUpscale(args)
        return toolOutput(
          `AI upscaled to ${value.width}x${value.height} (${value.model}, ${value.scale}x): ${value.path}`,
          [value.path],
        )
      },
    },
    {
      name: 'creative_image_optimize',
      description:
        'Compress / convert / resize / crop an image locally with Pillow. Supports WebP, JPEG, PNG, AVIF. ' +
        'Use for 压缩图片、转格式、裁切、网页轻量图.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true, description: 'Local image path.' },
          format: { type: 'string', description: 'webp | jpeg | png | avif. Default webp.' },
          quality: { type: 'integer', description: '1-100, default 82.' },
          maxWidth: { type: 'integer', description: 'Max output width, default 1920.' },
          maxHeight: { type: 'integer', description: 'Max output height, default 1920.' },
          mode: { type: 'string', description: 'fit (keep frame) | crop (fill).' },
          enhance: { type: 'boolean', description: 'Light autocontrast + sharpen.' },
        },
      },
      output: {
        schema: TOOL_OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      timeoutMs: 3 * 60 * 1000,
      async execute(args) {
        const value = await imageOptimize(args)
        return toolOutput(
          `Optimised ${value.width}x${value.height} ${value.format}, saved ${value.savedPercent}%: ${value.path}`,
          [value.path],
        )
      },
    },
    {
      name: 'creative_voice_generate',
      description:
        'Generate speech with edge-tts and an RVC-style timbre preset. Also produces an SRT subtitle file. ' +
        'Use for 配音、旁白、多声线、TTS. Returns MP3 and SRT paths.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true, description: 'Text to speak.' },
          voice: { type: 'string', description: 'Edge voice id, e.g. zh-CN-XiaoxiaoNeural.' },
          preset: { type: 'string', description: 'natural | sweet | loli | boy | queen | mature | uncle | robot | whisper | radio.' },
          rate: { type: 'integer', description: '-50..100 percent.' },
          pitch: { type: 'integer', description: '-50..50 Hz.' },
          volume: { type: 'integer', description: '-50..50 percent.' },
        },
      },
      output: {
        schema: TOOL_OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      timeoutMs: 5 * 60 * 1000,
      async execute(args) {
        const value = await tts(args)
        return toolOutput(
          `Voice ${value.presetName} generated (${value.duration.toFixed(2)}s): ${value.asset.path}` +
            (value.subtitle ? ` + subtitles ${value.subtitle.path}` : ''),
          [value.asset.path, value.subtitle?.path].filter(Boolean),
        )
      },
    },
    {
      name: 'creative_video_export',
      description:
        'Trim and concatenate local video clips, unify resolution/fps/CRF, optionally replace/mix a voice track and attach SRT subtitles. ' +
        'Blocks until the FFmpeg export finishes and returns the final MP4 path.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          clips: clipParameterSchema,
          name: { type: 'string', description: 'Output base name.' },
          resolution: { type: 'string', description: 'source | 1080p | 720p | vertical | square.' },
          fps: { type: 'integer', description: '24 | 25 | 30 | 60.' },
          crf: { type: 'integer', description: '14-32, lower is better.' },
          mute: { type: 'boolean', description: 'Drop audio.' },
          audioPath: { type: 'string', description: 'Voice/music audio path.' },
          audioMode: { type: 'string', description: 'none | replace | mix.' },
          subtitlePath: { type: 'string', description: 'SRT path to mux as mov_text.' },
        },
      },
      output: {
        schema: TOOL_OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      timeoutMs: 20 * 60 * 1000,
      async execute(args) {
        if (!Array.isArray(args.clips) || args.clips.length === 0) throw new Error('clips must contain at least one item')
        const started = await videoExport(args)
        const timeoutAt = Date.now() + 15 * 60 * 1000
        while (Date.now() < timeoutAt) {
          const job = jobs.get(started.jobId)
          if (!job) throw new Error('video export job disappeared')
          if (job.status === 'done') {
            return toolOutput(`Video exported: ${job.asset.path}`, [job.asset.path])
          }
          if (job.status === 'error') throw new Error(job.error ?? 'video export failed')
          await sleep(1000)
        }
        throw new Error('video export timed out after 15 minutes')
      },
    },
    {
      name: 'creative_video_plan',
      description:
        'Analyze a local video with a vision LLM and turn a Chinese/English natural-language description into source ranges. ' +
        'Use when the user says “按描述剪”“保留说话部分”“去掉空镜” etc. Returns segments; then call creative_video_export with those ranges.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true, description: 'Local video path.' },
          prompt: { type: 'string', required: true, description: 'Natural-language editing request.' },
          transcript: { type: 'string', description: 'Optional SRT/transcript cues to match spoken content.' },
          targetSeconds: { type: 'number', description: 'Approximate total duration; 0 for natural length.' },
        },
      },
      output: {
        schema: TOOL_OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      timeoutMs: 20 * 60 * 1000,
      async execute(args) {
        const value = await videoPlan(args)
        const ranges = value.segments
          .map((segment) => `${segment.start.toFixed(1)}-${segment.end.toFixed(1)}s`)
          .join(', ')
        return toolOutput(
          `Edit plan (${value.total}s, ${value.segments.length} ranges): ${value.summary} Ranges: ${ranges}`,
          [],
        )
      },
    },
    {
      name: 'creative_video_transcribe',
      description:
        'Transcribe a local video through the configured OpenAI-compatible ASR API and return timestamped lines. ' +
        'Use before creative_video_plan when the user wants to cut by spoken content.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { path: { type: 'string', required: true, description: 'Local video path.' } },
      },
      output: {
        schema: TOOL_OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      timeoutMs: 20 * 60 * 1000,
      async execute(args) {
        const value = await transcribeVideo(args)
        return toolOutput(`Transcript (${value.segments.length} segments): ${value.text}`, [])
      },
    },
    {
      name: 'creative_subtitle_apply',
      description:
        'One-click subtitles: either soft-mux an SRT into a video (mode=soft) or synthesize each subtitle cue with edge-tts, ' +
        'align it to the cue timing and replace the original audio (mode=voiceover). Returns a new MP4.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          videoPath: { type: 'string', required: true, description: 'Source video path.' },
          srtPath: { type: 'string', required: true, description: 'SRT subtitle path.' },
          mode: { type: 'string', description: 'soft | voiceover. Default soft.' },
          voice: { type: 'string', description: 'Edge voice id for voiceover.' },
          preset: { type: 'string', description: 'Voice timbre preset for voiceover.' },
        },
      },
      output: {
        schema: TOOL_OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      timeoutMs: 25 * 60 * 1000,
      async execute(args) {
        const value = await subtitleApply(args)
        return toolOutput(
          value.voiceover
            ? `Subtitle voiceover + subtitles exported: ${value.asset.path}`
            : `Subtitles attached to video: ${value.asset.path}`,
          [value.asset.path],
        )
      },
    },
    {
      name: 'creative_premiere_xml',
      description:
        'Export the current clip timeline as Premiere Pro-importable FCP XML. Does NOT connect to or modify a running Premiere project. ' +
        'Use when the user wants to continue editing in Premiere.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          clips: clipParameterSchema,
          name: { type: 'string', description: 'Sequence name.' },
          resolution: { type: 'string', description: 'source | 1080p | 720p | vertical | square.' },
          fps: { type: 'integer', description: '24 | 25 | 30 | 60.' },
          mute: { type: 'boolean' },
          audioPath: { type: 'string' },
          audioMode: { type: 'string' },
        },
      },
      output: {
        schema: TOOL_OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      timeoutMs: 5 * 60 * 1000,
      async execute(args) {
        const value = await videoPremiere(args)
        return toolOutput(`Premiere FCP XML generated (no PR connection): ${value.path}`, [value.path])
      },
    },
    {
      name: 'creative_project_save',
      description:
        'Save a generated file into a named MuRaSame project. Creates the project when it does not exist. ' +
        'Use this after an image, video, audio or subtitle result is ready so the agent leaves a durable project artifact.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          project: { type: 'string', required: true, description: 'Project name, for example Campus promo.' },
          path: { type: 'string', required: true, description: 'Local output file path.' },
          kind: { type: 'string', description: 'image, video, audio, subtitle or file.' },
          label: { type: 'string', description: 'Optional display label.' },
        },
      },
      output: {
        schema: TOOL_OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      timeoutMs: 60 * 1000,
      async execute(args) {
        const name = cleanText(args.project, 40)
        if (name === '') throw new Error('project name is required')
        let project = projects.find((item) => item.name === name) ?? null
        if (!project) {
          const created = await projectCreate({ name })
          project = created.project
        }
        const updated = await projectUpdate({
          id: project.id,
          addPath: args.path,
          kind: args.kind,
          label: args.label,
        })
        return toolOutput(
          `Saved into project "${updated.project.name}" (${updated.project.count} items): ${pathFromInput(args.path)}`,
          [pathFromInput(args.path)],
        )
      },
    },
    {
      name: 'creative_project_list',
      description: 'List MuRaSame projects with their item counts, so the agent can choose where to save a result.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: TOOL_OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      timeoutMs: 30 * 1000,
      async execute() {
        const value = await projectList()
        const summary =
          value.projects.length === 0
            ? 'No MuRaSame projects yet.'
            : value.projects.map((item) => `${item.name} (${item.count})`).join(', ')
        return toolOutput(`Projects: ${summary}`, [])
      },
    },
    {
      name: 'creative_media_status',
      description:
        'Inspect local creative engines and defaults: image generation provider, Pillow, AI upscaler, FFmpeg, edge-tts, RVC.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: TOOL_OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      timeoutMs: 60 * 1000,
      async execute() {
        const local = await detectEngines()
        const generator = await imageGeneratorStatus()
        const llm = await llmStatus()
        return toolOutput(
          `Creative engines — image: ${local.image.ok}, upscale: ${local.upscale.ok} (${local.upscale.models.join(', ')}), ` +
            `video: ${local.video.ok}, tts: ${local.tts.ok}, RVC: ${local.rvc.available}; ` +
            `generator: ${generator.provider}/${generator.model}, key: ${generator.hasKey}; ` +
            `language edit: ${llm.model}, key: ${llm.hasKey}.`,
          [],
        )
      },
    },
  ]

  for (const tool of creativeTools) {
    const definition = {
      ...tool,
      parameters: normalizeToolSchema(tool.parameters),
      output: { ...tool.output, schema: normalizeToolSchema(tool.output.schema) },
    }
    ctx.effect(() => ctx.tools.register(definition), `creative-console: tool ${tool.name}`)
  }

  // ------------------------------------------------------------------ boot

  const ready = (async () => {
    await mkdir(outputs.image, { recursive: true })
    await mkdir(outputs.generated, { recursive: true })
    await mkdir(outputs.video, { recursive: true })
    await mkdir(outputs.premiere, { recursive: true })
    await mkdir(outputs.audio, { recursive: true })
    await mkdir(outputs.upload, { recursive: true })
    await mkdir(outputs.tmp, { recursive: true })
    await loadConfig()
    await loadCustomVoices()
    await loadProjects()
    await loadAssets()
    engines = await detectEngines(true)
  })().catch((error) => {
    console.warn('[creative-console] startup warning:', error?.message ?? error)
  })

  const routeDisposer = ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: async (req, res) => {
      await ready
      await handler(req, res)
    },
  })
  ctx.effect(
    () => () => {
      if (typeof routeDisposer === 'function') routeDisposer()
      else routeDisposer?.dispose?.()
    },
    'creative-console: routes',
  )

  // Periodic cleanup keeps the temp folder from growing across long sessions.
  const tempTimer = setInterval(() => {
    void cleanupOldTemps()
  }, 30 * 60 * 1000)
  if (typeof tempTimer.unref === 'function') tempTimer.unref()
  ctx.effect(() => () => clearInterval(tempTimer), 'creative-console: temp cleanup')
  ctx.effect(() => () => {
    if (persistTimer !== null) clearTimeout(persistTimer)
    void persistAssets()
  }, 'creative-console: persist')

  async function cleanupOldTemps() {
    try {
      const entries = await readdir(outputs.tmp, { withFileTypes: true })
      const cutoff = Date.now() - 24 * 3600 * 1000
      for (const entry of entries) {
        if (!entry.isFile()) continue
        const path = join(outputs.tmp, entry.name)
        try {
          const info = await stat(path)
          if (info.mtimeMs < cutoff) await unlink(path)
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }
}
