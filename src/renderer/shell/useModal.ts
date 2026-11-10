import { useEffect, useRef, useState, type RefObject } from 'react'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Where Tab or Shift+Tab goes from `active` among the dialog's `items`, or null to let the browser move on its own.
 * Past either end it wraps; from outside the list (the dialog itself, say) it enters at the matching end.
 */
export function wrapTab<T>(items: T[], active: T | null, shift: boolean): T | null {
  if (items.length === 0) return null
  const at = active === null ? -1 : items.indexOf(active)
  if (at === -1) return shift ? items[items.length - 1] : items[0]
  if (!shift && at === items.length - 1) return items[0]
  if (shift && at === 0) return items[items.length - 1]
  return null
}

/** Elements made inert by an open modal, counted: two open at once must not release each other's. */
const inerted = new Map<Element, number>()

/** Makes everything but the dialog and its ancestors inert; returns the undo. */
function isolate(dialog: Element): () => void {
  const mine: Element[] = []
  for (let node: Element = dialog; node.parentElement; node = node.parentElement) {
    for (const sibling of node.parentElement.children) {
      if (sibling === node || sibling instanceof HTMLScriptElement) continue
      const n = inerted.get(sibling) ?? 0
      if (n === 0) (sibling as HTMLElement).inert = true
      inerted.set(sibling, n + 1)
      mine.push(sibling)
    }
  }
  return () => {
    for (const el of mine) {
      const n = (inerted.get(el) ?? 1) - 1
      if (n <= 0) { inerted.delete(el); (el as HTMLElement).inert = false } else inerted.set(el, n)
    }
  }
}

/** Open modals, the last one on top: only it answers Escape. */
const open: object[] = []

/**
 * Makes `ref` a real modal while it is mounted: focus goes in and cannot Tab out, the rest of the page is inert,
 * Escape calls `onEscape`, and closing gives focus back to what had it. aria-modal alone does none of this.
 * The dialog takes focus itself when it has a tabindex, else its first control, unless something inside already has it.
 */
export function useModal(ref: RefObject<HTMLElement | null>, onEscape: () => void): void {
  // Read during render: an autoFocus inside the dialog has moved focus by the time effects run.
  const [previous] = useState(() => document.activeElement)
  const escape = useRef(onEscape)
  escape.current = onEscape

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    const token = {}
    open.push(token)
    const release = isolate(dialog)
    if (!dialog.contains(document.activeElement)) {
      const first = dialog.hasAttribute('tabindex') ? dialog : dialog.querySelector<HTMLElement>(FOCUSABLE)
      ;(first ?? dialog).focus()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (open[open.length - 1] !== token) return
      if (e.key === 'Escape') {
        // A field that answers Escape itself (a label or subtask being typed) cancels its edit, not the dialog.
        if (e.defaultPrevented) return
        e.preventDefault()
        escape.current()
      } else if (e.key === 'Tab') {
        const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)]
        const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
        const target = wrapTab(items, active, e.shiftKey)
        if (target) { e.preventDefault(); target.focus() } else if (items.length === 0) { e.preventDefault(); dialog.focus() }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      open.splice(open.indexOf(token), 1)
      release()
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [ref, previous])
}
