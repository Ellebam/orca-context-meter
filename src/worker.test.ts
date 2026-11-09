// `orca plugin test .` runs this in Node.
import { assert, test } from 'orca/testing'
import { statusOf } from './worker'

function session(name: string, current: number, window: number | null, count: number) {
  return { sessionId: name, name, workspace: name, context: { current, window }, compactions: { count } }
}

test('the status bar names the fullest agent, warns from 70% and alarms from 90%, and lists the next ones', () => {
  const calm = statusOf({ hosts: [{ host: 'local', sessions: [session('docs', 96000, 1000000, 0)] }] })
  assert.deepEqual([calm.text, calm.tone], ['10% docs', 'neutral'])
  const answer = {
    hosts: [
      { host: 'local', sessions: [session('web-87-checkout', 720000, 1000000, 1), session('docs', 96000, 1000000, 0)] },
      { host: 'build-box', sessions: [session('infra-31-backups', 931000, 1000000, 3)] }
    ]
  }
  const alarm = statusOf(answer)
  assert.deepEqual([alarm.text, alarm.tone], ['93% infra-31', 'danger'])
  assert.deepEqual(alarm.tooltip.split('\n'), [
    '93% (931k)  infra-31 · build-box  3 comp.',
    '72% (720k)  web-87  1 comp.',
    '10% (96k)  docs  0 comp.'
  ])
  const warn = statusOf({ hosts: [{ host: 'local', sessions: [session('web-87', 720000, 1000000, 0)] }] })
  assert.equal(warn.tone, 'warning')
  assert.equal(statusOf({ hosts: [{ host: 'local', sessions: [] }] }).text, 'No agents')
})
