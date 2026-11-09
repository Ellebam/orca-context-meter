// Answers the panel and keeps the status bar current from src/reader.mjs: this machine's sidebar agents,
// then each paired Orca's.
import type { OrcaWorkerApi } from 'orca/worker'
import { liveAgents, pairedHosts, readLive, readRemote, unmeasured } from './reader.mjs'
import { contextText, fullestFirst, share, shortName } from './rank'

type Answer = { hosts: { host: string; sessions: Parameters<typeof share>[0][] }[] }

const REFRESH_MS = 60000
const WARNING_SHARE = 0.7
const DANGER_SHARE = 0.9
const STATUS_ITEMS = 3
const TOOLTIP_LIMIT = 256

/**
 * A paired machine's figures come over SSH under its Orca name. Without SSH its agents still show, from Orca's
 * pairing, with unknown figures and the reason.
 */
async function readPaired(host: string): Promise<unknown> {
  const measured = await readRemote(host, { live: true })
  if (measured.available) return measured
  const agents = await liveAgents(host)
  if (!agents) return measured
  return { schema: 1, host, available: true, live: true, figures: false, reason: measured.reason, sessions: unmeasured(agents) }
}

async function readAll(): Promise<Answer> {
  const local = readLive().then((answer: object) => ({ ...answer, available: true }))
  const paired = (await pairedHosts()).map(readPaired)
  return { hosts: (await Promise.all([local, ...paired])) as Answer['hosts'] }
}

/** Hovering any entry lists the fullest agents, as many as Orca's 256 tooltip characters hold. */
function rankingOf(rows: { host: string; s: Parameters<typeof share>[0] }[]): string {
  const lines: string[] = []
  for (const { host, s } of rows) {
    const where = host === 'local' ? '' : ` · ${host}`
    const compactions = s.compactions.count ? `, ${s.compactions.count} comp.` : ''
    const line = `${contextText(s)}  ${shortName(s)}${where}${compactions}`
    if ([...lines, line].join('\n').length > TOOLTIP_LIMIT) break
    lines.push(line)
  }
  return lines.join('\n')
}

/** Three status bar entries, the three fullest agents, each coloured by its own share. Missing ones hide. */
export function statusOf(answer: Answer) {
  const rows = answer.hosts.flatMap((h) => h.sessions.map((s) => ({ host: h.host, s })))
  rows.sort((a, b) => fullestFirst(a.s, b.s))
  if (rows.length === 0) return [{ text: 'No agents', tone: 'neutral', tooltip: 'Context Meter: no live agents', visible: true }]
  const tooltip = rankingOf(rows)
  return rows.slice(0, STATUS_ITEMS).map(({ s }) => {
    const fraction = share(s)
    const tone = (fraction ?? 0) >= DANGER_SHARE ? 'danger' : (fraction ?? 0) >= WARNING_SHARE ? 'warning' : 'neutral'
    const text = `${fraction === null ? contextText(s) : `${Math.round(fraction * 100)}%`} ${shortName(s)}`
    return { text: text.slice(0, 64), tone, tooltip, visible: true }
  })
}

export default function activate(orca: OrcaWorkerApi): void {
  // One scan at a time: the panel and the status bar share each answer.
  let inflight: Promise<Answer> | null = null
  const read = () => {
    inflight ??= readAll().finally(() => {
      inflight = null
    })
    return inflight
  }
  const refreshStatus = async () => {
    const items = statusOf(await read())
    for (let i = 0; i < STATUS_ITEMS; i += 1) {
      const item = items[i] ?? { visible: false }
      await orca.host.call('statusBar.update', { id: `agent-${i + 1}`, icon: 'gauge', ...item } as never)
    }
  }
  orca.panels.handle('meter.read', () => read() as never)
  // Orca keeps this worker running while the plugin is enabled, because it has a status bar item.
  setInterval(() => void refreshStatus().catch(() => {}), REFRESH_MS)
  void refreshStatus().catch(() => {})
}
