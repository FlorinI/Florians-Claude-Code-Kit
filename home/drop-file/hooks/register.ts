import type { Register } from 'claude-code'

// drop-file: another local program hands this session a text by writing a drop file, and the session
// receives it as a message from this plugin.
//
// Folder: <config home>/drop-file/, the config home being CLAUDE_CONFIG_DIR, else
// <USERPROFILE, else HOME>/.claude.
// At start (interactive sessions only) it writes <id>.ready, {"v":1,"at":<ms>}, which tells a writer the
// watcher runs. Every 2 s it reads <id>.json, {"v":1,"items":[{"at":<ms>,"mode":"submit"|"fill","text":"…"}]},
// when its mtime moved, and handles in `at` order each item later than the session's start and the last
// item handled, and no more than 60 s old: `submit` sends the text as a turn of its own, framed as this
// plugin's message; `fill` appends it to the prompt box. When the session's id changes (a /clear or a
// resume), the new id gets its own .ready and both ids' files are watched.
// A writer keeps its file's items younger than 60 s, appends its new one, and replaces the file by a move.

const POLL_MS = 2000
const MAX_AGE_MS = 60000
const MAX_TEXT = 32 * 1024

type Item = { at: number; mode: 'submit' | 'fill'; text: string }

const trimEnd = (p: string): string => p.replace(/[\\/]+$/, '')

async function folderOf($: any): Promise<string | null> {
  const dir = await $.env.get('CLAUDE_CONFIG_DIR')
  if (typeof dir === 'string' && dir.trim()) return `${trimEnd(dir.trim())}/drop-file`
  const profile = await $.env.get('USERPROFILE')
  if (typeof profile === 'string' && profile.trim()) return `${trimEnd(profile.trim())}/.claude/drop-file`
  const home = await $.env.get('HOME')
  if (typeof home === 'string' && home.trim()) return `${trimEnd(home.trim())}/.claude/drop-file`
  return null
}

function itemsOf(raw: string): Item[] {
  let doc: any
  try { doc = JSON.parse(raw) } catch { return [] }
  if (!doc || doc.v !== 1 || !Array.isArray(doc.items)) return []
  return doc.items.filter((it: any) => it && Number.isFinite(it.at)
    && (it.mode === 'submit' || it.mode === 'fill')
    && typeof it.text === 'string' && it.text.length > 0 && it.text.length <= MAX_TEXT)
}

async function watch($: any): Promise<void> {
  const started: number = await $.clock.now()
  const folder = await folderOf($)
  if (!folder) return
  const watched: string[] = []
  const seen = new Map<string, number>()
  let last = started
  let busy = false

  const adopt = async (id: unknown): Promise<void> => {
    if (typeof id !== 'string' || !id || watched.includes(id)) return
    watched.push(id)
    try { await $.fs.write(`${folder}/${id}.ready`, JSON.stringify({ v: 1, at: await $.clock.now() })) } catch {}
  }

  const poll = async (): Promise<void> => {
    if (busy) return
    busy = true
    try {
      try { await adopt(await $.session.id()) } catch {}
      for (const id of [...watched]) {
        try {
          const path = `${folder}/${id}.json`
          const stat = await $.fs.stat(path)
          if (seen.get(id) === stat.mtimeMs) continue
          seen.set(id, stat.mtimeMs)
          const items = itemsOf(await $.fs.read(path))
          const now: number = await $.clock.now()
          const due = items.filter((it) => it.at > started && it.at > last && now - it.at <= MAX_AGE_MS)
            .sort((a, b) => a.at - b.at)
          for (const it of due) {
            last = it.at
            if (it.mode === 'submit') void Promise.resolve($.prompt.submit({ text: it.text })).catch(() => {})
            else void Promise.resolve($.prompt.fill({ text: it.text, mode: 'append' })).catch(() => {})
          }
        } catch {}
      }
    } catch {
    } finally {
      busy = false
    }
  }

  await adopt(await $.session.id())
  $.clock.every(POLL_MS, () => { void poll().catch(() => {}) })
}

export const register: Register = (on) => {
  on('session.start', ($, e, next) => {
    if (e.isInteractive) void watch($).catch(() => {})
    return next(e)
  })
}
