import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ClaudeCodePlanner, parseProposal } from '../src/runtime/model/claude-code-planner.js'
import { emptyAuthorization, defaultLimits, type TaskState } from '../src/shared/types.js'

function task(request: string): TaskState {
  return {
    id: 't1',
    request,
    outcome: '',
    status: 'pending',
    petState: 'thinking',
    authorization: { ...emptyAuthorization(), readRoots: ['/Users/me/Downloads'] },
    limits: defaultLimits(),
    observations: [],
    plan: [],
    actions: [],
    cost: { inputTokens: 0, outputTokens: 0, usd: 0, calls: 0 },
    completionCriteria: [],
    statusLine: '',
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
}

const TOOLS = [{ name: 'files_list', description: 'list a folder', input_schema: { type: 'object' } }]

test('parseProposal: a clean object', () => {
  const p = parseProposal('{"text":"looking first","calls":[{"name":"files_list","input":{"path":"/tmp"}}]}')
  assert.equal(p?.text, 'looking first')
  assert.equal(p?.calls.length, 1)
  assert.equal(p?.calls[0]?.name, 'files_list')
  assert.deepEqual(p?.calls[0]?.input, { path: '/tmp' })
})

test('parseProposal: survives a markdown fence and surrounding prose', () => {
  const reply = 'Sure — here is the next step:\n\n```json\n{"text":"ok","calls":[{"name":"finish","input":{}}]}\n```\n\nLet me know.'
  const p = parseProposal(reply)
  assert.equal(p?.calls[0]?.name, 'finish')
})

test('parseProposal: braces inside strings do not truncate the object', () => {
  const p = parseProposal('{"text":"a } brace { here","calls":[{"name":"files_list","input":{"path":"/a{b}"}}]}')
  assert.equal(p?.text, 'a } brace { here')
  assert.deepEqual(p?.calls[0]?.input, { path: '/a{b}' })
})

test('parseProposal: a single call object is accepted as well as an array', () => {
  const p = parseProposal('{"text":"","calls":{"name":"files_list","input":{}}}')
  assert.equal(p?.calls.length, 1)
})

test('parseProposal: call ids are unique within a proposal', () => {
  const p = parseProposal('{"calls":[{"name":"a","input":{}},{"name":"b","input":{}}]}')
  assert.equal(p?.calls.length, 2)
  assert.notEqual(p?.calls[0]?.id, p?.calls[1]?.id)
})

test('parseProposal: nonsense and empty replies are rejected, not guessed at', () => {
  assert.equal(parseProposal('I cannot do that.'), null)
  assert.equal(parseProposal(''), null)
  assert.equal(parseProposal('{"text":"","calls":[]}'), null)
  assert.equal(parseProposal('{ "calls": [ {"input": {}} ] }'), null)
})

test('the first turn sends the request, the authorization and the tool list', async () => {
  const seen: { args: string[]; input: string }[] = []
  const planner = new ClaudeCodePlanner({
    run: async (args, input) => {
      seen.push({ args, input })
      return JSON.stringify({
        session_id: 'sess-1',
        total_cost_usd: 0.01,
        usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 3 },
        result: '{"text":"looking","calls":[{"name":"files_list","input":{"path":"/Users/me/Downloads"}}]}'
      })
    }
  })
  planner.seed(task('tidy my Downloads'), ['/Users/me/Downloads/a.pdf'])
  const proposal = await planner.propose(TOOLS)

  assert.equal(proposal.calls[0]?.name, 'files_list')
  assert.equal(proposal.stopReason, 'tool_use')
  // Nothing is billed on a subscription, so no cost is reported — otherwise
  // the task's spending limit would fire over money nobody spent.
  assert.equal(proposal.usd, 0)
  assert.equal(proposal.inputTokens, 15)
  assert.match(seen[0]!.input, /tidy my Downloads/)
  assert.match(seen[0]!.input, /a\.pdf/)
  assert.match(seen[0]!.input, /files_list/)
  assert.match(seen[0]!.input, /\/Users\/me\/Downloads/)
  // Claude Code's own tools must never be available to the planner.
  const toolFlag = seen[0]!.args.indexOf('--allowed-tools')
  assert.notEqual(toolFlag, -1)
  assert.equal(seen[0]!.args[toolFlag + 1], '')
  assert.ok(seen[0]!.args.includes('--strict-mcp-config'))
  assert.ok(!seen[0]!.args.includes('--resume'))
})

test('later turns resume the session and carry the tool results', async () => {
  const seen: { args: string[]; input: string }[] = []
  let turn = 0
  const planner = new ClaudeCodePlanner({
    run: async (args, input) => {
      seen.push({ args, input })
      turn++
      return JSON.stringify({
        session_id: 'sess-1',
        result: `{"text":"step ${turn}","calls":[{"name":"files_list","input":{}}]}`
      })
    }
  })
  planner.seed(task('tidy my Downloads'), [])
  await planner.propose(TOOLS)
  planner.addToolResults([{ callId: 'c1', content: 'a.pdf, b.png', isError: false }])
  planner.addNote('you are close to the step limit')
  await planner.propose(TOOLS)

  const second = seen[1]!
  assert.deepEqual(second.args.slice(second.args.indexOf('--resume'), second.args.indexOf('--resume') + 2), [
    '--resume',
    'sess-1'
  ])
  assert.match(second.input, /a\.pdf, b\.png/)
  assert.match(second.input, /close to the step limit/)
  // The seeded request is not resent: the session already holds it.
  assert.ok(!second.input.includes('<user_request>'))
})

test('an unparseable reply is retried once, then reported honestly', async () => {
  let calls = 0
  const planner = new ClaudeCodePlanner({
    run: async () => {
      calls++
      return JSON.stringify({ session_id: 's', result: calls === 1 ? 'no idea' : '{"text":"ok","calls":[]}' })
    }
  })
  planner.seed(task('do a thing'), [])
  const proposal = await planner.propose(TOOLS)
  assert.equal(calls, 2)
  assert.equal(proposal.text, 'ok')

  const hopeless = new ClaudeCodePlanner({
    run: async () => JSON.stringify({ session_id: 's', result: 'still not json' })
  })
  hopeless.seed(task('do a thing'), [])
  await assert.rejects(() => hopeless.propose(TOOLS), /did not return a usable proposal/)
})

test('an error from the CLI surfaces rather than being swallowed', async () => {
  const planner = new ClaudeCodePlanner({
    run: async () => JSON.stringify({ is_error: true, result: 'Credit balance too low' })
  })
  planner.seed(task('do a thing'), [])
  await assert.rejects(() => planner.propose(TOOLS), /Credit balance too low/)
})
