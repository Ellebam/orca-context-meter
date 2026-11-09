// Reads current and peak context and compactions from Claude Code and Codex session logs.
// Totals stay with Orca's own usage view, so nothing here sums tokens or stores anything.
// Dependency-free so the same file runs in the plugin worker, as a command and over SSH.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SCHEMA = 1
const DAY_SECONDS = 86400
const CHUNK_BYTES = 1 << 20
const SCAN_DEADLINE_MS = 20000
// Below Orca's 30 s panel request limit, so a stalled host shows as unavailable, not a failed panel.
const SSH_DEADLINE_MS = 20000
const ORCA_DEADLINE_MS = 10000
const FIRST_LINE_LIMIT = 1 << 20
// Where each platform's Orca keeps its command line. On Linux `orca` is the GNOME screen reader.
const ORCA_CLI = {
  darwin: ['/Applications/Orca.app/Contents/Resources/bin/orca', join(homedir(), 'Applications/Orca.app/Contents/Resources/bin/orca')],
  linux: ['/usr/bin/orca-ide', '/usr/local/bin/orca-ide']
}
// Never prompt, never trust a new host key, never forward anything. Keys come from the user's file.
const SSH_OPTIONS = [
  'BatchMode=yes', 'StrictHostKeyChecking=yes', 'PasswordAuthentication=no',
  'KbdInteractiveAuthentication=no', 'ForwardAgent=no', 'ForwardX11=no', 'ClearAllForwardings=yes',
  'RequestTTY=no', 'ConnectTimeout=8', 'ServerAliveInterval=5', 'ServerAliveCountMax=2'
]
// An SSH host or Orca environment name; never an option, never a path.
const HOST = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const CLAUDE_LONG = 1000000
const CLAUDE_SHORT = 200000
// Only lines that can carry a figure are parsed; message text is never kept.
const CLAUDE_HINTS = ['"usage"', 'compact_boundary']
const CODEX_HINTS = ['"token_count"', '"compacted"', '"session_meta"', '"turn_context"']

export function defaultRoots(home = homedir()) {
  return { claude: join(home, '.claude', 'projects'), codex: join(home, '.codex', 'sessions') }
}

function fresh(client, path) {
  return {
    client, sessionId: basename(path, '.jsonl'), model: null, workspace: null, branch: null,
    lastActivity: null, context: { current: null, peak: null, window: null, source: null },
    compactions: { count: 0, auto: 0, manual: 0 }
  }
}

function observe(session, tokens, source) {
  if (!Number.isFinite(tokens)) return
  session.context.current = tokens
  session.context.source = source
  session.context.peak = Math.max(session.context.peak ?? 0, tokens)
}

function count(value) {
  return Number.isFinite(value) && value >= 0 ? value : null
}

function where(session, cwd, branch) {
  if (typeof cwd === 'string' && cwd) session.workspace = basename(cwd)
  if (typeof branch === 'string' && branch) session.branch = branch
}

function claudeRecord(session, record) {
  if (record.isSidechain) return
  if (record.type === 'system' && record.subtype === 'compact_boundary') {
    const meta = record.compactMetadata ?? {}
    session.compactions.count += 1
    if (meta.trigger === 'auto' || meta.trigger === 'manual') session.compactions[meta.trigger] += 1
    const before = count(meta.preTokens)
    if (before !== null) session.context.peak = Math.max(session.context.peak ?? 0, before)
    const after = count(meta.postTokens)
    if (after !== null) observe(session, after, 'compaction')
    else session.context.current = null
    return
  }
  if (record.type !== 'assistant') return
  const message = record.message ?? {}
  if (message.model === '<synthetic>') return
  const usage = message.usage ?? {}
  const parts = [usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens]
  // Cache fields may be absent and then mean 0. Without an input count the size is unknown.
  if (count(usage.input_tokens) === null || parts.some((part) => count(part ?? 0) === null)) return
  if (typeof message.model === 'string') session.model = message.model
  where(session, record.cwd, record.gitBranch)
  observe(session, parts.reduce((sum, part) => sum + (part ?? 0), 0), 'request')
}

// A subagent's log starts with its own session_meta and then copies its parent's, so the first wins.
const named = new WeakSet()

function codexRecord(session, record) {
  const payload = record.payload ?? {}
  if (record.type === 'session_meta') {
    if (named.has(session)) return
    named.add(session)
    if (typeof payload.id === 'string') session.sessionId = payload.id
    where(session, payload.cwd, payload.git?.branch)
  } else if (record.type === 'turn_context') {
    if (typeof payload.model === 'string') session.model = payload.model
    where(session, payload.cwd, null)
  } else if (record.type === 'compacted') {
    session.compactions.count += 1
    session.context.current = null
  } else if (record.type === 'event_msg' && payload.type === 'token_count' && payload.info) {
    // After a compaction every input field is 0 and total_tokens holds the new size.
    observe(session, count(payload.info.last_token_usage?.total_tokens), 'request')
    const window = count(payload.info.model_context_window)
    if (window !== null) session.context.window = window
  }
}

const CLIENTS = {
  claude: { hints: CLAUDE_HINTS, apply: claudeRecord },
  codex: { hints: CODEX_HINTS, apply: codexRecord }
}

function applyLine(entry, line) {
  const { hints, apply } = CLIENTS[entry.session.client]
  if (!hints.some((hint) => line.includes(hint))) return
  let record
  try {
    record = JSON.parse(line)
  } catch {
    entry.malformed += 1
    return
  }
  if (record && typeof record === 'object') {
    if (typeof record.timestamp === 'string') entry.session.lastActivity = record.timestamp
    apply(entry.session, record)
  }
}

// Per file: byte offset and figures so far, so a refresh reads only appended bytes.
const cache = new Map()

async function readFileFrom(client, path, info, deadline) {
  let entry = cache.get(path)
  const rewritten = !entry || info.ino !== entry.ino || info.size < entry.offset ||
    (info.size === entry.size && info.mtimeMs !== entry.mtimeMs)
  if (rewritten) entry = { ino: info.ino, offset: 0, malformed: 0, session: fresh(client, path) }
  entry.size = info.size
  entry.mtimeMs = info.mtimeMs
  const handle = await open(path, 'r')
  try {
    let rest = Buffer.alloc(0)
    let position = entry.offset
    const buffer = Buffer.alloc(CHUNK_BYTES)
    while (position < info.size) {
      if (Date.now() > deadline) return { entry, complete: false }
      const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, position)
      if (!bytesRead) break
      position += bytesRead
      let data = Buffer.concat([rest, buffer.subarray(0, bytesRead)])
      let newline
      while ((newline = data.indexOf(10)) !== -1) {
        applyLine(entry, data.subarray(0, newline).toString('utf8'))
        entry.offset += newline + 1
        data = data.subarray(newline + 1)
      }
      rest = data
    }
  } finally {
    await handle.close()
  }
  // A partial last line stays unread until the client finishes writing it.
  cache.set(path, entry)
  return { entry, complete: true }
}

async function claudeFiles(root) {
  const projects = await readdir(root, { withFileTypes: true }).catch(() => [])
  const lists = await Promise.all(projects.filter((p) => p.isDirectory()).map(async (project) => {
    const names = await readdir(join(root, project.name)).catch(() => [])
    return names.filter((name) => name.endsWith('.jsonl')).map((name) => join(root, project.name, name))
  }))
  return lists.flat()
}

async function codexFiles(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => [])
  return entries
    .filter((e) => e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl'))
    .map((e) => join(e.parentPath ?? e.path, e.name))
}

/** Sessions whose log changed within `sinceSeconds`, newest first. */
export async function readSessions({ sinceSeconds = DAY_SECONDS, roots = defaultRoots() } = {}) {
  const deadline = Date.now() + SCAN_DEADLINE_MS
  const cutoff = Date.now() - sinceSeconds * 1000
  const files = [
    ...(await claudeFiles(roots.claude)).map((path) => ['claude', path]),
    ...(await codexFiles(roots.codex)).map((path) => ['codex', path])
  ]
  const recent = []
  for (const [client, log] of files) {
    const info = await stat(log).catch(() => null)
    // A pipe or device would block the read past every deadline.
    if (info?.isFile() && info.mtimeMs >= cutoff) recent.push({ client, log, info })
  }
  const answer = await readLogs(recent, deadline)
  answer.sessions.sort((a, b) => String(b.lastActivity).localeCompare(String(a.lastActivity)))
  return answer
}

/** One row per log, until the deadline; `complete` is false when it ran out. A live agent without a log yet still gets its row. */
async function readLogs(logs, deadline) {
  const answer = { schema: SCHEMA, host: 'local', generatedAt: new Date().toISOString(), complete: true, malformed: 0, sessions: [] }
  for (const { client, log, info, worktree, name } of logs) {
    const result = log ? await readFileFrom(client, log, info, deadline).catch(() => null) : null
    if (result) {
      answer.complete &&= result.complete
      answer.malformed += result.entry.malformed
    }
    const session = result?.entry.session ?? (name ? fresh(client, name) : null)
    if (!session) continue
    answer.sessions.push(withWindow({ ...session, ...(worktree && { workspace: basename(worktree) }), ...(name && { name }) }))
    if (result && !result.complete) break
  }
  return answer
}

/**
 * Claude Code logs carry no window. Orca's rule: a `[1m]` name or a bare first-party `claude-` name runs 1M,
 * a gateway name 200k. A context already past 200k settles it.
 */
function withWindow(s) {
  if (s.client !== 'claude' || s.context.window !== null || (!s.model && s.context.peak === null)) return s
  const model = s.model ?? ''
  const long = /\[1m\]$/i.test(model) || /^claude-[a-z0-9.-]+$/i.test(model) || (s.context.peak ?? 0) > CLAUDE_SHORT
  return { ...s, context: { ...s.context, window: long ? CLAUDE_LONG : CLAUDE_SHORT } }
}

/** Runs Orca's command line on this machine and answers its `result`, or null when it cannot. */
async function orca(args) {
  const cli = (ORCA_CLI[process.platform] ?? []).find((path) => existsSync(path))
  if (!cli) return null
  const env = { ...process.env }
  if (process.platform === 'linux' && !env.XDG_RUNTIME_DIR) env.XDG_RUNTIME_DIR = `/run/user/${process.getuid()}`
  const { code, stdout } = await run(cli, [...args, '--json'], { env, deadlineMs: ORCA_DEADLINE_MS })
  if (code !== 0) return null
  try {
    return JSON.parse(stdout)?.result ?? null
  } catch {
    return null
  }
}

/** The agents of Orca's sidebar: each live main pane of Claude Code or Codex, with its workspace's name. */
export function agentsFrom(result) {
  const worktrees = Array.isArray(result?.worktrees) ? result.worktrees : []
  return worktrees
    .filter((w) => w.isArchived !== true && typeof w.path === 'string' && w.path)
    .flatMap((w) => (Array.isArray(w.agents) ? w.agents : [])
      .filter((agent) => CLIENTS[agent.agentType] && agent.hasLivePty === true && !agent.parentPaneKey)
      .map((agent) => ({
        client: agent.agentType,
        path: w.path,
        name: typeof w.displayName === 'string' && w.displayName ? w.displayName : basename(w.path)
      })))
}

/** Orca's sidebar agents on this machine, or on a paired Orca named by `environment`; null when Orca cannot say. */
export async function liveAgents(environment) {
  const result = await orca(['worktree', 'ps', '--limit', '1000', ...(environment ? ['--environment', environment] : [])])
  return result ? agentsFrom(result) : null
}

/** The names of the Orca servers this Orca is paired with. */
export async function pairedHosts() {
  const result = await orca(['environment', 'list'])
  const list = Array.isArray(result) ? result : Array.isArray(result?.environments) ? result.environments : []
  return list.map((environment) => environment?.name).filter((name) => typeof name === 'string' && HOST.test(name))
}

/** Rows for agents whose logs cannot be read here, so they still show, with unknown figures. */
export function unmeasured(agents) {
  return agents.map(({ client, path, name }) => ({ ...fresh(client, name), workspace: basename(path), name }))
}

/** The first record of a log, which names its folder and whether it is a subagent. Never changes. */
const firstRecords = new Map()

async function firstRecord(path) {
  if (firstRecords.has(path)) return firstRecords.get(path)
  const handle = await open(path, 'r')
  let record = null
  try {
    const buffer = Buffer.alloc(FIRST_LINE_LIMIT)
    const { bytesRead } = await handle.read(buffer, 0, FIRST_LINE_LIMIT, 0)
    const end = buffer.subarray(0, bytesRead).indexOf(10)
    if (end !== -1) record = JSON.parse(buffer.subarray(0, end).toString('utf8'))
  } catch {
    record = null
  } finally {
    await handle.close()
  }
  const payload = record?.type === 'session_meta' ? record.payload ?? {} : {}
  // Subagents and review threads run inside a main session and are not agents of their own.
  const main = !payload.thread_source || payload.thread_source === 'user'
  const result = { cwd: typeof payload.cwd === 'string' ? payload.cwd : null, main }
  firstRecords.set(path, result)
  return result
}

const inside = (cwd, path) => cwd === path || (cwd ?? '').startsWith(`${path}/`)

async function newestFirst(paths) {
  const infos = await Promise.all(paths.map(async (path) => ({ path, info: await stat(path).catch(() => null) })))
  return infos.filter(({ info }) => info?.isFile()).sort((a, b) => b.info.mtimeMs - a.info.mtimeMs)
}

/** For each live agent, the newest main session log of its client in its worktree, or none yet. */
async function liveFiles(agents, roots) {
  const wanted = new Map()
  for (const { client, path, name } of agents) {
    const key = `${client}\n${path}`
    wanted.set(key, { client, path, name, count: (wanted.get(key)?.count ?? 0) + 1 })
  }
  const picked = []
  const codexLogs = [...wanted.values()].some((w) => w.client === 'codex') ? await newestFirst(await codexFiles(roots.codex)) : []
  for (const { client, path, name, count } of wanted.values()) {
    const logs = []
    if (client === 'claude') {
      // Claude Code keeps one folder per launch folder, named with every other character as `-`.
      const dir = join(roots.claude, path.replace(/[^a-zA-Z0-9]/g, '-'))
      const names = await readdir(dir).catch(() => [])
      logs.push(...(await newestFirst(names.filter((n) => n.endsWith('.jsonl')).map((n) => join(dir, n)))).slice(0, count))
    } else {
      for (const log of codexLogs) {
        if (logs.length === count) break
        const first = await firstRecord(log.path).catch(() => null)
        if (first?.main && inside(first.cwd, path)) logs.push(log)
      }
    }
    for (let i = 0; i < count; i += 1) {
      picked.push({ client, worktree: path, name, log: logs[i]?.path ?? null, info: logs[i]?.info ?? null })
    }
  }
  return picked
}

/** Sessions of the agents in Orca's sidebar; the last 24 hours when Orca cannot list them. */
export async function readLive({ roots = defaultRoots(), agents } = {}) {
  const live = agents ?? (await liveAgents())
  if (!live) return { ...(await readSessions({ roots })), live: false }
  return { ...(await readLogs(await liveFiles(live, roots), Date.now() + SCAN_DEADLINE_MS)), live: true }
}

/** `~` and `~/...` are in the home folder. */
export function expandHome(path, home = homedir()) {
  if (path === '~') return home
  return path.startsWith('~/') ? join(home, path.slice(2)) : path
}

/** Runs a command with a hard deadline; `code` is null when it was killed or could not start. */
function run(command, args, { input = '', env = process.env, deadlineMs }) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], env })
  const chunks = []
  child.stdout.on('data', (chunk) => chunks.push(chunk))
  child.stdin.on('error', () => {})
  child.stdin.end(input)
  const timer = setTimeout(() => child.kill('SIGKILL'), deadlineMs)
  return new Promise((resolve) => {
    const done = (code) => {
      clearTimeout(timer)
      resolve({ code, stdout: Buffer.concat(chunks).toString('utf8') })
    }
    child.on('error', () => done(null))
    child.on('close', done)
  })
}

function unavailable(host, reason) {
  return { schema: SCHEMA, host, available: false, reason, sessions: [] }
}

/**
 * Runs this file on `host` over SSH, with its source on stdin, so nothing is installed there. The user's own SSH
 * configuration decides how `host` is reached.
 */
export async function readRemote(host, { sinceSeconds = DAY_SECONDS, sshConfig = '', live = false } = {}) {
  if (!HOST.test(host)) return unavailable(host, 'not a host name')
  const source = await readFile(fileURLToPath(import.meta.url))
  const mode = live ? '--live' : `--since ${Math.floor(sinceSeconds)}`
  const command = `node --input-type=module - --json ${mode}`
  const options = SSH_OPTIONS.flatMap((option) => ['-o', option])
  const remote = ['/bin/zsh', '-lc', command].map((part) => `'${part.replace(/'/g, `'\\''`)}'`).join(' ')
  const args = [...(sshConfig ? ['-F', expandHome(sshConfig)] : []), ...options, '--', host, remote]
  const { code, stdout } = await run('ssh', args, { input: source, deadlineMs: SSH_DEADLINE_MS })
  if (code !== 0) return unavailable(host, code === null ? 'ssh did not finish' : `ssh exit ${code}`)
  try {
    const answer = JSON.parse(stdout)
    if (answer?.schema !== SCHEMA || !Array.isArray(answer.sessions)) {
      return unavailable(host, 'unexpected reader output')
    }
    return { ...answer, host, available: true }
  } catch {
    return unavailable(host, 'unreadable reader output')
  }
}

function parseArgs(argv) {
  const args = { sinceSeconds: DAY_SECONDS, live: false, host: null, sshConfig: '', roots: defaultRoots() }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--json') continue
    if (flag === '--live') {
      args.live = true
      continue
    }
    const value = argv[++i]
    if (value === undefined) throw new Error(`${flag} needs a value`)
    if (flag === '--since') args.sinceSeconds = Number(value)
    else if (flag === '--host') args.host = value
    else if (flag === '--ssh-config') args.sshConfig = value
    else if (flag === '--claude-root') args.roots.claude = value
    else if (flag === '--codex-root') args.roots.codex = value
    else throw new Error(`unknown option ${flag}`)
  }
  if (!(args.sinceSeconds > 0)) throw new Error('--since needs a positive number of seconds')
  return args
}

async function main(argv) {
  const args = parseArgs(argv)
  const answer = args.host
    ? await readRemote(args.host, args)
    : { ...(await (args.live ? readLive(args) : readSessions(args))), available: true }
  process.stdout.write(`${JSON.stringify(answer)}\n`)
  return answer.available ? 0 : 1
}

const entry = process.argv[1]
if (entry === '-' || (entry && fileURLToPath(import.meta.url) === entry)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code }, (error) => {
    process.stderr.write(`reader: ${error.message}\n`)
    process.exitCode = 2
  })
}
