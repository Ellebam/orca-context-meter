// Answers the panel and keeps the status bar current from src/reader.mjs: this machine's sidebar agents,
// then each paired Orca's.
import type { OrcaWorkerApi } from 'orca/worker'
import { liveAgents, pairedHosts, readLive, readRemote, unmeasured } from './reader.mjs'
import { contextText, fullestFirst, share, shortName } from './rank'

type Answer = { hosts: { host: string; sessions: Parameters<typeof share>[0][] }[] }

const REFRESH_MS = 60000
const WARNING_SHARE = 0.7
const DANGER_SHARE = 0.9
const TOOLTIP_ROWS = 6
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

/** The status bar shows the fullest agent; hovering lists the next ones. */
export function statusOf(answer: Answer) {
  const rows = answer.hosts.flatMap((h) => h.sessions.map((s) => ({ host: h.host, s })))
  rows.sort((a, b) => fullestFirst(a.s, b.s))
  if (rows.length === 0) return { text: 'No agents', tone: 'neutral', tooltip: 'Context Meter: no live agents' }
  const line = ({ host, s }: (typeof rows)[number]) =>
    `${contextText(s)}  ${shortName(s)}${host === 'local' ? '' : ` · ${host}`}  ${s.compactions.count} comp.`
  const top = rows[0]
  const fraction = share(top.s) ?? 0
  const tone = fraction >= DANGER_SHARE ? 'danger' : fraction >= WARNING_SHARE ? 'warning' : 'neutral'
  const text = `${share(top.s) === null ? contextText(top.s) : `${Math.round(fraction * 100)}%`} ${shortName(top.s)}`
  const tooltip = rows.slice(0, TOOLTIP_ROWS).map(line).join('\n').slice(0, TOOLTIP_LIMIT)
  return { text: text.slice(0, 64), tone, tooltip }
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
    const status = statusOf(await read())
    await orca.host.call('statusBar.update', { id: 'fullest', icon: 'gauge', ...status } as never)
  }
  orca.panels.handle('meter.read', () => read() as never)
  orca.commands.register('toggle-sidebar', () => orca.host.call('commands.run', { action: 'sidebar.right.toggle' }))
  // Orca keeps this worker running while the plugin is enabled, because it has a status bar item.
  setInterval(() => void refreshStatus().catch(() => {}), REFRESH_MS)
  void refreshStatus().catch(() => {})
}
