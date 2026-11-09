// `orca plugin test .` runs this in Node.
import { assert, test } from 'orca/testing'
import { statusOf } from './worker'

function session(name: string, current: number, window: number | null, count: number) {
  return { sessionId: name, name, workspace: name, context: { current, window }, compactions: { count } }
}

test('the status bar shows the three fullest agents, each yellow from 70% and red from 90%', () => {
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
  assert.equal(items[0].tooltip, 'infra-31 on build-box: 93% (931k), 3 compactions. Click for the full list.')
  assert.equal(statusOf({ hosts: [{ host: 'local', sessions: [session('docs', 96000, 1000000, 0)] }] }).length, 1)
  assert.equal(statusOf({ hosts: [{ host: 'local', sessions: [] }] })[0].text, 'No agents')
})
