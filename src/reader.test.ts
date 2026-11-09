// `orca plugin test .` runs this in Node. The sample logs in test-data/ copy each client's record
// shapes with invented numbers and a marker in place of message text.
import { assert, test } from 'orca/testing'
import { appendFileSync, chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentsFrom, readLive, readRemote, readSessions, unmeasured } from './reader.mjs'

const SAMPLES = fileURLToPath(new URL('../test-data', import.meta.url))
const NEVER = 'MESSAGE-TEXT-NEVER-OUTPUT'

/** A fresh copy, so every log is inside the 24-hour window whenever the checkout was made. */
function samples() {
  const dir = mkdtempSync(join(tmpdir(), 'context-meter-'))
  cpSync(SAMPLES, dir, { recursive: true })
  return { claude: join(dir, 'claude'), codex: join(dir, 'codex') }
}

test('figures follow each client record and carry no message text', async () => {
  const answer = await readSessions({ roots: samples() })
  assert.ok(!JSON.stringify(answer).includes(NEVER), 'message text reached the output')
  assert.deepEqual([answer.schema, answer.complete, answer.malformed], [1, true, 1])
  const ids = answer.sessions.map((s) => s.sessionId).sort()
  assert.deepEqual(ids, ['claude-sample', 'codex-sample', 'codex-subagent'], 'one row per log file')
  const by = Object.fromEntries(answer.sessions.map((s) => [s.sessionId, s]))
  // A compaction replaces the context; subagent, placeholder, empty and half-written records never count.
  // A model name that is not a bare `claude-` name is a gateway's, so its window is 200k.
  assert.deepEqual(by['claude-sample'].context, { current: 800, peak: 6000, window: 200000, source: 'compaction' })
  assert.deepEqual(by['claude-sample'].compactions, { count: 1, auto: 1, manual: 0 })
  assert.equal(by['claude-sample'].lastActivity, '2026-01-01T00:00:05Z')
  assert.deepEqual([by['claude-sample'].workspace, by['claude-sample'].branch], ['sample-task', 'sample-branch'])
  // After a Codex compaction the input fields are 0 and total_tokens holds the new size.
  assert.deepEqual(by['codex-sample'].context, { current: 900, peak: 3000, window: 10000, source: 'request' })
  assert.deepEqual([by['codex-sample'].model, by['codex-sample'].compactions.count], ['model-codex', 1])
})

test('a refresh reads appended records once', async () => {
  const roots = samples()
  const log = join(roots.codex, '2026/01/01/rollout-2026-01-01T00-00-00-codex-sample.jsonl')
  // Clients only append, so the half-broken sample line is repaired before the first read.
  writeFileSync(log, readFileSync(log, 'utf8').replace(' BROKEN\n', '}}\n'))
  await readSessions({ roots })
  const usage = { type: 'token_count', info: { last_token_usage: { total_tokens: 4200 } } }
  const appended = [{ type: 'compacted', payload: {} }, { type: 'event_msg', payload: usage }]
  appendFileSync(log, appended.map((record) => `${JSON.stringify(record)}\n`).join(''))
  const second = await readSessions({ roots })
  const codex = second.sessions.find((s) => s.sessionId === 'codex-sample')
  assert.equal(codex.compactions.count, 2)
  assert.deepEqual([codex.context.current, codex.context.peak], [4200, 4200])
})

test('a remote host must be a plain name, and an unreachable one is unavailable, never empty', async () => {
  assert.deepEqual(await readRemote('-oProxyCommand=x'), {
    schema: 1, host: '-oProxyCommand=x', available: false, reason: 'not a host name', sessions: []
  })
  const dir = mkdtempSync(join(tmpdir(), 'context-meter-ssh-'))
  const sshConfig = join(dir, 'ssh.conf')
  writeFileSync(sshConfig, 'Host closed-port\n  HostName 127.0.0.1\n  Port 9\n')
  chmodSync(sshConfig, 0o600)
  const closed = await readRemote('closed-port', { sshConfig })
  assert.deepEqual([closed.available, closed.reason, closed.sessions], [false, 'ssh exit 255', []])
})

test("Claude Code's window follows Orca's rule: [1m] or a bare first-party name is 1M, a gateway 200k", async () => {
  const roots = samples()
  const dir = join(roots.claude, '-work-window')
  mkdirSync(dir)
  const request = (model: string, input: number) =>
    JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:00Z', message: { model, usage: { input_tokens: input } } })
  writeFileSync(join(dir, 'bare.jsonl'), `${request('claude-opus-9', 50000)}\n`)
  writeFileSync(join(dir, 'tagged.jsonl'), `${request('claude-opus-9[1m]', 50000)}\n`)
  writeFileSync(join(dir, 'gateway.jsonl'), `${request('eu.anthropic.claude-opus-9', 50000)}\n`)
  writeFileSync(join(dir, 'gateway-past-200k.jsonl'), `${request('eu.anthropic.claude-opus-9', 250000)}\n`)
  const by = Object.fromEntries((await readSessions({ roots })).sessions.map((s) => [s.sessionId, s.context.window]))
  assert.deepEqual([by.bare, by.tagged, by.gateway, by['gateway-past-200k']], [1000000, 1000000, 200000, 1000000])
})

test("Orca's sidebar gives one agent per live main pane of Claude Code or Codex, with the workspace name", () => {
  const pane = (agentType: string, extra = {}) => ({ agentType, hasLivePty: true, parentPaneKey: null, ...extra })
  const result = {
    worktrees: [
      { path: '/w/api-12-fix', displayName: 'api-12-fix', agents: [pane('codex'), pane('codex', { parentPaneKey: 'p1' })] },
      { path: '/w/main', displayName: 'main-dispatcher', agents: [pane('claude'), pane('claude', { hasLivePty: false })] },
      { path: '/w/old', displayName: 'old', isArchived: true, agents: [pane('codex')] },
      { path: '/w/other', agents: [pane('gemini'), pane('claude')] }
    ]
  }
  assert.deepEqual(agentsFrom(result), [
    { client: 'codex', path: '/w/api-12-fix', name: 'api-12-fix' },
    { client: 'claude', path: '/w/main', name: 'main-dispatcher' },
    { client: 'claude', path: '/w/other', name: 'other' }
  ])
  assert.deepEqual(agentsFrom(null), [])
  const [row] = unmeasured([{ client: 'codex', path: '/w/api-12-fix', name: 'api-12-fix' }])
  assert.deepEqual([row.name, row.workspace, row.context.current, row.compactions.count], ['api-12-fix', 'api-12-fix', null, 0])
})

test('live mode shows each sidebar agent once, from its main session, never a subagent', async () => {
  const roots = samples()
  // The subagent log is the newest in the folder, so only the main-session rule keeps it out.
  const later = new Date(Date.now() + 60000)
  utimesSync(join(roots.codex, '2026/01/01/rollout-2026-01-01T00-00-01-codex-subagent.jsonl'), later, later)
  const agents = [
    { client: 'codex', path: '/work/sample-codex', name: 'sample-codex' },
    { client: 'claude', path: '/work/sample-task', name: 'Sample task' },
    { client: 'codex', path: '/work/no-logs-yet', name: 'no-logs-yet' }
  ]
  const answer = await readLive({ roots, agents })
  assert.equal(answer.live, true)
  const rows = answer.sessions.map((s) => [s.client, s.sessionId, s.name, s.context.current]).sort()
  assert.deepEqual(rows, [
    ['claude', 'claude-sample', 'Sample task', 800],
    ['codex', 'codex-sample', 'sample-codex', 900],
    ['codex', 'no-logs-yet', 'no-logs-yet', null]
  ], 'a live agent without a log yet still has its row')
  assert.deepEqual((await readLive({ roots, agents: [] })).sessions, [], 'no live agent, no row')
})
