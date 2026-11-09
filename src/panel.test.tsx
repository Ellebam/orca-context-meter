// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'

function session(client: string, workspace: string, current: number, window: number | null, compactions: number) {
  return {
    client,
    sessionId: workspace,
    model: null,
    workspace,
    branch: null,
    lastActivity: '2026-01-01T00:00:00.000Z',
    context: { current, peak: current, window, source: 'request' },
    compactions: { count: compactions, auto: compactions, manual: 0 }
  }
}

test('lists the fullest context first, more compactions first on a tie, with each tool logo', async () => {
  const host = mockHost({
    requests: {
      'meter.read': () => ({
        hosts: [
          {
            host: 'local',
            available: true,
            complete: true,
            sessions: [
              session('codex', 'calm-7-title', 41000, 100000, 1),
              session('claude', 'unknown-3', 300000, null, 5),
              session('claude', 'busy-12-title', 41000, 100000, 3)
            ]
          },
          { host: 'remote-a', available: true, complete: true, sessions: [session('codex', 'full-9', 90000, 100000, 0)] },
          { host: 'remote-b', available: false, reason: 'ssh exit 255', sessions: [] }
        ]
      })
    }
  })
  const view = await mount(panel, { host })
  try {
    await view.settled()
    const drawn = JSON.stringify(view.tree())
    const order = ['"full-9"', '"busy-12"', '"calm-7"', '"unknown-3"'].map((name) => drawn.indexOf(name))
    assert.ok(order.every((at) => at >= 0), `every agent drawn: ${order}`)
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'fullest first, compactions break the tie, unknown last')
    assert.ok(drawn.includes('"90% (90k)"') && drawn.includes('"300k"'), 'share with count, count alone when unknown')
    assert.ok(drawn.includes('remote-a'), 'a remote row names its host')
    assert.equal(view.findAll({ type: 'Image' }).length, 4, 'one logo per row')
    assert.ok(drawn.includes('"alt":"Claude Code"') && drawn.includes('"alt":"Codex"'))
    assert.ok(view.summary().some((line) => line.includes('remote-b: unavailable, ssh exit 255')))
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.warnings, [])
    assert.deepEqual(view.refusals, [])
  } finally {
    await view.unmount()
  }
})
