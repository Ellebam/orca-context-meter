// `orca plugin check` and `orca plugin shot --scenario` render the panel from these invented
// sessions instead of the logs on this machine.
import { defineCheck } from 'orca/testing'

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString()

function session(client: string, workspace: string, current: number, window: number | null, count: number, minutes: number) {
  return {
    client,
    sessionId: `${workspace}-${client}`,
    model: null,
    workspace,
    branch: null,
    lastActivity: minutesAgo(minutes),
    context: { current, peak: current, window, source: 'request' },
    compactions: { count, auto: count, manual: 0 }
  }
}

const hosts = [
  {
    host: 'local',
    available: true,
    complete: true,
    sessions: [
      session('claude', 'api-142-rate-limits', 184000, 1000000, 0, 0),
      session('codex', 'web-87-checkout', 512000, 1000000, 1, 2),
      session('codex', 'docs', 96000, 1000000, 0, 9),
      session('claude', 'mobile-23-push', 61000, 1000000, 2, 26)
    ]
  },
  {
    host: 'build-box',
    available: true,
    complete: true,
    sessions: [
      session('codex', 'infra-31-backups', 731000, 1000000, 3, 1),
      session('codex', 'api-142-rate-limits', 142000, 1000000, 0, 14)
    ]
  }
]

export default defineCheck({
  sessions: { requests: { 'meter.read': () => ({ hosts }) } },
  empty: { requests: { 'meter.read': () => ({ hosts: [{ host: 'local', available: true, complete: true, sessions: [] }] }) } }
})
