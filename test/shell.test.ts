import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { vetCommand, RefusedCommand, commandScopes, shellRun, wouldLaunch } from '../src/runtime/tools/shell.js'
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
  // shell:false they reach the program as text: `;` does not start a new
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

test('programs that run code are confirmed with the user every time, with the exact command', () => {
  const cases: [string, string[]][] = [
    ['python3', ['-c', 'import shutil; shutil.rmtree("x")']],
    ['node', ['-e', 'require("child_process").execSync("id")']],
    ['npm', ['exec', '--yes', 'some-package']],
    ['npm', ['install']]
  ]
  for (const [program, args] of cases) {
    const prompt = shellRun.confirm!({ program, args })
    assert.ok(prompt, program)
    assert.match(prompt!, new RegExp(program))
    // No grant is free: the working folder needs write access as well.
    assert.deepEqual(commandScopes(vetCommand(program, args)), [{ kind: 'write', path: homedir() }])
  }
  assert.equal(shellRun.confirm!({ program: 'ls', args: [] }), null)
})

test('git cannot be talked into running another program', () => {
  for (const args of [
    ['-c', 'alias.x=!id', 'x'],
    ['--config-env=core.sshCommand=X', 'status'],
    ['config', 'alias.x', '!id'],
    ['submodule', 'foreach', 'id'],
    ['bisect', 'run', 'id'],
    ['clone', '--upload-pack=touch /tmp/pwned', 'repo'],
    ['clone', '-u', 'touch /tmp/pwned', 'repo'],
    ['clone', 'ext::sh -c id', 'repo'],
    ['difftool', '-x', 'id']
  ]) {
    assert.throws(() => vetCommand('git', args), RefusedCommand, args.join(' '))
  }
  assert.doesNotThrow(() => vetCommand('git', ['log', '--oneline']))
  assert.doesNotThrow(() => vetCommand('git', ['commit', '-m', 'first go']))
})

test('reading a file needs read access to it, not just any home path', () => {
  const file = join(homedir(), 'notes/secret.txt')
  const scopes = commandScopes(vetCommand('cat', [file]))
  assert.deepEqual(scopes, [{ kind: 'read', path: homedir() }, { kind: 'read', path: file }])
})

test('a move needs write access at both ends; a copy only where it lands', () => {
  const from = join(homedir(), 'Downloads/a.txt')
  const to = join(homedir(), 'Library/LaunchAgents/a.plist')
  assert.deepEqual(
    commandScopes(vetCommand('mv', [from, to])).filter((s) => !('path' in s) || s.path !== homedir()),
    [{ kind: 'write', path: from }, { kind: 'write', path: to }]
  )
  assert.deepEqual(
    commandScopes(vetCommand('cp', [from, to])).filter((s) => !('path' in s) || s.path !== homedir()),
    [{ kind: 'read', path: from }, { kind: 'write', path: to }]
  )
})

test('the working folder is held to the same rules as the arguments', () => {
  assert.throws(() => vetCommand('cat', ['passwd'], '/etc'), RefusedCommand)
  assert.throws(() => vetCommand('ls', [], join(homedir(), '.ssh')), RefusedCommand)
  // A sibling that merely shares the home folder's name as a prefix is outside it.
  assert.throws(() => vetCommand('ls', [`${homedir()}-other/x`]), RefusedCommand)
})

test('open will not launch apps, scripts, installers or executables', () => {
  const dir = mkdtempSync(join(homedir(), '.kibu-shell-test-'))
  try {
    const script = join(dir, 'run-me')
    writeFileSync(script, '#!/bin/sh\nid\n')
    chmodSync(script, 0o755)
    const note = join(dir, 'note.txt')
    writeFileSync(note, 'hello')
    assert.equal(wouldLaunch(script), true)
    assert.equal(wouldLaunch(note), false)
    assert.throws(() => vetCommand('open', [script]), RefusedCommand)
    for (const name of ['Evil.app', 'setup.command', 'install.pkg', 'x.sh', 'Do.workflow']) {
      assert.throws(() => vetCommand('open', [join(dir, name)]), RefusedCommand, name)
    }
    assert.throws(() => vetCommand('open', ['-a', 'Preview', note, '--args', '--evil']), RefusedCommand)
    assert.throws(() => vetCommand('open', ['x-apple.systempreferences:com.apple.preference.security']), RefusedCommand)
    assert.doesNotThrow(() => vetCommand('open', [note]))
    assert.doesNotThrow(() => vetCommand('open', ['https://example.com/page']))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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
    ctx,
    { folder: async () => join(homedir(), 'dev'), app: async () => 'Zed' }
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
