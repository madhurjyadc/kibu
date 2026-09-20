import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateArithmetic } from '../src/runtime/loop/calculate.js'

test('the calculator handles what a launcher is actually asked', () => {
  assert.equal(evaluateArithmetic('2+2'), 4)
  assert.equal(evaluateArithmetic('12*3'), 36)
  assert.equal(evaluateArithmetic('18% of 4250'), 765)
  assert.equal(evaluateArithmetic('18% of 4250 + 12*3'), 801)
  assert.equal(evaluateArithmetic('1,250 / 4'), 312.5)
  assert.equal(evaluateArithmetic('(3+4)*2'), 14)
  assert.equal(evaluateArithmetic('-5 + 10'), 5)
  assert.equal(evaluateArithmetic('2.5*4'), 10)
})

test('it refuses anything that is not arithmetic, rather than running it', () => {
  // The whole point of hand-parsing instead of eval: a launcher that executes
  // arbitrary typed text is a liability.
  assert.equal(evaluateArithmetic('process.exit(1)'), null)
  assert.equal(evaluateArithmetic('require("fs")'), null)
  assert.equal(evaluateArithmetic('tidy up my Downloads'), null)
  assert.equal(evaluateArithmetic('2 + '), null)
  assert.equal(evaluateArithmetic('(3+4'), null)
  assert.equal(evaluateArithmetic(''), null)
  assert.equal(evaluateArithmetic('1/0'), null)
  assert.equal(evaluateArithmetic('safari'), null)
})

test('arithmetic is recognised in the shapes a launcher actually receives', () => {
  // The three that were cancelled in real use, because nothing handled them.
  assert.equal(evaluateArithmetic('54/30'), 1.8)
  assert.equal(evaluateArithmetic('53/30'), 1.7666666667)
  assert.equal(evaluateArithmetic('  54 / 30  '), 1.8)
})
