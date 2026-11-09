// How agents are named and ordered, shared by the panel and the status bar.
type Ranked = {
  sessionId: string
  name?: string | null
  workspace: string | null
  context: { current: number | null; window: number | null }
  compactions: { count: number }
}

/** The used share of the window, or null when the window or the size is unknown. */
export function share(s: Ranked): number | null {
  const { current, window } = s.context
  return current === null || !window ? null : current / window
}

/** Fullest first, then most compactions, then most tokens. An unknown share sorts after a known one. */
export function fullestFirst(a: Ranked, b: Ranked): number {
  return (
    (share(b) ?? -1) - (share(a) ?? -1) ||
    b.compactions.count - a.compactions.count ||
    (b.context.current ?? 0) - (a.context.current ?? 0)
  )
}

/** Orca's workspace name up to its first number, e.g. `project-123-long-title` reads `project-123`. */
export function shortName(s: Ranked): string {
  const name = s.name ?? s.workspace
  return name?.match(/^.*?-\d+(?=-|$)/)?.[0] ?? name ?? s.sessionId.slice(0, 8)
}

export function tokens(value: number | null): string {
  return value === null ? '–' : `${Math.round(value / 1000)}k`
}

/** Share of the window first, count in brackets; the count alone when the window is unknown. */
export function contextText(s: Ranked): string {
  const fraction = share(s)
  return fraction === null ? tokens(s.context.current) : `${Math.round(fraction * 100)}% (${tokens(s.context.current)})`
}
