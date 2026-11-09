// One row per live agent, fullest context first. Orca strips the types and compiles the JSX when it loads.
import {
  atom,
  Box,
  Button,
  Heading,
  Image,
  plugin,
  read,
  Row,
  Separator,
  set,
  Stack,
  Text,
  type PanelContext
} from 'orca'
import { contextText, fullestFirst, shortName } from './rank'

const REFRESH_MS = 60000
// Fixed widths keep the numbers in columns down the list.
const CONTEXT_WIDTH = 96
const COMPACTIONS_WIDTH = 44
const LOGO_SIZE = 16

type Answer = Awaited<ReturnType<typeof plugin.request<'meter.read'>>>
const answer = atom<Answer | null>(null)
const failure = atom<string | null>(null)

async function refresh(): Promise<void> {
  try {
    set(answer, await plugin.request('meter.read'))
    set(failure, null)
  } catch (error) {
    set(failure, error instanceof Error ? error.message : String(error))
  }
}

export function setup(ctx: PanelContext): void {
  const timer = setInterval(() => void refresh(), REFRESH_MS)
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) })
  void refresh()
}

const LOGO: Record<string, { src: string; alt: string }> = {
  claude: { src: 'images/claude.png', alt: 'Claude Code' },
  codex: { src: 'images/openai.png', alt: 'Codex' }
}

function Line(props: { logo: unknown; name: unknown; context: unknown; compactions: unknown }) {
  return (
    <Box direction="row" align="center" gap="sm">
      {props.logo}
      <Box grow shrink minWidth={0}>
        {props.name}
      </Box>
      <Box width={CONTEXT_WIDTH} shrink={false} justify="end" direction="row">
        {props.context}
      </Box>
      <Box width={COMPACTIONS_WIDTH} shrink={false} justify="end" direction="row">
        {props.compactions}
      </Box>
    </Box>
  )
}

export default function Panel() {
  const value = read(answer)
  const error = read(failure)
  const hosts = value?.hosts ?? []
  const rows = hosts.flatMap((host) => host.sessions.map((s) => ({ host: host.host, s })))
  rows.sort((a, b) => fullestFirst(a.s, b.s))
  return (
    <Stack gap="sm">
      <Row justify="between">
        <Heading>Context Meter</Heading>
        <Button variant="ghost" onPress={refresh}>
          Refresh
        </Button>
      </Row>
      {error ? <Text tone="danger">{error}</Text> : null}
      {hosts
        .filter((host) => !host.available || host.complete === false || host.live === false || host.figures === false)
        .map((host) => (
          <Text tone="warning" size="sm">
            {!host.available
              ? `${host.host}: unavailable, ${host.reason}`
              : host.figures === false
                ? `${host.host}: figures need SSH to ${host.host} (${host.reason})`
              : host.live === false
                ? `${host.host}: Orca's live agents unknown, showing the last 24 hours`
                : `${host.host}: incomplete scan`}
          </Text>
        ))}
      <Line
        logo={<Box width={LOGO_SIZE} shrink={false} />}
        name={<Text size="xs" muted>AGENT</Text>}
        context={<Text size="xs" muted>CONTEXT</Text>}
        compactions={<Text size="xs" muted>COMP.</Text>}
      />
      <Separator />
      {value === null && error === null ? <Text muted>Reading sessions…</Text> : null}
      {value !== null && rows.length === 0 ? <Text muted>No live agents</Text> : null}
      {rows.map(({ host, s }) => (
        <Line
          logo={
            <Box width={LOGO_SIZE} height={LOGO_SIZE} shrink={false}>
              <Image src={LOGO[s.client]?.src ?? 'images/icon.png'} alt={LOGO[s.client]?.alt ?? s.client} size="full" fit="contain" />
            </Box>
          }
          name={
            <Text truncate>
              {shortName(s)}
              {host === 'local' ? null : <Text muted> · {host}</Text>}
            </Text>
          }
          context={<Text>{contextText(s)}</Text>}
          compactions={<Text muted={s.compactions.count === 0}>{s.compactions.count}</Text>}
        />
      ))}
    </Stack>
  )
}
