// `orca plugin test .` runs this in Node.
import { assert, test } from 'orca/testing'
import { statusOf } from './worker'

function session(name: string, current: number, window: number | null, count: number) {
  return { sessionId: name, name, workspace: name, context: { current, window }, compactions: { count } }
}

test('the status bar shows the three fullest agents, each yellow from 70% and red from 90%, and hovering lists the ranking', () => {
  const answer = {
    hosts: [
      {
        host: 'local',
        sessions: [
          session('web-87-checkout', 720000, 1000000, 1),
          session('docs', 96000, 1000000, 0),
          session('api-142-limits', 300000, 1000000, 0)
        ]
      },
      { host: 'build-box', sessions: [session('infra-31-backups', 931000, 1000000, 3)] }
    ]
  }
  const items = statusOf(answer)
  assert.deepEqual(items.map((item) => [item.text, item.tone]), [
    ['93% infra-31', 'danger'],
    ['72% web-87', 'warning'],
    ['30% api-142', 'neutral']
  ])
  // Hovering any entry shows the same ranking, fullest first.
  assert.ok(items.every((item) => item.tooltip === items[0].tooltip))
  assert.deepEqual(items[0].tooltip.split('\n'), [
    '93% (931k)  infra-31 · build-box, 3 comp.',
    '72% (720k)  web-87, 1 comp.',
    '30% (300k)  api-142',
    '10% (96k)  docs'
  ])
  const many = { hosts: [{ host: 'local', sessions: Array.from({ length: 30 }, (_, i) => session(`agent-${i}-long-workspace-name`, 10000 * (i + 1), 1000000, i)) }] }
  assert.ok(statusOf(many)[0].tooltip.length <= 256, 'never longer than Orca shows')
  assert.equal(statusOf({ hosts: [{ host: 'local', sessions: [session('docs', 96000, 1000000, 0)] }] }).length, 1)
  assert.equal(statusOf({ hosts: [{ host: 'local', sessions: [] }] })[0].text, 'No agents')
})
