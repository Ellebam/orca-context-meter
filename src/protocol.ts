// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
export {}

declare module 'orca' {
  type Session = {
    client: 'claude' | 'codex'
    sessionId: string
    model: string | null
    /** Orca's name for the workspace, in live mode. */
    name?: string
    workspace: string | null
    branch: string | null
    lastActivity: string | null
    context: { current: number | null; peak: number | null; window: number | null; source: string | null }
    compactions: { count: number; auto: number; manual: number }
  }
  type HostAnswer = {
    host: string
    available: boolean
    reason?: string
    complete?: boolean
    /** False when the host's Orca could not list its live agents, so its last 24 hours show instead. */
    live?: boolean
    /** False when the host's agents come from Orca's pairing only, because SSH could not read its logs. */
    figures?: boolean
    sessions: Session[]
  }
  interface PluginRequests {
    /** The agents of Orca's sidebar, on this machine and every paired Orca. */
    'meter.read': { output: { hosts: HostAnswer[] } }
  }
}
