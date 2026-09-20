import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { vetCommand, RefusedCommand } from '../src/runtime/tools/shell.js'
import { splitArgs, buildPlan } from '../src/runtime/workflows/command.js'

const ctx = { ask: async () => null, log: () => {} }

test('only allowlisted programs run', () => {
  assert.doesNotThrow(() => vetCommand('mkdir', [join(homedir(), 'dev/x')]))
  assert.doesNotThrow(() => vetCommand('ls', []))
  for (const program of ['rm', 'sudo', 'curl', 'wget', 'dd', 'chmod', 'ssh', 'bash', 'sh', 'zsh', 'osascript', 'mkfs']) {
    assert.throws(() => vetCommand(program, ['-rf', '/']), RefusedCommand, program)
  }
})

test('a full path to a banned program is still banned', () => {
  assert.throws(() => vetCommand('/bin/rm', ['-rf', '~']), RefusedCommand)
})

test('shell metacharacters are inert, because there is no shell', () => {
  // These are accepted only as literal argv entries. With execFile and
  // shell:false they reach the program as text — `;` does not start a new
  // command and `|` pipes nothing.
  const vetted = vetCommand('echo', ['hello; rm -rf ~', '|', '$(whoami)', '`id`'])
  assert.deepEqual(vetted.args, ['hello; rm -rf ~', '|', '$(whoami)', '`id`'])
  assert.equal(vetted.mutates, false)
})

test('paths outside the home folder are refused', () => {
  assert.throws(() => vetCommand('mkdir', ['/etc/nope']), RefusedCommand)
  assert.throws(() => vetCommand('cp', ['a', '/System/Library/x']), RefusedCommand)
  // Climbing out with .. is the same thing wearing a hat.
  assert.throws(() => vetCommand('mkdir', ['../../../../tmp/escape']), RefusedCommand)
})

test('protected locations are refused even inside the home folder', () => {
  assert.throws(() => vetCommand('cp', ['x', join(homedir(), '.ssh/authorized_keys')]), RefusedCommand)
  assert.throws(() => vetCommand('ls', [join(homedir(), 'Library/Keychains')]), RefusedCommand)
})

test('dangerous subcommands of allowed programs are refused', () => {
  assert.throws(() => vetCommand('git', ['push']), RefusedCommand)
  assert.throws(() => vetCommand('git', ['reset']), RefusedCommand)
  assert.throws(() => vetCommand('npm', ['publish']), RefusedCommand)
  assert.doesNotThrow(() => vetCommand('git', ['status']))
})

test('reading is not marked as mutating, so it needs no write grant', () => {
  assert.equal(vetCommand('ls', []).mutates, false)
  assert.equal(vetCommand('mkdir', ['x']).mutates, true)
})

test('a dictated command splits into argv, honouring quotes', () => {
  assert.deepEqual(splitArgs('mkdir "my folder"'), ['mkdir', 'my folder'])
  assert.deepEqual(splitArgs("git commit -m 'first go'"), ['git', 'commit', '-m', 'first go'])
  assert.deepEqual(splitArgs('ls -la'), ['ls', '-la'])
})

test('the example sentence becomes the two steps it describes', async () => {
  const plan = await buildPlan(
    'create a new folder named automaton inside the dev folder and open it in zed editor',
    [],
    ctx
  )
  assert.equal(plan.steps.length, 2, JSON.stringify(plan))
  const [mkdir, open] = plan.steps
  assert.equal(mkdir!.kind, 'mkdir')
  assert.match((mkdir as { path: string }).path, /\/dev\/automaton$/)
  assert.equal(open!.kind, 'open')
  // "it" refers to the folder just created, not to something else.
  assert.equal((open as { path: string }).path, (mkdir as { path: string }).path)
  assert.equal((open as { app?: string }).app, 'Zed')
})

test('a folder on its own is made without anything being opened', async () => {
  const plan = await buildPlan('make a folder called scratch in dev', [], ctx)
  assert.equal(plan.steps.length, 1)
  assert.equal(plan.steps[0]!.kind, 'mkdir')
})

test('a refused dictated command produces no steps at all', async () => {
  const plan = await buildPlan('run rm -rf ~/Downloads', [], ctx)
  assert.deepEqual(plan.steps, [])
})

test('an unknown folder is reported rather than invented', async () => {
  const plan = await buildPlan('create a folder called x inside the zzzznotreal folder', [], ctx)
  assert.deepEqual(plan.steps, [])
  assert.equal(plan.unresolvedFolder, 'zzzznotreal')
})
