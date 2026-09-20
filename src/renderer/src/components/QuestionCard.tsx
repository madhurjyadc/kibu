import { useState } from 'react'
import type { TaskState, UserQuestion } from '../../../shared/protocol.js'
import { basename, dirname } from '../lib/paths.js'

/**
 * Where the assistant stops and asks. Two distinct cases share this card:
 * a genuine ambiguity, and a request to widen what it is allowed to touch.
 * The second says plainly what access is being asked for.
 */
export function QuestionCard({ task, question }: { task: TaskState; question: UserQuestion }): React.JSX.Element {
  const [text, setText] = useState('')
  const [sent, setSent] = useState(false)

  function answer(optionId: string | null): void {
    if (sent) return
    setSent(true)
    void window.kibu.answerQuestion({
      taskId: task.id,
      questionId: question.id,
      optionId,
      text: text.trim() || undefined
    })
  }

  const ops = question.preview?.fileOps ?? []

  return (
    <div className={`question reason-${question.reason}`}>
      <p className="q-prompt">{question.prompt}</p>

      {question.preview && (
        <div className="preview">
          {question.preview.note && <p className="preview-note">{question.preview.note}</p>}
          {ops.length > 0 && (
            <>
              <ul className="ops">
                {ops.slice(0, 12).map((op, i) => (
                  <li key={`${op.from}-${i}`}>
                    <span className="op-name" title={op.from}>
                      {basename(op.from)}
                    </span>
                    <span className="op-arrow">→</span>
                    <span className="op-dest" title={op.to}>
                      {basename(dirname(op.to))}/
                    </span>
                  </li>
                ))}
              </ul>
              {ops.length > 12 && <p className="preview-more">…and {ops.length - 12} more</p>}
            </>
          )}
        </div>
      )}

      {question.allowFreeText && (
        <textarea
          className="q-text"
          rows={2}
          placeholder="Add a note, or just choose below"
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={sent}
        />
      )}

      <div className="q-options">
        {(question.options ?? [{ id: 'ok', label: 'Continue' }]).map((o) => (
          <button
            key={o.id}
            className={o.id === 'approve' || o.id === 'allow' || o.id === 'continue' ? 'primary' : ''}
            onClick={() => answer(o.id)}
            disabled={sent}
            title={o.detail}
          >
            {o.label}
          </button>
        ))}
        {question.allowFreeText && !question.options && (
          <button className="primary" onClick={() => answer(null)} disabled={sent || !text.trim()}>
            Send
          </button>
        )}
      </div>
    </div>
  )
}
