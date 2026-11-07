export interface Worktree { path: string; branch: string | null; head: string; isMain: boolean }
export interface BaseRef { name: string; ref: string }            // name: "main", ref: "origin/main" ou "main"
export interface ChangedFile { path: string; oldPath?: string; kind: 'A'|'M'|'D'|'R'; added: number; deleted: number; binary: boolean }
export interface WorktreeStats { ahead: number; added: number; deleted: number }
export type WorktreeStatus = 'waiting' | 'working' | 'pr_open' | 'idle'
export type SessionState = 'running' | 'waiting' | 'idle' | 'stopped' | 'error'
export interface SessionSummary { sessionId: string; title: string; lastModified: number; gitBranch?: string; live: boolean; state: SessionState }
export interface PermissionRequest { requestId: string; localId: string; toolName: string; input: Record<string, unknown> }
export type PermissionDecision = { allow: true; always?: boolean; updatedInput?: Record<string, unknown> } | { allow: false; message: string }
export interface ServiceConfig { name: string; command: string; portEnv: string }
export interface CanopyConfig { setup: string[]; services: ServiceConfig[] }
export interface SearchHit { path: string; line: number; column: number; text: string }
export interface Location { path: string; line: number; column: number }
