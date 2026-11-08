import { useStore, templateFor } from '../lib/store'
import { localDate } from '../lib/load'

const DAYS = [1, 2, 3, 4, 5, 6, 0]

export default function Plan({ lifterId }: { lifterId: string }) {
  const { templates } = useStore()
  const date = localDate()
  const today = new Date().getDay()
  return (
    <div className="stack">
      {DAYS.map(wd => {
        const t = templateFor(templates, lifterId, wd, '9999-12-31')
        if (!t) return null
        const s = t.spec ?? {}
        return (
          <section key={wd} className={'card' + (wd === today ? ' today' : '')}>
            <h2>{t.name}</h2>
            <div className="plangrid small">
              <div><span className="muted">Speed</span>{s.speed?.items?.map((i: any) => <div key={i.name}>{i.name}</div>) ?? <div>—</div>}</div>
              <div><span className="muted">Heavy</span><div className="cap">{s.heavy?.lift}{s.heavy?.cycle ? ' (6-week cycle)' : ' ladder'}</div></div>
              <div><span className="muted">Support · {s.support?.group}</span>{s.support?.items?.map((i: any) => <div key={i.name}>{i.name}</div>)}</div>
            </div>
            {s.logic && <p className="small muted">{s.logic}</p>}
          </section>
        )
      })}
      <p className="small muted center-text">Plan as of {date}. The coach edits templates.</p>
    </div>
  )
}
