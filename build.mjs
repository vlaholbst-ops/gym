// Собирает страницы тренировок — Владимира и Тани — из журналов в базе знаний.
//
// Источник правды по весам — ЖУРНАЛЫ ТРЕНИРОВОК В БАЗЕ ЗНАНИЙ, а не этот репозиторий:
//   Владимир: ~/Knowledge/Здоровье/Владимир/Журнал тренировок/ГГГГ-ММ-ДД — День X.md
//   Таня:     ~/Knowledge/Здоровье/Таня/Журнал тренировок/ГГГГ-ММ-ДД — День X.md
//
// Скрипт сам: находит последнюю тренировку каждого дня, вытаскивает веса и повторы,
// считает прогрессию, подставляет стартовые веса в поля ввода.
//   • Владимир — из template.html + program.json, фото вшиты base64 → index.html
//   • Таня     — из template-tanya.html + program-tanya.json, фото файлами → tanya/index.html
//
// Форматы подходов в журналах РАЗНЫЕ:
//   Владимир: "57кг×12, 57кг×12"      (вес × повторы)
//   Таня:     "12 @7кг, 12 @6кг"      (повторы @ вес), а без веса — "10, 10, 10"
//
// ВЕСА РУКАМИ НИГДЕ НЕ ВПИСЫВАТЬ. Занёс тренировку через health.mjs → запусти этот скрипт.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = dirname(fileURLToPath(import.meta.url))
const HEALTH = join(homedir(), 'Knowledge', 'Здоровье')
const DAY_RE = /^(\d{4}-\d{2}-\d{2}) — День ([ABC])\.md$/

// ---------- парсеры подходов ----------

// Владимир. Журнал ведётся в нескольких форматах — читаем все, иначе тренировка
// молча пропадает со страницы («в прошлый раз не сделано» при выполненной работе):
//   "57кг×12, 57кг×12, 57кг×12"  — развёрнутый, до 15.07
//   "3x12 @72.5кг"               — так пишет `health workout --sets`, с 17.07
//   "6кг: 12,12,8"               — вес вынесен вперёд, повторы разные
//   "3x12 без веса"              — упражнение с собственным весом, w:0
const num = (x) => parseFloat(x.replace(',', '.'))

function parseSetsVlad(s) {
  const out = []

  // "3x12 @72.5кг" — N подходов по M повторов с одним весом
  let m = s.match(/^\s*(\d+)\s*[×xх*]\s*(\d+)\s*@\s*(\d+(?:[.,]\d+)?)\s*кг/i)
  if (m) {
    for (let i = 0; i < parseInt(m[1], 10); i++) out.push({ w: num(m[3]), r: parseInt(m[2], 10) })
    return out
  }

  // "6кг: 12,12,8" — вес общий, повторы по подходам
  m = s.match(/^\s*(\d+(?:[.,]\d+)?)\s*кг\s*:\s*(.+)$/i)
  if (m) {
    for (const chunk of m[2].split(',')) {
      const r = chunk.match(/\d+/)
      if (r) out.push({ w: num(m[1]), r: parseInt(r[0], 10) })
    }
    return out
  }

  // "3x12 без веса" — гиперэкстензия, планка и прочее без отягощения
  m = s.match(/^\s*(\d+)\s*[×xх*]\s*(\d+)\s*(?:без\s+веса|б\/в)\s*$/i)
  if (m) {
    for (let i = 0; i < parseInt(m[1], 10); i++) out.push({ w: 0, r: parseInt(m[2], 10) })
    return out
  }

  // "57кг×12, 57кг×12, ..." — развёрнутый формат
  const re = /(\d+(?:[.,]\d+)?)\s*кг\s*[×xх*]\s*(\d+)/gi
  while ((m = re.exec(s))) out.push({ w: num(m[1]), r: parseInt(m[2], 10) })
  return out
}

// Таня: "12 @7кг, 12 @6кг, 12 @6кг" → [{r:12,w:7}, ...]; "10, 10, 10" → [{r:10,w:null}, ...].
// Вес необязателен (упражнения без отягощения). "веса не записаны" → [] — молча, без падения.
function parseSetsTanya(s) {
  const out = []
  for (const chunk of s.split(',')) {
    const m = chunk.match(/(\d+(?:[.,]\d+)?)\s*(?:@\s*(\d+(?:[.,]\d+)?)\s*кг)?/)
    if (!m || !/\d/.test(m[0])) continue
    out.push({
      r: parseInt(m[1], 10),
      w: m[2] != null ? parseFloat(m[2].replace(',', '.')) : null,
    })
  }
  return out
}

// ---------- чтение журнала ----------

function readJournal(dir, parseSets) {
  const byDay = {}
  if (!existsSync(dir)) return byDay

  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    const m = file.match(DAY_RE)
    if (!m) continue
    const [, date, day] = m

    const rows = {}
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      if (!line.startsWith('|') || line.startsWith('|---') || line.startsWith('| Упражнение')) continue
      const c = line.split('|').map((x) => x.trim())
      if (c.length < 4) continue
      rows[c[1]] = { raw: c[2], sets: parseSets(c[2]), note: c[3] }
    }
    byDay[day] = { date, rows } // файлы отсортированы — последний перезаписывает
  }
  return byDay
}

const fmtDate = (iso) => iso.slice(8, 10) + '.' + iso.slice(5, 7)

// ---------- сетка весов ----------
// В зале нет произвольных весов. Стек тренажёров идёт по 5 кг ровными числами
// (10/15/20), жим ногами — по 5 со смещением 2.5 (62.5/67.5/72.5), гантели — по 2.
// Прирост округляем ВВЕРХ до ближайшего РЕАЛЬНО существующего веса: назначать
// 17.5 кг там, где на стойке только 15 и 20, — вредный совет.
function snapUp(w, ex) {
  const round = (x) => Math.round(x * 10) / 10
  if (!ex.grid) return round(w)
  const off = ex.gridOffset || 0
  const k = Math.ceil((w - off) / ex.grid - 1e-9)
  return round(off + k * ex.grid)
}

// ---------- прогрессия: Владимир (формат вес × повторы) ----------

function progressVlad(ex, prev) {
  if (!prev) {
    // без отягощения «подбери вес» звучит абсурдно — планка, гиперэкстензия
    const next = ex.step > 0 ? `первый раз: подбери вес на ${ex.reps}` : `первый раз: ${ex.reps}, следи за техникой`
    return { last: '—', next, start: ex.startIfNone }
  }

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

  if (top === 0) {
    return { last, next: `без веса — держим технику, ${ex.repMax} повторов`, start: 0 }
  }
  if (weights.length > 1) {
    return { last, next: `выровняй: ${top} кг во всех подходах — ты его уже брал`, start: top }
  }
  if (ex.step > 0 && repsAtTop.every((r) => r >= ex.repMax)) {
    const grown = snapUp(top + ex.step, ex)
    const jump = grown - top
    const big = jump / top > 0.12
    const next = big
      ? `растём: ${grown} кг — это +${jump}, ближайший вес на стойке. Прыжок большой: не вытянешь ${ex.repMax} — сделай ${ex.repMin} и добери повторами`
      : `растём: ${grown} кг`
    return { last: last + '. Все подходы в верхней границе', next, start: grown }
  }
  if (repsAtTop.some((r) => r < ex.repMin)) {
    return { last, next: `держим ${top} кг — недотянул до ${ex.repMin} повторов`, start: top }
  }
  return { last, next: `держим ${top} кг, добиваем до ${ex.repMax} повторов`, start: top }
}

// ---------- прогрессия: Таня (формат повторы @ вес, бывает без веса) ----------

function progressTanya(ex, prev) {
  const empty = { last: '—', next: `первый раз — подбери вес на ${ex.reps} повторов`, start: '' }
  if (!prev || !prev.sets.length) return ex.unit ? empty : { last: '—', next: `${ex.reps} повторов чисто`, start: '' }

  const setsStr = prev.sets.map((s) => (s.w != null ? `${s.w}кг × ${s.r}` : `${s.r}`)).join(', ')
  const last = `${fmtDate(prev.date)} — ${setsStr}`

  // Упражнение без веса (или в журнале веса не оказалось) — прогрессируем по повторам, поле пустое.
  const weighted = prev.sets.filter((s) => s.w != null)
  if (!ex.unit || !weighted.length) {
    return { last, next: `держим ${ex.reps} повторов чисто`, start: '' }
  }

  const weights = [...new Set(weighted.map((s) => s.w))]
  const top = Math.max(...weighted.map((s) => s.w))
  const repsAtTop = weighted.filter((s) => s.w === top).map((s) => s.r)

  if (weights.length > 1) {
    return { last, next: `выровняй: ${top} кг во всех подходах — ты его уже брала`, start: top }
  }
  if (ex.step > 0 && repsAtTop.every((r) => r >= ex.repMax)) {
    const grown = snapUp(top + ex.step, ex)
    return { last, next: `растём: ${grown} кг`, start: grown }
  }
  if (repsAtTop.some((r) => r < ex.repMin)) {
    return { last, next: `держим ${top} кг — недотянула до ${ex.repMin} повторов`, start: top }
  }
  return { last, next: `держим ${top} кг, добей до ${ex.repMax}`, start: top }
}

// ---------- отчёт по журналу ----------

function reportSessions(who, sessions, dayNames) {
  console.log(`\n${who} — веса из журнала базы знаний:`)
  const found = Object.entries(sessions)
  if (!found.length) console.log('  (журнал пуст — везде стартовые/пустые веса)')
  for (const [day, s] of found) {
    console.log(`  День ${day} — последняя тренировка ${s.date}, упражнений: ${Object.keys(s.rows).length}`)
  }
  for (const [day, names] of dayNames) {
    const known = Object.keys(sessions[day]?.rows || {})
    if (!known.length) continue
    const missing = names.filter((n) => !known.includes(n))
    if (missing.length) console.log(`  ⚠️  День ${day}: есть в программе, нет в последнем журнале (не делал или имя разошлось) — ${missing.join(', ')}`)
  }
}

// ---------- сборка: Владимир ----------

function buildVlad() {
  const program = JSON.parse(readFileSync(join(DIR, 'program.json'), 'utf8'))
  const sessions = readJournal(join(HEALTH, 'Владимир', 'Журнал тренировок'), parseSetsVlad)

  const days = {}
  for (const [day, exercises] of Object.entries(program.days)) {
    days[day] = exercises.map((ex) => {
      const row = sessions[day]?.rows?.[ex.name]
      const p = progressVlad(ex, row ? { ...row, date: sessions[day].date } : null)
      return {
        n: ex.n, name: ex.name, photo: ex.photo,
        sets: ex.sets, reps: ex.reps, rest: ex.rest,
        cues: ex.cues, warn: ex.warn, diagram: ex.diagram, diagramCap: ex.diagramCap,
        video: ex.video, last: p.last, next: p.next, start: p.start,
      }
    })
  }

  reportSessions('Владимир', sessions, Object.entries(program.days).map(([d, e]) => [d, e.map((x) => x.name)]))

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
  if (left) throw new Error(`Владимир: незаполненные плейсхолдеры: ${[...new Set(left)].join(', ')}`)

  writeFileSync(join(DIR, 'index.html'), html)
  console.log(`Собрано: index.html (${Math.round(html.length / 1024)} КБ)`)
}

// ---------- сборка: Таня ----------

function buildTanya() {
  const program = JSON.parse(readFileSync(join(DIR, 'program-tanya.json'), 'utf8'))
  const sessions = readJournal(join(HEALTH, 'Таня', 'Журнал тренировок'), parseSetsTanya)

  const days = {}
  for (const [day, block] of Object.entries(program.days)) {
    days[day] = {
      title: block.title,
      sub: block.sub,
      ex: block.ex.map((ex) => {
        const row = sessions[day]?.rows?.[ex.name]
        const p = progressTanya(ex, row ? { ...row, date: sessions[day].date } : null)
        return {
          name: ex.name, sets: ex.sets, reps: ex.reps, unit: ex.unit,
          note: ex.note, warn: ex.warn, photo: ex.photo,
          last: p.last, next: p.next, start: p.start,
        }
      }),
    }
  }

  reportSessions('Таня', sessions, Object.entries(program.days).map(([d, b]) => [d, b.ex.map((x) => x.name)]))

  let html = readFileSync(join(DIR, 'template-tanya.html'), 'utf8')
  html = html.replace('{{DAYS}}', JSON.stringify(days, null, 2))

  const left = html.match(/\{\{[A-Z0-9]+\}\}/g)
  if (left) throw new Error(`Таня: незаполненные плейсхолдеры: ${[...new Set(left)].join(', ')}`)

  writeFileSync(join(DIR, 'tanya', 'index.html'), html)
  console.log(`Собрано: tanya/index.html (${Math.round(html.length / 1024)} КБ)`)
}

// ---------- запуск ----------

buildVlad()
buildTanya()
