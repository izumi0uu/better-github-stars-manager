import type { BgsmAgentSession } from '@/bgsm-agent/session';

const MAX_ENTRIES = 8;

/** Disposable, worker-owned snapshots keyed by canonical session revision. */
export class AgentCanonicalSessionCache {
  readonly #entries = new Map<string, BgsmAgentSession>();

  get(sessionId: string, revision: number): BgsmAgentSession | null {
    const entry = this.#entries.get(sessionId);
    if (!entry || entry.revision !== revision) return null;

    const snapshot = structuredClone(entry);
    this.#entries.delete(sessionId);
    this.#entries.set(sessionId, entry);
    return snapshot;
  }
  /** Returns an exact snapshot without changing LRU recency. */
  peek(sessionId: string, revision: number): BgsmAgentSession | null {
    const entry = this.#entries.get(sessionId);
    if (!entry || entry.revision !== revision) return null;
    return structuredClone(entry);
  }

  put(session: BgsmAgentSession): void {
    const current = this.#entries.get(session.id);
    if (current && current.revision > session.revision) return;

    const snapshot = structuredClone(session);
    this.#entries.delete(snapshot.id);
    this.#entries.set(snapshot.id, snapshot);
    this.evictOverflow();
  }

  delete(sessionId: string): void {
    this.#entries.delete(sessionId);
  }

  clear(): void {
    this.#entries.clear();
  }

  private evictOverflow(): void {
    while (this.#entries.size > MAX_ENTRIES) {
      const oldestSessionId = this.#entries.keys().next().value;
      if (oldestSessionId === undefined) return;
      this.#entries.delete(oldestSessionId);
    }
  }
}

