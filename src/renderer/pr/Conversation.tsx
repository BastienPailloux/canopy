import { useState } from 'react'
import { type CheckOutcome, type PrComment, type PrDetail, type PrReviewState, type PrThread, type PrTimelineItem, type PrUser } from '../../shared/pr'
import { Markdown } from '../sessions/Markdown'
import { useSessions } from '../sessions/sessionStore'
import { MergePanel } from './MergePanel'
import { claudeThreadLabel, hunkRows, isViewerClaudeReply, lineLabel, withoutSignature } from './conversationModel'
import { commentPrompt, threadPrompt } from './prPrompts'
import { act, sendToClaude, usePr } from './prStore'

/** GitHub shows about this many lines of a thread's hunk: the ones ending at the commented line. */
const HUNK_ROWS = 6

const when = (at: string): string => {
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

const initials = (login: string): string => login.split(/[-_.]/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase() || '?'

function Avatar({ login, claude }: { login: string; claude?: boolean }): React.JSX.Element {
  return <span className="pr-avatar" aria-hidden="true" data-claude={claude ? 'true' : undefined}>{claude ? '✦' : initials(login)}</span>
}

function ClaudeIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />
    </svg>
  )
}

/** Who wrote it: a reply Claude wrote from Canopy shows as Claude's, without its signature line, the account still named. */
function CommentBody({ comment, verb, viewerLogin }: { comment: PrComment; verb?: string; viewerLogin: string }): React.JSX.Element {
  const claude = isViewerClaudeReply(comment, viewerLogin)
  return (
    <div className="pr-reply" data-testid="pr-comment">
      <Avatar login={comment.author.login} claude={claude} />
      <div className="pr-reply-main">
        <span>
          {claude
            ? <><b>Claude</b> <span className="pr-muted">· via Canopy ({comment.author.login}) · {when(comment.createdAt)}</span></>
            : <><b>{comment.author.login}</b> <span className="pr-muted">{verb ? `${verb} · ` : '· '}{when(comment.createdAt)}</span></>}
        </span>
        <div className="pr-md"><Markdown text={claude ? withoutSignature(comment.body) : comment.body} /></div>
      </div>
    </div>
  )
}

function Description({ pr }: { pr: PrDetail }): React.JSX.Element {
  const busy = usePr((s) => s.busy)
  const [draft, setDraft] = useState<string | null>(null)
  const save = async (): Promise<void> => {
    if (draft === null) return
    if (await act({ type: 'editBody', body: draft })) setDraft(null)
  }
  return (
    <article className="pr-card" data-testid="pr-description">
      <div className="pr-card-head">
        <Avatar login={pr.author.login} />
        <b>{pr.author.login}</b><span className="pr-muted">a ouvert la PR · {when(pr.createdAt)}</span>
        {draft === null && <button className="pr-small pr-push" onClick={() => setDraft(pr.body)}>Modifier</button>}
      </div>
      {draft === null
        ? <div className="pr-card-body pr-md">{pr.body.trim() ? <Markdown text={pr.body} /> : <p className="pr-muted">Aucune description.</p>}</div>
        : (
          <div className="pr-card-body pr-editor">
            <textarea aria-label="Description de la PR" rows={8} value={draft} onChange={(e) => setDraft(e.target.value)} />
            <div className="pr-row">
              <button className="pr-btn pr-push" onClick={() => setDraft(null)}>Annuler</button>
              <button className="pr-btn pr-primary" disabled={busy !== null} onClick={() => void save()}>Enregistrer</button>
            </div>
          </div>
        )}
    </article>
  )
}

const CI_TEXT: Record<CheckOutcome, string> = { success: 'a réussi sur', failure: 'a échoué sur', pending: 'est en cours sur', neutral: 'est terminée sur' }
const REVIEW_TEXT: Record<PrReviewState, string> = {
  APPROVED: 'a approuvé', CHANGES_REQUESTED: 'a demandé des modifications', COMMENTED: 'a commenté', DISMISSED: 'a vu sa revue écartée'
}

function Event({ who, text, at, tone }: { who: string; text: string; at: string; tone: string }): React.JSX.Element {
  return (
    <div className="pr-event" data-tone={tone}>
      <span className="pr-event-dot" aria-hidden="true" />
      <span><b>{who}</b> {text} <span className="pr-muted">· {when(at)}</span></span>
    </div>
  )
}

function Hunk({ hunk }: { hunk: string }): React.JSX.Element {
  return (
    <div className="pr-hunk mono">
      {hunkRows(hunk, HUNK_ROWS).map((r, i) => (
        <div key={i} className="pr-hunk-row" data-kind={r.kind}>
          <span className="pr-hunk-n">{r.n ?? ''}</span>
          <span className="pr-hunk-sign">{r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ''}</span>
          <span className="pr-hunk-text">{r.text}</span>
        </div>
      ))}
    </div>
  )
}

function Thread({ pr, thread }: { pr: PrDetail; thread: PrThread }): React.JSX.Element {
  const busy = usePr((s) => s.busy)
  const tabId = usePr((s) => s.claudeThreads[thread.id])
  const tabState = useSessions((s) => (tabId ? s.tabs[tabId]?.state : undefined))
  const claude = claudeThreadLabel(tabState)
  const [unfolded, setUnfolded] = useState(false)
  const [reply, setReply] = useState<string | null>(null)
  const [first] = thread.comments
  const folded = thread.resolved && !unfolded
  const lines = lineLabel(thread)
  const send = async (): Promise<void> => {
    if (!first || reply === null || !reply.trim()) return
    if (await act({ type: 'reply', commentId: first.databaseId, body: reply })) setReply(null)
  }
  return (
    <article className="pr-card pr-thread" data-testid="pr-thread" data-resolved={thread.resolved ? 'true' : undefined}>
      <div className="pr-card-head">
        {first && <Avatar login={first.author.login} />}
        {first && <><b>{first.author.login}</b><span className="pr-muted">a commenté</span></>}
        <span className="mono pr-path">{thread.path}</span>
        <span className="mono pr-muted">{lines ? `${lines} · ` : ''}{first ? when(first.createdAt) : ''}</span>
        <span className="pr-push" />
        {thread.outdated && <span className="pr-badge" data-tone="muted">Obsolète</span>}
        {thread.resolved && <span className="pr-badge" data-tone="ok">Résolue</span>}
      </div>
      {!folded && (
        <>
          {thread.diffHunk && <Hunk hunk={thread.diffHunk} />}
          <div className="pr-card-body pr-thread-body">
            {thread.comments.map((c) => <CommentBody key={c.id} comment={c} viewerLogin={pr.viewerLogin} />)}
            {reply !== null && (
              <div className="pr-editor">
                <textarea aria-label="Réponse" rows={3} autoFocus value={reply} onChange={(e) => setReply(e.target.value)} />
                <div className="pr-row">
                  <span className="pr-muted pr-note">Publié sur GitHub sous ton compte</span>
                  <button className="pr-btn pr-push" onClick={() => setReply(null)}>Annuler</button>
                  <button className="pr-btn pr-primary" disabled={busy !== null || !reply.trim()} onClick={() => void send()}>Envoyer la réponse</button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
      <div className="pr-card-foot pr-row">
        {thread.resolved
          ? (
            <>
              <button className="pr-btn" onClick={() => setUnfolded(!unfolded)}>{unfolded ? 'Replier' : 'Déplier'}</button>
              <button className="pr-btn" disabled={busy !== null} onClick={() => void act({ type: 'resolve', threadId: thread.id, resolved: false })}>Rouvrir la conversation</button>
            </>
          )
          : (
            <>
              {first && (
                <button className="pr-btn pr-claude" disabled={claude.busy} onClick={() => sendToClaude(threadPrompt(pr, thread), thread.id)}>
                  <ClaudeIcon />{claude.label}
                </button>
              )}
              {reply === null && first && <button className="pr-btn" onClick={() => setReply('')}>Répondre</button>}
              <button className="pr-btn" disabled={busy !== null} onClick={() => void act({ type: 'resolve', threadId: thread.id, resolved: true })}>Résoudre la conversation</button>
            </>
          )}
      </div>
    </article>
  )
}

function Item({ pr, item }: { pr: PrDetail; item: PrTimelineItem }): React.JSX.Element {
  switch (item.kind) {
    case 'push':
      return <Event who={item.author.login} text={`a poussé ${item.count} commit${item.count > 1 ? 's' : ''}`} at={item.at} tone="push" />
    case 'ci':
      return <Event who="CI" text={`${CI_TEXT[item.outcome]} ${item.sha.slice(0, 7)}`} at={item.at} tone={item.outcome} />
    case 'review':
      return item.body.trim()
        ? <article className="pr-card"><div className="pr-card-body"><CommentBody comment={reviewComment(item)} verb={REVIEW_TEXT[item.state]} viewerLogin={pr.viewerLogin} /></div></article>
        : <Event who={item.author.login} text={REVIEW_TEXT[item.state]} at={item.at} tone={item.state === 'APPROVED' ? 'success' : item.state === 'CHANGES_REQUESTED' ? 'failure' : 'neutral'} />
    case 'comment':
      return <article className="pr-card"><div className="pr-card-body"><CommentBody comment={item.comment} verb="a commenté" viewerLogin={pr.viewerLogin} /></div></article>
    case 'thread':
      return <Thread pr={pr} thread={item.thread} />
  }
}

const reviewComment = (r: { at: string; author: PrUser; body: string }): PrComment => ({ id: '', databaseId: 0, author: r.author, body: r.body, createdAt: r.at })

function Composer({ pr }: { pr: PrDetail }): React.JSX.Element {
  const busy = usePr((s) => s.busy)
  const [text, setText] = useState('')
  const empty = !text.trim()
  const comment = async (): Promise<void> => {
    if (await act({ type: 'comment', body: text })) setText('')
  }
  return (
    <div className="pr-card pr-composer">
      <label htmlFor="pr-comment"><b>Ajouter un commentaire</b></label>
      <textarea id="pr-comment" rows={3} value={text} placeholder="Écris un commentaire (Markdown), ou @mentionne quelqu'un…" onChange={(e) => setText(e.target.value)} />
      <div className="pr-row">
        <span className="pr-muted pr-note">Publié sur GitHub sous ton compte</span>
        <button className="pr-btn pr-claude pr-push" disabled={empty} onClick={() => { if (sendToClaude(commentPrompt(pr, text.trim()))) setText('') }}>Envoyer à Claude</button>
        <button className="pr-btn pr-primary" disabled={empty || busy !== null} onClick={() => void comment()}>Commenter</button>
      </div>
    </div>
  )
}

const OWN_PR = "GitHub ne permet pas d'approuver sa propre PR"

function Review({ pr }: { pr: PrDetail }): React.JSX.Element {
  const busy = usePr((s) => s.busy)
  const [body, setBody] = useState('')
  const own = pr.viewerIsAuthor
  const review = async (event: 'APPROVE' | 'REQUEST_CHANGES'): Promise<void> => {
    if (await act({ type: 'review', event, body: body.trim() })) setBody('')
  }
  return (
    <div className="pr-card pr-composer">
      <label htmlFor="pr-review"><b>Revue</b></label>
      <textarea id="pr-review" rows={2} value={body} disabled={own} placeholder="Commentaire de revue (facultatif pour approuver)" onChange={(e) => setBody(e.target.value)} />
      <div className="pr-row">
        <button className="pr-btn pr-push" disabled={own || busy !== null || !body.trim()}
          title={own ? OWN_PR : body.trim() ? undefined : 'Explique ce qu\'il faut modifier'}
          onClick={() => void review('REQUEST_CHANGES')}>Demander des modifications</button>
        <button className="pr-btn pr-approve" disabled={own || busy !== null} title={own ? OWN_PR : undefined}
          onClick={() => void review('APPROVE')}>Approuver</button>
      </div>
    </div>
  )
}

/** The « Conversation » sub-tab: description, timeline from oldest to newest, then the comment and review boxes and the merge panel. */
export function Conversation({ pr }: { pr: PrDetail }): React.JSX.Element {
  const live = pr.state === 'open' || pr.state === 'draft'
  return (
    <>
      <Description pr={pr} />
      {/* GitHub sends the latest items: the ones cut are the oldest. */}
      {pr.truncated.timeline > 0 && (
        <button className="pr-btn pr-more" onClick={() => void window.canopy.openExternal(pr.url)}>{pr.truncated.timeline} de plus — ouvrir sur GitHub</button>
      )}
      {/* A thread is keyed on its state: resolving folds it again. */}
      {pr.timeline.map((item, i) => <Item key={item.kind === 'thread' ? `${item.thread.id}:${item.thread.resolved}` : `${item.kind}:${item.at}:${i}`} pr={pr} item={item} />)}
      <Composer pr={pr} />
      {live && <Review pr={pr} />}
      <MergePanel pr={pr} />
    </>
  )
}
