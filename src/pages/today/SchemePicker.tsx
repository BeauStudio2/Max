import { useEffect, useRef, useState } from 'react'

export const SCHEME_INFO: Record<string, string> = {
  'F': 'One set to failure: the rep you can’t complete.',
  'TF': 'One set to technical failure: stop when form breaks, before true failure.',
  'F + DS×1': 'To failure, drop the weight one step, go to failure again. No rest.',
  'F + DS×2': 'To failure, then two drops of one step each, to failure every time. No rest.',
  'F + DS×3': 'To failure, then three drops of one step each, to failure every time. No rest.',
  'RTR': 'Run the rack: at each failure drop one step and keep going, no rest, until the drops run out.',
  'F + ST×2': 'To failure, then strip plates twice, to failure each time. No rest.',
  '15 to TF + ST×2': 'Pick a weight for about 15 reps, go to technical failure, then strip twice.',
  'F + RP×2 (15 s)': 'Rest-pause: to failure, rest 15 s, go again; repeat twice. Same weight.',
  '1×F': 'A single all-out set.',
  '3×12–15 TF': 'Three sets of 12–15 reps, each to technical failure.',
}

/** Builds a description for a scheme the list doesn’t know, from its parts. */
export function describe(s: string) {
  if (SCHEME_INFO[s]) return SCHEME_INFO[s]
  const parts: string[] = []
  if (/\bTF\b/.test(s)) parts.push('technical failure')
  else if (/\bF\b/.test(s)) parts.push('to failure')
  const ds = /DS×(\d+)/.exec(s); if (ds) parts.push(`${ds[1]} drop set${ds[1] === '1' ? '' : 's'}`)
  const st = /ST×(\d+)/.exec(s); if (st) parts.push(`${st[1]} strip set${st[1] === '1' ? '' : 's'}`)
  const rp = /RP×(\d+)/.exec(s); if (rp) parts.push(`${rp[1]} rest-pause${rp[1] === '1' ? '' : 's'}`)
  if (/RTR/.test(s)) parts.push('run the rack')
  return parts.length ? parts.join(', ') : 'Custom scheme'
}

export default function SchemePicker({ value, options, onChange }: { value: string; options: string[]; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: Event) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', esc) }
  }, [open])
  const all = [...options, ...(value && !options.includes(value) ? [value] : [])]

  return (
    <div className="picker" ref={ref}>
      <button type="button" className="pickbtn" onClick={() => setOpen(o => !o)} aria-haspopup="listbox" aria-expanded={open}>
        <span>{value || '—'}</span><span className="chev">▾</span>
      </button>
      {open && (
        <div className="popover" role="listbox">
          {all.map(o => (
            <button type="button" key={o} role="option" aria-selected={o === value} className={'opt' + (o === value ? ' on' : '')}
              onClick={() => { onChange(o); setOpen(false) }}>
              <b>{o}</b><span>{describe(o)}</span>
            </button>
          ))}
          <button type="button" className="opt" onClick={() => {
            const s = window.prompt('Scheme', value)?.trim()
            if (s) onChange(s)
            setOpen(false)
          }}><b>Other…</b><span>Type your own, e.g. F + DS×4</span></button>
        </div>
      )}
    </div>
  )
}
