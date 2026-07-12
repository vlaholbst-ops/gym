// Пересобирает страницу тренировок: вшивает фото зала как data URI.
// Правишь gym.html (программа, веса «в прошлый раз», подсказки) → node build.mjs → публикуешь Artifact.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = dirname(fileURLToPath(import.meta.url))
let html = readFileSync(join(DIR, 'gym.html'), 'utf8')

for (const f of readdirSync(join(DIR, 'photos'))) {
  const num = f.match(/embed-(\d+)\.jpg/)?.[1]
  if (!num) continue
  const b64 = readFileSync(join(DIR, 'photos', f)).toString('base64')
  html = html.replaceAll(`{{PHOTO${num}}}`, `data:image/jpeg;base64,${b64}`)
}

const left = html.match(/{{PHOTO\d+}}/g)
if (left) throw new Error(`Нет фото для: ${[...new Set(left)].join(', ')}`)

const out = join(DIR, 'gym-built.html')
writeFileSync(out, html)
console.log(`Собрано: ${out} (${Math.round(html.length / 1024)} КБ)`)
