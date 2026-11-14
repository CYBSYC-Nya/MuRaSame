const base = process.env.DSH_CREATIVE_URL || 'http://127.0.0.1:49670/api-ext/creative-console'

async function post(path, body = {}) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await response.json()
  if (!data.ok) throw new Error(`${path}: ${JSON.stringify(data.error)}`)
  return data.value
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const status = await post('/status')
assert(typeof status.version === 'string', 'status.version missing')
assert(status.engines?.image?.ok === true, 'Pillow image engine is not ready')
assert(status.engines?.video?.ok === true, 'FFmpeg video engine is not ready')
assert(status.engines?.tts?.ok === true, 'edge-tts is not ready')

const imageTest = await post('/api/test', { kind: 'image' })
assert(imageTest.ok === true, 'image API test failed')

const created = await post('/projects/create', { name: 'Smoke test project' })
assert(created.project?.id, 'project create did not return an id')
const listed = await post('/projects/list')
assert(listed.projects.some((project) => project.id === created.project.id), 'created project is not listed')
await post('/projects/delete', { id: created.project.id })

const icon = await fetch(base + '/icon')
assert(icon.ok, 'icon route failed')
assert((icon.headers.get('content-type') || '').startsWith('image/png'), 'icon route did not return PNG')

const outside = await fetch(base + '/open-folder', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ path: 'C:/Windows' }),
}).then((response) => response.json())
assert(outside.ok === false, 'open-folder allowed a path outside the plugin root')

console.log(JSON.stringify({
  ok: true,
  version: status.version,
  imageTest: imageTest.message,
  icon: 'image/png',
  folderGuard: outside.error?.code,
}, null, 2))
