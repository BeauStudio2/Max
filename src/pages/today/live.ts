/**
 * What the next heavy set looks like, published by its row so the voice and the Tindeq can use it without prop chains:
 * the weight and rep goal to announce, the plates and chains per side, and (spotter sets) the assist at which to say "Rack".
 */
export interface NextSet { lb: number; goal: number | null; stack: number[] | null; chains: { half: number; big: number } | null; rackLb: number | null
  /** Spotter set: the rep count after which Max says "Rack". */
  rackAt?: number | null }
export const live: { next: NextSet | null } = { next: null }

const plate = (p: number) => (p === 2.5 ? '2 and a half' : p === 1.25 ? '1 and a quarter' : String(p))
/** "285", "2" — then, with plates, "Each side", "45", "45", "10", "Chains", "half". Each piece is a phrase recorded ahead of time. */
export function nextPhrases(n: NextSet, sayLb: (lb: number) => string) {
  return [sayLb(n.lb), n.goal != null ? String(n.goal) : ''].filter(Boolean)
}
export function platePhrases(n: NextSet) {
  const out: string[] = []
  if (n.stack?.length) out.push('Each side', ...[...n.stack].sort((a, b) => b - a).map(plate))
  if (n.chains) {
    const { half, big } = n.chains
    if (!half && !big) out.push('No chains')
    else {
      out.push('Chains')
      if (half) { if (half > 1) out.push(String(half)); out.push('half') }
      if (big) { if (big > 1) out.push(String(big)); out.push('five eighths') }
    }
  }
  return out
}
