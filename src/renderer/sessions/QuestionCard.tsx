import { useState } from 'react'
import type { PermissionRequest } from '../../shared/types'
import { answerPermission } from './sessionStore'

interface Question {
  question: string
  header?: string
  multiSelect?: boolean
  options: { label: string; description?: string }[]
}

interface Answer { selected: string[]; other: string }

const NO_ANSWER: Answer = { selected: [], other: '' }
const REFUSAL = "L'utilisateur n'a pas voulu répondre."

/** The questions of an `AskUserQuestion` input, or null if it does not have the observed shape. */
export function questionsOf(input: Record<string, unknown>): Question[] | null {
  const { questions } = input
  const valid = Array.isArray(questions) && questions.length > 0 && questions.every((q: Question) =>
    typeof q?.question === 'string' && Array.isArray(q.options))
  return valid ? (questions as Question[]) : null
}

/** Several labels are joined by `, `, and free text counts as one more. */
function answerText(a: Answer): string {
  return [...a.selected, ...(a.other.trim() ? [a.other.trim()] : [])].join(', ')
}

export function QuestionCard(props: { request: PermissionRequest; questions: Question[] }): React.JSX.Element {
  const { request, questions } = props
  const [answers, setAnswers] = useState<Record<string, Answer>>({})
  const answerOf = (q: Question): Answer => answers[q.question] ?? NO_ANSWER
  const update = (q: Question, a: Answer): void => setAnswers({ ...answers, [q.question]: a })

  const toggle = (q: Question, label: string): void => {
    const a = answerOf(q)
    if (!q.multiSelect) {
      update(q, { selected: [label], other: '' })
      return
    }
    const selected = a.selected.includes(label) ? a.selected.filter((l) => l !== label) : [...a.selected, label]
    update(q, { ...a, selected })
  }

  const typeOther = (q: Question, other: string): void => {
    const a = answerOf(q)
    update(q, { selected: q.multiSelect ? a.selected : [], other })
  }

  const send = (): void => {
    const texts = Object.fromEntries(questions.map((q) => [q.question, answerText(answerOf(q))]))
    void answerPermission(request.requestId, { allow: true, updatedInput: { questions, answers: texts } })
  }

  return (
    <div className="ask-card" data-testid="question-card" role="group" aria-label="Question de Claude">
      {questions.map((q) => (
        <fieldset key={q.question}>
          <legend>{q.question}</legend>
          {q.options.map((o) => (
            <label key={o.label}>
              <input type={q.multiSelect ? 'checkbox' : 'radio'} name={q.question} checked={answerOf(q).selected.includes(o.label)}
                onChange={() => toggle(q, o.label)} />
              <span>{o.label}</span>
              {o.description && <span className="muted">{o.description}</span>}
            </label>
          ))}
          <input type="text" className="other" aria-label={`Autre réponse : ${q.question}`} placeholder="Autre réponse"
            value={answerOf(q).other} onChange={(e) => typeOther(q, e.target.value)} />
        </fieldset>
      ))}
      <div className="ask-actions">
        <button type="button" className="primary" disabled={questions.some((q) => answerText(answerOf(q)) === '')} onClick={send}>Répondre</button>
        <button type="button" className="secondary" onClick={() => void answerPermission(request.requestId, { allow: false, message: REFUSAL })}>Refuser</button>
      </div>
    </div>
  )
}
