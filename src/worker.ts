// Answers the panel from src/reader.mjs: this machine's sidebar agents, then each paired Orca's.
import type { OrcaWorkerApi } from 'orca/worker'
import { liveAgents, pairedHosts, readLive, readRemote, unmeasured } from './reader.mjs'

type Answer = { hosts: unknown[] }

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
  return { hosts: await Promise.all([local, ...paired]) }
}

export default function activate(orca: OrcaWorkerApi): void {
  // One scan at a time: a request during a scan shares its answer.
  let inflight: Promise<Answer> | null = null
  orca.panels.handle('meter.read', () => {
    inflight ??= readAll().finally(() => {
      inflight = null
    })
    return inflight as never
  })
}
