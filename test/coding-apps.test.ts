import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexPlanner, OpenCodePlanner } from '../src/runtime/model/coding-apps.js'
import { emptyAuthorization, type TaskState } from '../src/shared/types.js'

/**
 * Codex and OpenCode are driven through stand-in binaries that record how
 * they were called, so these tests check the real command lines without
 * either app installed.
 */
let bin: string
const TOOLS = [{ name: 'files_list', description: 'list a folder', input_schema: { type: 'object' } }, { name: 'finish', description: 'finish', input_schema: {} }]
const task = { request: 'tidy my Downloads', authorization: emptyAuthorization() } as TaskState

before(() => {
  bin = mkdtempSync(join(tmpdir(), 'kibu-fake-apps-'))
  // Codex: the prompt arrives on stdin; the reply goes to the -o file.
  writeFileSync(join(bin, 'codex'), `#!/bin/sh
cat > "${bin}/codex-stdin.txt"
printf '%s\\n' "$@" > "${bin}/codex-args.txt"
pwd > "${bin}/codex-cwd.txt"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then printf '%s' '{"text":"","calls":[{"name":"files_list","input":{"path":"~/Downloads"}}]}' > "$2"; fi
  shift
done
echo "codex progress chatter that is not the reply"
`)
  // OpenCode: the prompt is the last argument; the reply is stdout.
  writeFileSync(join(bin, 'opencode'), `#!/bin/sh
printf '%s\\n' "$@" > "${bin}/opencode-args.txt"
cp opencode.json "${bin}/opencode-config.json"
printf '\\033[1mSure.\\033[0m {"text":"Done tidying.","calls":[]}\\n'
`)
  chmodSync(join(bin, 'codex'), 0o755)
  chmodSync(join(bin, 'opencode'), 0o755)
  process.env.KIBU_CODEX_BIN = join(bin, 'codex')
  process.env.KIBU_OPENCODE_BIN = join(bin, 'opencode')
})
after(() => rmSync(bin, { recursive: true, force: true }))

test('Codex plans read-only, saves no session, and its reply is read from the -o file', async () => {
  const planner = new CodexPlanner('gpt-5-codex')
  planner.seed(task, [])
  const proposal = await planner.propose(TOOLS)
  assert.deepEqual(proposal.calls.map((c) => c.name), ['files_list'])
  const args = readFileSync(join(bin, 'codex-args.txt'), 'utf8').trim().split('\n')
  assert.equal(args[0], 'exec')
  assert.ok(args.includes('--ephemeral'), 'no session files left behind')
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only')
  assert.equal(args[args.indexOf('-m') + 1], 'gpt-5-codex')
  assert.equal(args.at(-1), '-', 'the prompt goes on stdin, not the command line')
  const stdin = readFileSync(join(bin, 'codex-stdin.txt'), 'utf8')
  assert.match(stdin, /<kibu_instructions>/, 'Kibu\'s instructions travel with the first message')
  assert.match(stdin, /You are only planning/)
  assert.match(stdin, /tidy my Downloads/)
  assert.doesNotMatch(readFileSync(join(bin, 'codex-cwd.txt'), 'utf8'), /dev\/kibu/, 'it runs in a scratch folder, not a project')

  // The next step is a new process, so the conversation is replayed to it.
  planner.addToolResults([{ callId: proposal.calls[0]!.id, content: 'a.pdf, b.png', isError: false }])
  await planner.propose(TOOLS)
  const second = readFileSync(join(bin, 'codex-stdin.txt'), 'utf8')
  assert.match(second, /already under way/)
  assert.match(second, /tidy my Downloads/)
  assert.match(second, /a\.pdf, b\.png/)
  planner.dispose?.()
})

test('OpenCode runs with every tool denied, and its answer is found among the terminal colours', async () => {
  const planner = new OpenCodePlanner('anthropic/claude-sonnet-5')
  planner.seed(task, [])
  const proposal = await planner.propose(TOOLS)
  assert.equal(proposal.text, 'Done tidying.')
  assert.deepEqual(JSON.parse(readFileSync(join(bin, 'opencode-config.json'), 'utf8')).permission, { '*': 'deny' })
  const args = readFileSync(join(bin, 'opencode-args.txt'), 'utf8').trim().split('\n')
  assert.equal(args[0], 'run')
  assert.equal(args[args.indexOf('-m') + 1], 'anthropic/claude-sonnet-5')
  planner.dispose?.()
})

test('without a model named, each app uses its own default', async () => {
  const planner = new CodexPlanner('')
  planner.seed(task, [])
  await planner.propose(TOOLS)
  assert.ok(!readFileSync(join(bin, 'codex-args.txt'), 'utf8').split('\n').includes('-m'))
  planner.dispose?.()
})
