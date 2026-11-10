import { useState } from 'react'
import { create } from 'zustand'
import type { CleanupRequest, MergeMethod, PrDetail } from '../../shared/pr'
import type { Worktree } from '../../shared/types'
import { RemoveWorktreeDialog } from '../shell/RemoveWorktreeDialog'
import { forget } from '../shell/useWorktrees'
import { useApp } from '../store'
import { rescan } from '../tickets/launchFlow'
import { useLinear } from '../tickets/linearStore'
import { useTickets } from '../tickets/ticketStore'
import { runAfterMerge, type AfterMergeInput } from './afterMerge'
import { defaultBody, defaultMethod, defaultSubject, isConventional, linkedTicket, mergedHow, mergeGates, METHODS, type GateAction, type GateId, type MergeGate } from './mergeModel'
import { checkPrompt } from './prPrompts'
import { act, sendToClaude, usePr } from './prStore'
import './pr.css'

/** What a merge from Canopy did, for the « PR mergée » detail; `lines` null while it runs. */
interface MergeResult { cwd: string; number: number; title: string; base: string; how: string; lines: string[] | null }
interface Removal { repo: string; worktree: Worktree; resolve: (removed: boolean) => void }

interface MergeState {
  /** By `cwd#number`. */
  results: Record<string, MergeResult>
  /** The result shown outside the tab (the worktree switched or went): its key, until dismissed. */
  notice: string | null
  removal: Removal | null
}

export const useMerge = create<MergeState>(() => ({ results: {}, notice: null, removal: null }))

const keyOf = (cwd: string, number: number): string => `${cwd}#${number}`

/** The worktree at `cwd` as the open folder lists it: its main checkout, and whether it is that checkout. */
function placeOf(cwd: string): { repo: string; isMain: boolean } | null {
  const s = useApp.getState()
  const entry = s.workspace?.entries.find((e) => e.worktree.path === cwd)
  if (entry) return { repo: entry.repo, isMain: entry.worktree.isMain }
  const w = s.worktrees.find((x) => x.path === cwd)
  return w && s.repo ? { repo: s.repo, isMain: w.isMain } : null
}

/** Opens the existing removal dialog, with its risks: resolves true once the worktree is removed, false on cancel. */
async function confirmRemoval(repo: string, path: string): Promise<boolean> {
  const worktree = (await window.canopy.listWorktrees(repo)).find((w) => w.path === path)
  if (!worktree || worktree.isMain) return false
  return new Promise((resolve) => {
    useMerge.getState().removal?.resolve(false)
    useMerge.setState({ removal: { repo, worktree, resolve } })
  })
}

/**
 * Runs what follows a merge started from the tab (or an auto-merge it enabled) for the worktree at `cwd`, keeps its
 * lines for the panel and the notice, then reads the worktree list again: the worktree may have switched or gone.
 */
export async function finishMerge(cwd: string, pr: AfterMergeInput['pr'] & { title: string; base: string }, how: string, cleanup: boolean): Promise<void> {
  const key = keyOf(cwd, pr.number)
  if (useMerge.getState().results[key]) return
  useMerge.setState((s) => ({ results: { ...s.results, [key]: { cwd, number: pr.number, title: pr.title, base: pr.base, how, lines: null } }, notice: key }))
  const place = placeOf(cwd)
  // Unknown here: treated as the main checkout, never removed.
  const repo = place?.repo ?? useApp.getState().repo ?? cwd
  const tickets = useApp.getState().repo === repo ? useTickets.getState().entries : []
  const ticket = linkedTicket(pr.head, useLinear.getState().links, tickets)
  const lines = await runAfterMerge({ cwd, repo, isMain: place?.isMain ?? true, pr, cleanup, ticket }, { api: window.canopy, confirmRemoval })
  useMerge.setState((s) => ({ results: { ...s.results, [key]: { ...s.results[key], lines } } }))
  await rescan(repo)
}

/** `pr:autoMerged`: GitHub merged an auto-merge the tab enabled with the box checked. Returns the stop function. */
export function connectAfterMerge(): () => void {
  return window.canopy.on('pr:autoMerged', (payload) => {
    const p = payload as { cwd?: unknown; req?: Partial<CleanupRequest> } | null
    const req = p?.req
    if (typeof p?.cwd !== 'string' || !req || typeof req.number !== 'number' || typeof req.branch !== 'string' || typeof req.headOid !== 'string') return
    const shown = usePr.getState().detail
    const same = shown?.number === req.number && usePr.getState().cwd === p.cwd
    void finishMerge(p.cwd, { number: req.number, head: req.branch, headOid: req.headOid, title: same ? shown.title : '', base: same ? shown.base : '' }, 'Auto-merge', true)
  })
}

/** The removal dialog the cleanup asks for, and the result of a merge whose PR the tab no longer shows. */
export function MergeOverlays(): React.JSX.Element {
  const removal = useMerge((s) => s.removal)
  const notice = useMerge((s) => (s.notice ? s.results[s.notice] : undefined))
  const onTab = useApp((s) => s.view === 'pr')
  const onPr = usePr((s) => notice !== undefined && s.cwd === notice.cwd && s.detail?.number === notice.number)
  const shownHere = onTab && onPr
  const close = (removed: boolean): void => {
    if (!removal) return
    useMerge.setState({ removal: null })
    removal.resolve(removed)
    if (!removed) return
    forget(removal.worktree.path)
    // The list drops it now: the selection must not stay on a removed worktree while the local branch goes.
    void rescan(removal.repo)
  }
  return (
    <>
      {removal && <RemoveWorktreeDialog repo={removal.repo} worktree={removal.worktree} onRemoved={() => close(true)} onClose={() => close(false)} />}
      {notice && !shownHere && (
        <div className="pr-merge-notice" role="status" data-testid="pr-merge-notice">
          <div className="pr-row">
            <b>PR #{notice.number} mergée{notice.base ? ` dans ${notice.base}` : ''}</b>
            <button className="pr-small pr-push" onClick={() => useMerge.setState({ notice: null })}>Fermer</button>
          </div>
          {notice.title && <span className="pr-muted">{notice.title}</span>}
          <MergedLines result={notice} />
        </div>
      )}
    </>
  )
}

function MergedLines({ result }: { result: MergeResult }): React.JSX.Element {
  return (
    <ul className="pr-merged-lines" data-testid="pr-merged-lines">
      <li>{result.how}</li>
      {result.lines === null ? <li className="pr-muted">Nettoyage en cours…</li> : result.lines.map((l) => <li key={l}>{l}</li>)}
    </ul>
  )
}

const GATE_TITLE: Record<GateId, string> = { draft: 'Brouillon', review: 'Review', threads: 'Conversations', checks: 'Checks', branch: 'Branche' }
const ACTION_LABEL: Record<GateAction, string> = {
  ready: 'Prête pour review', showConversation: 'Voir', fixChecks: 'Corriger avec Claude', updateBranch: 'Mettre à jour la branche'
}
const GATE_ICON = { ok: 'M5 12l5 5L20 7', bad: 'M6 6l12 12M18 6L6 18', wait: 'M12 7v5l3 3' }

function Gate({ pr, gate }: { pr: PrDetail; gate: MergeGate }): React.JSX.Element {
  const busy = usePr((s) => s.busy)
  const tone = gate.ok === true ? 'ok' : gate.ok === 'wait' ? 'wait' : 'bad'
  const run = async (a: GateAction): Promise<void> => {
    switch (a) {
      case 'ready': await act({ type: 'draft', draft: false }); break
      case 'updateBranch': await act({ type: 'updateBranch' }); break
      case 'showConversation':
        document.querySelector('[data-testid="pr-thread"]:not([data-resolved="true"])')?.scrollIntoView({ block: 'start', behavior: 'smooth' })
        break
      case 'fixChecks': {
        const cwd = usePr.getState().cwd
        const check = pr.checks.find((c) => c.outcome === 'failure')
        if (!cwd || !check) return
        const log = check.run ? await window.canopy.prFailedLog(cwd, check.run.runId, check.run.jobId).catch(() => '') : ''
        sendToClaude(checkPrompt(pr, check, log, pr.headOid.slice(0, 7)))
      }
    }
  }
  return (
    <div className="pr-gate" data-testid="pr-gate" data-gate={gate.id} data-tone={tone} data-blocking={gate.blocking ? 'true' : undefined}>
      <span className="pr-gate-icon" aria-hidden="true">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d={GATE_ICON[tone]} /></svg>
      </span>
      <span className="pr-gate-text"><b>{GATE_TITLE[gate.id]}</b><span className="pr-muted pr-note">{gate.detail}</span></span>
      {gate.action && (
        <button className={`pr-btn pr-small${gate.action === 'fixChecks' ? ' pr-claude' : ''}`}
          disabled={gate.action !== 'showConversation' && gate.action !== 'fixChecks' && busy !== null}
          onClick={() => void run(gate.action!)}>{ACTION_LABEL[gate.action]}</button>
      )}
    </div>
  )
}

function MergeIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      <circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="12" r="2.5" /><path d="M6 8.5v7M8 7.5c2 3 5 4.5 7.5 4.5" />
    </svg>
  )
}

function Merged({ pr }: { pr: PrDetail }): React.JSX.Element {
  const busy = usePr((s) => s.busy)
  const cwd = usePr((s) => s.cwd)
  const result = useMerge((s) => (cwd ? s.results[keyOf(cwd, pr.number)] : undefined))
  const [revertUrl, setRevertUrl] = useState<string | null>(null)
  const revert = async (): Promise<void> => {
    const r = await act({ type: 'revert' })
    if (r && 'url' in r) setRevertUrl(r.url)
  }
  return (
    <div className="pr-merged">
      <span className="pr-merged-icon" aria-hidden="true"><MergeIcon /></span>
      <div className="pr-merged-text">
        <b>PR mergée dans {pr.base}</b>
        {result && <MergedLines result={result} />}
        {revertUrl && (
          <span>PR de revert créée : <button className="pr-link pr-revert-link" onClick={() => void window.canopy.openExternal(revertUrl)}>{revertUrl}</button></span>
        )}
      </div>
      {!revertUrl && <button className="pr-btn" disabled={busy !== null} onClick={() => void revert()}>Annuler (revert)</button>}
    </div>
  )
}

function OpenPanel({ pr }: { pr: PrDetail }): React.JSX.Element {
  const busy = usePr((s) => s.busy)
  const methods = pr.repo.methods
  const [method, setMethod] = useState<MergeMethod>(() => defaultMethod(pr))
  const [subject, setSubject] = useState(() => defaultSubject(pr))
  const [body, setBody] = useState(() => defaultBody(pr))
  const [cleanup, setCleanup] = useState(true)
  const gates = mergeGates(pr)
  const blocked = gates.some((g) => g.blocking)
  const message = method !== 'rebase'
  // Main refuses an empty subject for squash and merge.
  const ready = !blocked && busy === null && (!message || subject.trim() !== '')

  const merge = async (): Promise<void> => {
    const cwd = usePr.getState().cwd
    if (!cwd || !ready) return
    const done = await act({ type: 'merge', method, subject: subject.trim(), body })
    // A refused merge cleans nothing: `act` showed GitHub's message.
    if (!done) return
    // Merged by hand: an auto-merge watched for this PR must not run the cleanup a second time.
    if (pr.autoMerge) void window.canopy.prWatchAutoMerge(cwd, null).catch(() => undefined)
    await finishMerge(cwd, pr, mergedHow(method, pr.commits.length), cleanup)
  }

  const toggleAuto = async (): Promise<void> => {
    const cwd = usePr.getState().cwd
    if (!cwd) return
    const enable = !pr.autoMerge
    if (!(await act({ type: 'autoMerge', enable, method, subject: subject.trim(), body }))) return
    // The box as it is now decides the cleanup once GitHub merges.
    await window.canopy.prWatchAutoMerge(cwd, enable ? { number: pr.number, branch: pr.head, headOid: pr.headOid, cleanup } : null).catch(() => undefined)
  }

  const status = pr.autoMerge
    ? 'Auto-merge activé : mergera dès que tout est vert'
    : blocked ? 'Merge bloqué tant que les points ci-dessus ne sont pas réglés' : 'Prêt à merger'
  return (
    <>
      {gates.map((g) => <Gate key={g.id} pr={pr} gate={g} />)}
      <div className="pr-merge-form">
        <div className="pr-row">
          <div className="pr-methods" role="group" aria-label="Méthode de merge">
            {methods.map((m) => (
              <button key={m} aria-pressed={m === method} onClick={() => setMethod(m)}>{METHODS[m].label}</button>
            ))}
          </div>
          <span className="pr-muted pr-note">{METHODS[method].hint(pr)}</span>
        </div>
        {message && (
          <div className="pr-merge-message">
            <label htmlFor="pr-merge-subject" className="pr-note">Message du commit (Conventional Commit, utilisé pour la release)</label>
            <input id="pr-merge-subject" className="mono" value={subject} onChange={(e) => setSubject(e.target.value)} />
            <textarea aria-label="Corps du commit" className="mono" rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
            {!isConventional(subject) && (
              <span className="pr-merge-warn pr-note" role="note">Ce sujet ne suit pas le format Conventional Commit : la PR ne comptera pas dans les notes de release.</span>
            )}
          </div>
        )}
        <label className="pr-merge-cleanup">
          <input type="checkbox" checked={cleanup} onChange={(e) => setCleanup(e.target.checked)} /> Supprimer la branche distante et le worktree après le merge
        </label>
        <div className="pr-row">
          <button className="pr-btn pr-merge-btn" disabled={!ready} onClick={() => void merge()}>{METHODS[method].button}</button>
          {pr.repo.autoMergeAllowed && (
            <button className="pr-btn pr-merge-auto" disabled={busy !== null || (!pr.autoMerge && message && !subject.trim())} onClick={() => void toggleAuto()}>
              {pr.autoMerge ? 'Désactiver l’auto-merge' : 'Activer l’auto-merge'}
            </button>
          )}
          <span className="pr-note" data-blocked={blocked ? 'true' : undefined} data-testid="pr-merge-status">{status}</span>
        </div>
      </div>
    </>
  )
}

/** The panel at the bottom of the conversation: the merge conditions and the merge, or what became of the PR. */
export function MergePanel({ pr }: { pr: PrDetail }): React.JSX.Element {
  const blocked = pr.state !== 'merged' && pr.state !== 'closed' && mergeGates(pr).some((g) => g.blocking)
  return (
    <section className="pr-merge" aria-label="Merge" data-state={pr.state} data-blocked={blocked ? 'true' : undefined}>
      {pr.state === 'merged' && <Merged pr={pr} />}
      {pr.state === 'closed' && <div className="pr-merge-closed">PR fermée sans merge. Le worktree et la branche sont conservés.</div>}
      {(pr.state === 'open' || pr.state === 'draft') && <OpenPanel key={pr.number} pr={pr} />}
    </section>
  )
}
