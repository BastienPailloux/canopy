import { useEffect, useId, useMemo, useState } from 'react'
import { BRANCH_TYPES, type LaunchCandidate, type LaunchTarget } from '../../shared/tickets'
import { basename } from '../store'
import type { RepoRefs } from './TicketsScreen'

type BranchType = (typeof BRANCH_TYPES)[number]
type Candidates = { worktrees: LaunchCandidate[]; advanced: { branch: string; ahead: number } | null }


const REASON: Record<NonNullable<LaunchCandidate['reason']>, string> = {
  main: 'checkout principal',
  working: 'Claude travaille',
  waiting: 'attend ta réponse'
}

const plural = (n: number, one: string, many: string): string => `${n} ${n > 1 ? many : one}`

/** The type the name starts with, if one of BRANCH_TYPES. */
function typeOf(name: string): BranchType | null {
  const head = name.split('/')[0]
  return name.includes('/') && (BRANCH_TYPES as readonly string[]).includes(head) ? (head as BranchType) : null
}

/** The name with its type part replaced by `type`, or prefixed with it when it has none. */
function withType(name: string, type: BranchType): string {
  return typeOf(name) ? `${type}${name.slice(name.indexOf('/'))}` : `${type}/${name}`
}

/** The « Où lancer » cards and the branch name field; reports the launch target, null while it cannot launch. */
export function LaunchWhere(props: {
  repo: string; refs: RepoRefs; branch: string; onBranch: (b: string) => void
  onTarget: (t: LaunchTarget | null) => void
}): React.JSX.Element {
  const { repo, refs, onBranch, onTarget } = props
  const name = props.branch
  const ids = useId()
  const [where, setWhere] = useState<'new' | 'existing'>('new')
  const [newBase, setNewBase] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const [baseEdit, setBaseEdit] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<Candidates | null>(null)
  const [candidatesError, setCandidatesError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    window.canopy.launchCandidates(repo).then(
      (c) => { if (live) setCandidates(c) },
      (e: unknown) => { if (live) setCandidatesError(e instanceof Error ? e.message : String(e)) }
    )
    return () => { live = false }
  }, [repo])

  const def = refs.defaultBase
  const others = refs.branches.filter((b) => b !== def?.ref && b !== def?.name)
  const free = candidates?.worktrees.filter((w) => w.free) ?? []
  const worktree = candidates?.worktrees.find((w) => w.path === (picked ?? free[0]?.path)) ?? null
  const autoBase = baseEdit ?? candidates?.advanced?.branch ?? def?.ref ?? ''

  const branch = name.trim()
  const taken = branch !== '' && refs.branches.includes(branch)
  const base = where === 'new' ? (newBase || def?.ref || '') : autoBase.trim()
  const valid = branch !== '' && !/\s/.test(branch) && !taken
  const worktreePath = worktree?.free ? worktree.path : null
  const target = useMemo<LaunchTarget | null>(() => {
    if (base === '' || !valid) return null
    if (where === 'new') return { kind: 'new', base }
    return worktreePath ? { kind: 'existing', worktree: worktreePath, base } : null
  }, [where, base, valid, worktreePath])
  useEffect(() => { onTarget(target) }, [target, onTarget])

  const counts = worktree
    ? [worktree.dirty > 0 && plural(worktree.dirty, 'fichier mis de côté', 'fichiers mis de côté'), worktree.sessions > 0 && plural(worktree.sessions, 'session', 'sessions')]
        .filter(Boolean).join(' · ')
    : ''

  return (
    <>
      <section className="launch-where" role="radiogroup" aria-labelledby={`${ids}-where`}>
        <h3 id={`${ids}-where`} className="section-title">Où lancer</h3>
        <div className="where-card" data-checked={where === 'new'} onClick={() => setWhere('new')}>
          <input type="radio" name={`${ids}-where`} checked={where === 'new'} onChange={() => setWhere('new')} aria-labelledby={`${ids}-new`} />
          <div className="card-body">
            <span id={`${ids}-new`} className="card-title">Nouveau worktree</span>
            <span className="card-desc">Crée un dossier isolé dans .worktrees, avec sa propre session Claude Code.</span>
            <label className="from">
              Depuis
              <select aria-label="Base du nouveau worktree" className="mono" value={newBase} onChange={(e) => setNewBase(e.target.value)} onFocus={() => setWhere('new')}>
                <option value="" disabled={!def}>{def ? def.name : 'Choisir une base…'}</option>
                {others.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </label>
          </div>
        </div>
        <div className="where-card" data-checked={where === 'existing'} onClick={() => setWhere('existing')}>
          <input type="radio" name={`${ids}-where`} checked={where === 'existing'} onChange={() => setWhere('existing')} aria-labelledby={`${ids}-existing`} />
          <div className="card-body">
            <span id={`${ids}-existing`} className="card-title">Worktree existant, nouvelle branche</span>
            <span className="card-desc">Réutilise un worktree libre et y démarre une branche depuis la branche la plus avancée.</span>
            <div className="existing-box" onFocus={() => setWhere('existing')}>
              {candidatesError
                ? <p className="launch-warn">Worktrees indisponibles : {candidatesError}</p>
                : !candidates
                  ? <p className="launch-muted">Chargement…</p>
                  : (
                    <>
                      <label className="kv">
                        <span>Worktree</span>
                        <select aria-label="Worktree" className="mono" value={worktree?.path ?? ''} onChange={(e) => setPicked(e.target.value)}>
                          {!worktree && <option value="" disabled>Aucun worktree libre</option>}
                          {candidates.worktrees.map((w) => (
                            <option key={w.path} value={w.path} disabled={!w.free}>
                              {w.branch ?? basename(w.path)}{w.reason ? ` — ${REASON[w.reason]}` : ''}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="kv">
                        <span>Base auto</span>
                        <input aria-label="Base auto" className="mono base-auto" list={`${ids}-branches`} value={autoBase}
                          onChange={(e) => setBaseEdit(e.target.value)} spellCheck={false} />
                      </label>
                      {candidates.advanced && def && (
                        <span className="launch-muted">
                          La plus avancée : {plural(candidates.advanced.ahead, 'commit', 'commits')} d'avance sur {def.name}
                        </span>
                      )}
                      {counts && <span className="launch-counts">{counts}</span>}
                    </>
                  )}
              <datalist id={`${ids}-branches`}>{refs.branches.map((b) => <option key={b} value={b} />)}</datalist>
            </div>
          </div>
        </div>
      </section>

      <section className="launch-branch">
        <label htmlFor={`${ids}-name`} className="field-label">Nom de la branche</label>
        <div className="branch-row">
          <select aria-label="Type de branche" className="mono" value={typeOf(branch) ?? ''}
            onChange={(e) => { const t = e.target.value as BranchType; onBranch(withType(name.trim(), t)) }}>
            {!typeOf(branch) && <option value="" disabled>—</option>}
            {BRANCH_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <input id={`${ids}-name`} className="mono" value={name} onChange={(e) => onBranch(e.target.value)} spellCheck={false}
            aria-invalid={taken || undefined} />
        </div>
        {taken && <p className="launch-error" role="alert">Cette branche existe déjà</p>}
      </section>
    </>
  )
}
