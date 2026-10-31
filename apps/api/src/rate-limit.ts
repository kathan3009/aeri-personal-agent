/**
 * In-memory sliding-window limits. Enough for one server machine; several machines would each keep their own count
 * (still a useful cap). Keys are opaque (a person's id or a client address), never request content.
 */
export function createLimiter(now: () => number = Date.now) {
  const hits = new Map<string, number[]>();
  let sweep = now();
  return (key: string, max: number, windowMs: number): { ok: boolean; retryAfter: number } => {
    const at = now();
    // Forget idle keys now and then so the map can't grow without bound.
    if (at - sweep > 10 * 60_000) { for (const [k, list] of hits) if (!list.length || at - list[list.length - 1] > 60 * 60_000) hits.delete(k); sweep = at; }
    const recent = (hits.get(key) ?? []).filter(time => at - time < windowMs);
    if (recent.length >= max) { hits.set(key, recent); return { ok: false, retryAfter: Math.ceil((recent[0] + windowMs - at) / 1000) }; }
    recent.push(at); hits.set(key, recent);
    return { ok: true, retryAfter: 0 };
  };
}
