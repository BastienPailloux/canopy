import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'

export interface Worktree { path: string; branch: string | null; head: string; isMain: boolean }
export interface BaseRef {
  name: string                                                    // "main"
  ref: string                                                     // "origin/main" ou "main"
  /** The remembered base this one stands in for, its branch being gone. */
  lostBase?: string
}
export interface ChangedFile {
  path: string
  oldPath?: string
  kind: 'A'|'M'|'D'|'R'
  added: number
  deleted: number
  binary: boolean
  /** In bytes, for a file too big to count: it is then marked `binary`, its lines unknown. */
  size?: number
  /** Could not be read (rights, a submodule never fetched): its numbers say nothing. */
  unreadable?: boolean
}
export interface WorktreeStats { ahead: number; added: number; deleted: number }
export type Activity = 'waiting' | 'working' | 'idle'
export type WorktreeStatus = 'waiting' | 'working' | 'pr_open' | 'idle'
export type SessionState = 'running' | 'waiting' | 'idle' | 'stopped' | 'error'
export interface SessionSummary {
  sessionId: string
  title: string
  lastModified: number
  gitBranch?: string
  live: boolean
  state: SessionState
  /** Set for a live session only. */
  localId?: string
  /** Set for a live session only. */
  mode?: PermissionMode
}
export interface PermissionRequest {
  requestId: string
  localId: string
  toolName: string
  input: Record<string, unknown>
  /** False when no rule can be persisted: "always" must not be offered. */
  canAlways: boolean
  toolUseID: string
  description?: string
  decisionReason?: string
  blockedPath?: string
}
export type PermissionDecision = { allow: true; always?: boolean; updatedInput?: Record<string, unknown> } | { allow: false; message: string }
export interface UserContent { text: string; images?: { mediaType: string; base64: string }[] }
export interface ServiceConfig { name: string; command: string; portEnv: string }
export interface CanopyConfig { setup: string[]; services: ServiceConfig[] }
export interface SearchHit { path: string; line: number; column: number; text: string }
/** 1-based, like `SearchHit`; columns in UTF-16 units. */
export interface Location {
  /** Relative to the worktree, or absolute when `external`. */
  path: string
  line: number
  column: number
  /** The line, cut to a preview length. Absent for an external file. */
  text?: string
  /** Outside the worktree: shown, never opened. */
  external?: boolean
  /** Found by searching the word as text, not by the language server. */
  fallback?: boolean
}
export type SymbolLocation = Location & { name: string }

/** Hits `searchText` returns at most, unless asked otherwise. */
export const DEFAULT_SEARCH_LIMIT = 2000

export interface WorkspaceEntry {
  repo: string
  repoName: string
  worktree: Worktree
  group: 'space' | 'main' | 'feature' | 'other'
  feature?: string
}
export interface Workspace {
  root: string
  entries: WorkspaceEntry[]
  truncated: boolean
  /** Repos or folders that could not be read: what they held is unknown, not gone. */
  failed: string[]
}

/** Repos a scan keeps at most. */
export const MAX_WORKSPACE_REPOS = 200

/** Whether `path` is one of `folders` or lies under one. */
export const isUnder = (folders: string[], path: string): boolean => folders.some((f) => path === f || path.startsWith(`${f}/`))

/** Who the sessions bill: the Claude login, a saved API key, or nobody yet. */
export interface ClaudeAccount {
  method: 'login' | 'apiKey' | 'none' | 'unknown'
  email?: string
  organization?: string
  subscription?: string
}
