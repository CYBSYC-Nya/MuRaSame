import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = fileURLToPath(new URL('..', import.meta.url))
const required = [
  'package.json',
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'icon.png',
  'README.md',
  'README.zh.md',
  'MODELS.md',
  'LICENSE',
  'tests/smoke.mjs',
  'preset/package.json',
  'preset/cordis.patch.yml',
]

for (const file of required) {
  assert.ok(existsSync(join(root, file)), `missing required file: ${file}`)
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
assert.equal(pkg.name, 'dsh-creative-console')
assert.equal(pkg.author, '丛雨不善言辞')
assert.ok(pkg.repository?.url.includes('CYBSYC-Nya/MuRaSame'), 'repository metadata missing')
assert.ok(pkg.version, 'version missing')

const index = readFileSync(join(root, 'index.js'), 'utf8')
const tools = [
  'creative_image_generate',
  'creative_image_upscale',
  'creative_image_optimize',
  'creative_video_plan',
  'creative_video_transcribe',
  'creative_video_export',
  'creative_subtitle_apply',
  'creative_voice_generate',
  'creative_premiere_xml',
  'creative_media_status',
  'creative_project_list',
  'creative_project_save',
]
for (const name of tools) {
  assert.ok(index.includes(`name: '${name}'`), `missing agent tool: ${name}`)
}

const preset = JSON.parse(readFileSync(join(root, 'preset/package.json'), 'utf8'))
assert.equal(preset.version, '1.1.0')
assert.match(readFileSync(join(root, 'preset/cordis.patch.yml'), 'utf8'), /preset-murasame/)

console.log(JSON.stringify({ ok: true, version: pkg.version, tools: tools.length, preset: preset.version }, null, 2))
