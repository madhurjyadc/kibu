import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'

import { ToolRegistry, type ToolContext } from '../src/runtime/tools/registry.js'
import { fileTools, filesMove, filesCreateFolder, filesList, filesSearch } from '../src/runtime/tools/files.js'
import { checkScopes, isForbidden, isWithin, normalizePath, extendAuthorization, grantFor } from '../src/runtime/authorization.js'
import { emptyAuthorization, defaultLimits, type TaskState } from '../src/shared/types.js'

let root: string

function makeTask(readRoots: string[], writeRoots: string[]): TaskState {
  const auth = emptyAuthorization()
  auth.readRoots = readRoots
  auth.writeRoots = writeRoots
  auth.capabilities = ['files.read', 'files.write', 'user.interact']
  return {
    id: 'test-task',
    request: 'test',
    outcome: 'test',
    status: 'executing',
    petState: 'working',
    authorization: auth,
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

function makeCtx(task: TaskState): ToolContext {
  return {
    task,
    os: {} as ToolContext['os'],
    browser: {} as ToolContext['browser'],
    log: () => {},
    progress: () => {},
    observe: (o) => {
      const full = { ...o, id: 'obs', observedAt: Date.now() }
      task.observations.push(full)
      return full
    },
    ask: async () => ({ optionId: 'approve' }),
    checkpoint: async () => {},
    claimDesktop: async () => {},
    releaseDesktop: () => {}
  }
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'kibu-test-'))
  await fs.writeFile(join(root, 'report.pdf'), 'pdf')
  await fs.writeFile(join(root, 'photo.png'), 'png')
  await fs.writeFile(join(root, 'notes.txt'), 'hello world')
  await fs.mkdir(join(root, 'sub'))
  await fs.writeFile(join(root, 'sub', 'deep.pdf'), 'deep')
})

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('authorization', () => {
  test('a path inside a granted root is allowed', () => {
    const auth = { ...emptyAuthorization(), writeRoots: ['/Users/x/Downloads'] }
    const d = checkScopes(auth, [{ kind: 'write', path: '/Users/x/Downloads/a/b.txt' }])
    assert.equal(d.allowed, true)
  })

  test('a path outside every root is reported as missing, not refused', () => {
    const auth = { ...emptyAuthorization(), writeRoots: ['/Users/x/Downloads'] }
    const d = checkScopes(auth, [{ kind: 'write', path: '/Users/x/Documents/a.txt' }])
    assert.equal(d.allowed, false)
    assert.equal(d.refused, undefined)
    assert.equal(d.missing.length, 1)
  })

  test('protected system locations are refused outright, never escalated', () => {
    const auth = { ...emptyAuthorization(), writeRoots: ['/'] }
    const d = checkScopes(auth, [{ kind: 'write', path: '/System/Library/thing' }])
    assert.equal(d.allowed, false)
    assert.ok(d.refused)
    assert.equal(d.missing.length, 0)
  })

  test('a write root implies read access to the same tree', () => {
    const auth = { ...emptyAuthorization(), writeRoots: ['/Users/x/Downloads'] }
    assert.equal(checkScopes(auth, [{ kind: 'read', path: '/Users/x/Downloads/f' }]).allowed, true)
  })

  test('a read root does NOT imply write access', () => {
    const auth = { ...emptyAuthorization(), readRoots: ['/Users/x/Downloads'] }
    assert.equal(checkScopes(auth, [{ kind: 'write', path: '/Users/x/Downloads/f' }]).allowed, false)
  })

  test('sibling directories with a shared prefix are not treated as nested', () => {
    assert.equal(isWithin('/Users/x/Down', '/Users/x/Downloads'), false)
    assert.equal(isWithin('/Users/x/Downloads', '/Users/x/Downloads/a'), true)
  })

  test('ssh and keychain directories are protected', () => {
    assert.equal(isForbidden('~/.ssh/id_rsa'), true)
    assert.equal(isForbidden('~/Library/Keychains/x'), true)
    assert.equal(isForbidden('~/Downloads/x'), false)
  })

  test('origins are matched by origin, not by full URL', () => {
    const auth = { ...emptyAuthorization(), origins: ['https://example.com'] }
    assert.equal(checkScopes(auth, [{ kind: 'origin', url: 'https://example.com/a/b?c=1' }]).allowed, true)
    assert.equal(checkScopes(auth, [{ kind: 'origin', url: 'https://evil.com/' }]).allowed, false)
  })

  test('granting the missing scopes makes the same check pass', () => {
    let auth = { ...emptyAuthorization(), writeRoots: [] as string[] }
    const req = [{ kind: 'write' as const, path: '/Users/x/Documents' }]
    const first = checkScopes(auth, req)
    assert.equal(first.allowed, false)
    auth = extendAuthorization(auth, grantFor(first.missing))
    assert.equal(checkScopes(auth, req).allowed, true)
  })
})

describe('file tools', () => {
  test('list returns real entries with kinds', async () => {
    const task = makeTask([root], [])
    const out = await filesList.execute({ path: root, includeHidden: false }, makeCtx(task))
    const result = out.result as { entries: { name: string; kind: string }[] }
    const names = result.entries.map((e) => e.name).sort()
    assert.deepEqual(names, ['notes.txt', 'photo.png', 'report.pdf', 'sub'])
    assert.equal(result.entries.find((e) => e.name === 'sub')!.kind, 'directory')
    assert.equal(task.observations.length, 1)
  })

  test('search finds nested files by extension within the depth limit', async () => {
    const task = makeTask([root], [])
    const out = await filesSearch.execute(
      { root, extensions: ['.pdf'], maxDepth: 3, limit: 50 },
      makeCtx(task)
    )
    const matches = (out.result as { matches: { name: string }[] }).matches.map((m) => m.name).sort()
    assert.deepEqual(matches, ['deep.pdf', 'report.pdf'])
  })

  test('move records an undo entry and verifies the outcome', async () => {
    const task = makeTask([root], [root])
    const ctx = makeCtx(task)
    const dest = join(root, 'Docs')
    await filesCreateFolder.execute({ path: dest }, ctx)

    const from = join(root, 'report.pdf')
    const to = join(dest, 'report.pdf')
    const out = await filesMove.execute({ from, to, onConflict: 'rename' }, ctx)

    assert.equal(out.undo?.length, 1)
    assert.equal(out.undo![0]!.payload.from, from)
    assert.equal(out.undo![0]!.payload.to, to)

    const verification = await filesMove.verify!({ from, to, onConflict: 'rename' }, out, ctx)
    assert.equal(verification.verified, true)
    assert.equal(await fs.readFile(to, 'utf8'), 'pdf')
    await assert.rejects(() => fs.access(from))
  })

  test('a name collision produces "(2)" rather than overwriting', async () => {
    const task = makeTask([root], [root])
    const ctx = makeCtx(task)
    await fs.writeFile(join(root, 'dup.txt'), 'original')
    await fs.mkdir(join(root, 'Dest'), { recursive: true })
    await fs.writeFile(join(root, 'Dest', 'dup.txt'), 'existing')

    const out = await filesMove.execute(
      { from: join(root, 'dup.txt'), to: join(root, 'Dest', 'dup.txt'), onConflict: 'rename' },
      ctx
    )
    const to = (out.result as { to: string }).to
    assert.equal(to, join(root, 'Dest', 'dup (2).txt'))
    // The pre-existing file must be untouched.
    assert.equal(await fs.readFile(join(root, 'Dest', 'dup.txt'), 'utf8'), 'existing')
    assert.equal(await fs.readFile(to, 'utf8'), 'original')
  })

  test('onConflict "fail" refuses rather than renaming', async () => {
    const task = makeTask([root], [root])
    const ctx = makeCtx(task)
    await fs.writeFile(join(root, 'x.txt'), 'a')
    await fs.writeFile(join(root, 'Dest', 'x.txt'), 'b')
    await assert.rejects(
      () => filesMove.execute({ from: join(root, 'x.txt'), to: join(root, 'Dest', 'x.txt'), onConflict: 'fail' }, ctx),
      /already exists/
    )
  })

  test('verification fails when the destination is missing', async () => {
    const task = makeTask([root], [root])
    const ctx = makeCtx(task)
    const fake = {
      result: { from: join(root, 'gone-a'), to: join(root, 'gone-b'), moved: true }
    }
    const v = await filesMove.verify!({ from: 'a', to: 'b', onConflict: 'rename' }, fake, ctx)
    assert.equal(v.verified, false)
  })

  test('precondition rejects a missing source before anything changes', async () => {
    const task = makeTask([root], [root])
    await assert.rejects(
      () => filesMove.precondition!({ from: join(root, 'nope.txt'), to: join(root, 'x.txt'), onConflict: 'rename' }, makeCtx(task)),
      /does not exist/
    )
  })
})

describe('tool registry', () => {
  test('scoping hides tools the task has no business using', () => {
    const registry = new ToolRegistry()
    registry.registerAll(fileTools)
    const readOnly = registry.forTask(['files.read']).map((t) => t.name)
    assert.ok(readOnly.includes('files_list'))
    assert.ok(!readOnly.includes('files_move'), 'a read-only task must not be offered files_move')
  })

  test('every registered tool produces a valid model schema', () => {
    const registry = new ToolRegistry()
    registry.registerAll(fileTools)
    const schema = registry.toModelSchema(registry.all())
    assert.equal(schema.length, fileTools.length)
    for (const s of schema) {
      assert.ok(s.name && s.description, `${s.name} needs a description`)
      assert.equal(typeof s.input_schema, 'object')
    }
  })

  test('registering the same tool twice is an error', () => {
    const registry = new ToolRegistry()
    registry.register(filesList)
    assert.throws(() => registry.register(filesList), /duplicate/)
  })
})

describe('path normalisation', () => {
  test('tilde expands to the home directory', () => {
    assert.ok(normalizePath('~/Downloads').startsWith('/'))
    assert.ok(!normalizePath('~/Downloads').includes('~'))
  })
  test('traversal is resolved away', () => {
    assert.equal(normalizePath('/a/b/../c'), '/a/c')
  })
})
