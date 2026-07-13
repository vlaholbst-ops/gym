// Собирает страницу тренировок.
//
// Источник правды по весам — ЖУРНАЛ ТРЕНИРОВОК В БАЗЕ ЗНАНИЙ, а не этот репозиторий:
//   ~/Knowledge/Здоровье/Владимир/Журнал тренировок/ГГГГ-ММ-ДД — День X.md
//
// Скрипт сам: находит последнюю тренировку каждого дня, вытаскивает веса и повторы,
// считает прогрессию, подставляет стартовые веса в поля ввода и вшивает фото зала.
//
// ВЕСА РУКАМИ НИГДЕ НЕ ВПИСЫВАТЬ. Занёс тренировку через health.mjs → запусти этот скрипт.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = dirname(fileURLToPath(import.meta.url))
const JOURNAL = join(homedir(), 'Knowledge', 'Здоровье', 'Владимир', 'Журнал тренировок')

// ---------- журнал ----------

// "57кг×12, 57кг×12, 57кг×12" → [{w:57,r:12}, ...]
function parseSets(s) {
  const out = []
  const re = /(\d+(?:[.,]\d+)?)\s*кг\s*[×xх*]\s*(\d+)/gi
  let m
  while ((m = re.exec(s))) out.push({ w: parseFloat(m[1].replace(',', '.')), r: parseInt(m[2], 10) })
  return out
}

function lastSessions() {
  const byDay = {}
  if (!existsSync(JOURNAL)) return byDay

  for (const file of readdirSync(JOURNAL).filter((f) => f.endsWith('.md')).sort()) {
    const m = file.match(/^(\d{4}-\d{2}-\d{2}) — День ([AB])\.md$/)
    if (!m) continue
    const [, date, day] = m

    const rows = {}
    for (const line of readFileSync(join(JOURNAL, file), 'utf8').split('\n')) {
      if (!line.startsWith('|') || line.startsWith('|---') || line.startsWith('| Упражнение')) continue
      const c = line.split('|').map((x) => x.trim())
      if (c.length < 4) continue
      rows[c[1]] = { raw: c[2], sets: parseSets(c[2]), note: c[3] }
    }
    byDay[day] = { date, rows } // файлы отсортированы — последний перезаписывает
  }
  return byDay
}

// ---------- прогрессия ----------

const fmtDate = (iso) => iso.slice(8, 10) + '.' + iso.slice(5, 7)

// Все подходы одним весом и все повторы в верхней границе → добавляем вес.
// Где-то недотянул до нижней границы → вес держим.
// Скакал по весу → выравниваем на максимальном, который взял.
function progress(ex, prev) {
  if (!prev) return { last: '—', next: `первый раз: подбери вес на ${ex.reps} повторов`, start: ex.startIfNone }

  if (!prev.sets.length) {
    return {
      last: `${fmtDate(prev.date)} — ${prev.raw}${prev.note ? '. ' + prev.note : ''}`,
      next: 'в прошлый раз не сделано — сделай в этот',
      start: ex.startIfNone,
    }
  }

  const last = `${fmtDate(prev.date)} — ${prev.sets.map((s) => `${s.w}кг × ${s.r}`).join(', ')}`
  const weights = [...new Set(prev.sets.map((s) => s.w))]
  const top = Math.max(...prev.sets.map((s) => s.w))
  const repsAtTop = prev.sets.filter((s) => s.w === top).map((s) => s.r)

  if (weights.length > 1) {
    return { last, next: `выровняй: ${top} кг во всех подходах — ты его уже брал`, start: top }
  }
  if (ex.step > 0 && repsAtTop.every((r) => r >= ex.repMax)) {
    const grown = Math.round((top + ex.step) * 10) / 10
    return { last: last + '. Все подходы в верхней границе', next: `растём: ${grown} кг`, start: grown }
  }
  if (repsAtTop.some((r) => r < ex.repMin)) {
    return { last, next: `держим ${top} кг — недотянул до ${ex.repMin} повторов`, start: top }
  }
  return { last, next: `держим ${top} кг, добиваем до ${ex.repMax} повторов`, start: top }
}

// ---------- сборка ----------

const program = JSON.parse(readFileSync(join(DIR, 'program.json'), 'utf8'))
const sessions = lastSessions()

const days = {}
for (const [day, exercises] of Object.entries(program.days)) {
  days[day] = exercises.map((ex) => {
    const row = sessions[day]?.rows?.[ex.name]
    const p = progress(ex, row ? { ...row, date: sessions[day].date } : null)
    return {
      n: ex.n, name: ex.name, photo: ex.photo,
      sets: ex.sets, reps: ex.reps, rest: ex.rest,
      cues: ex.cues, warn: ex.warn, diagram: ex.diagram, diagramCap: ex.diagramCap,
      video: ex.video, last: p.last, next: p.next, start: p.start,
    }
  })
}

console.log('Веса взяты из журнала базы знаний:')
for (const [day, s] of Object.entries(sessions)) {
  console.log(`  День ${day} — последняя тренировка ${s.date}, упражнений: ${Object.keys(s.rows).length}`)
}
if (!Object.keys(sessions).length) console.log('  (журнал пуст — везде стартовые веса)')

// Упражнения, которых в журнале нет (переименовал в program.json — веса потеряются молча).
for (const [day, exercises] of Object.entries(program.days)) {
  const known = Object.keys(sessions[day]?.rows || {})
  if (!known.length) continue
  const missing = exercises.filter((e) => !known.includes(e.name)).map((e) => e.name)
  if (missing.length) console.log(`  ⚠️  День ${day}: нет в журнале — ${missing.join(', ')}`)
}

let html = readFileSync(join(DIR, 'template.html'), 'utf8')
html = html.replace('{{DAYS}}', JSON.stringify(days, null, 2))
html = html.replace('{{WARMUP}}', JSON.stringify(program.warmup, null, 2))

for (const f of readdirSync(join(DIR, 'photos'))) {
  const num = f.match(/embed-(\d+)\.jpg/)?.[1]
  if (!num) continue
  const b64 = readFileSync(join(DIR, 'photos', f)).toString('base64')
  html = html.replaceAll(`{{PHOTO${num}}}`, `data:image/jpeg;base64,${b64}`)
}

const left = html.match(/\{\{[A-Z0-9]+\}\}/g)
if (left) throw new Error(`Незаполненные плейсхолдеры: ${[...new Set(left)].join(', ')}`)

writeFileSync(join(DIR, 'index.html'), html)
console.log(`\nСобрано: index.html (${Math.round(html.length / 1024)} КБ)`)
