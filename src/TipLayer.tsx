import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * Hover and focus help for every element with data-tip, drawn in one layer on top of everything (the header, the tab bar,
 * the rest overlay), placed above the element or below it when there's no room, and kept inside the window.
 */
export default function TipLayer() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number; below: boolean; align: string } | null>(null)
  useEffect(() => {
    let el: HTMLElement | null = null
    const show = (t: HTMLElement | null) => {
      el = t
      const text = t?.getAttribute('data-tip')
      if (!t || !text) { setTip(null); return }
      const r = t.getBoundingClientRect()
      const pos = t.getAttribute('data-pos') ?? 'center'
      const inHead = !!t.closest('th') || pos === 'below'
      // Above the element (over the header if need be); below only when it would run off the top of the window.
      const lines = Math.ceil((text.length * 6.3) / 240), h = 14 + 17 * lines
      const below = inHead || r.top - 6 - h < 4
      const x = pos === 'left' ? r.left : pos === 'right' ? r.right : r.left + r.width / 2
      setTip({ text, x, y: below ? r.bottom + 6 : r.top - 6, below, align: pos === 'left' ? 'left' : pos === 'right' ? 'right' : 'center' })
    }
    const over = (e: Event) => { const t = (e.target as HTMLElement)?.closest?.('[data-tip]') as HTMLElement | null; if (t !== el) show(t) }
    const out = (e: PointerEvent) => { if (el && !el.contains(e.relatedTarget as Node)) show(null) }
    const focus = (e: FocusEvent) => { const t = (e.target as HTMLElement)?.closest?.('[data-tip]') as HTMLElement | null; if (t && (e.target as HTMLElement).matches(':focus-visible')) show(t) }
    const hide = () => show(null)
    document.addEventListener('pointerover', over)
    document.addEventListener('pointerout', out as any)
    document.addEventListener('focusin', focus)
    document.addEventListener('focusout', hide)
    window.addEventListener('scroll', hide, true)
    document.addEventListener('pointerdown', hide)
    return () => {
      document.removeEventListener('pointerover', over); document.removeEventListener('pointerout', out as any)
      document.removeEventListener('focusin', focus); document.removeEventListener('focusout', hide)
      window.removeEventListener('scroll', hide, true); document.removeEventListener('pointerdown', hide)
    }
  }, [])
  if (!tip || matchMedia('(hover: none)').matches) return null
  const W = Math.min(260, window.innerWidth - 16)
  let left = tip.align === 'left' ? tip.x : tip.align === 'right' ? tip.x - W : tip.x - W / 2
  left = Math.max(8, Math.min(left, window.innerWidth - W - 8))
  return createPortal(
    <div className="tiplayer" role="tooltip" style={{ left, width: W, [tip.below ? 'top' : 'bottom']: tip.below ? tip.y : window.innerHeight - tip.y }}>
      <span style={{ marginLeft: tip.align === 'right' ? 'auto' : tip.align === 'center' ? 'auto' : undefined, marginRight: tip.align === 'center' ? 'auto' : undefined }}>{tip.text}</span>
    </div>,
    document.body,
  )
}
