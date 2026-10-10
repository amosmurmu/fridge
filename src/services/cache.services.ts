type CacheValue = unknown;

class LRUNode {
  prev: LRUNode | null = null;
  next: LRUNode | null = null;

  constructor(
    public key: string,
    public value: CacheValue,
    public expiresAt: number | null = null,
  ) {}
}

export class CacheService {
  private store = new Map<string, LRUNode>();

  private head = new LRUNode("", null);
  private tail = new LRUNode("", null);

  constructor(private readonly capacity: number) {
    if (capacity < 1) {
      throw new Error("Capacity must be at least 1");
    }

    this.head.next = this.tail;
    this.tail.prev = this.head;
  }

  private detach(node: LRUNode): void {
    node.prev!.next = node.next;
    node.next!.prev = node.prev;
  }

  private addToFront(node: LRUNode): void {
    node.next = this.head.next;
    node.prev = this.head;

    this.head.next!.prev = node;
    this.head.next = node;
  }

  private touch(node: LRUNode): void {
    this.detach(node);
    this.addToFront(node);
  }

  private remove(node: LRUNode): void {
    this.detach(node);
    this.store.delete(node.key);
  }

  get(key: string): CacheValue | null {
    const node = this.store.get(key);

    if (!node) return null;

    if (node.expiresAt !== null && node.expiresAt <= Date.now()) {
      this.remove(node);
      return null;
    }

    this.touch(node);
    return node.value;
  }

  set(key: string, value: CacheValue, ttlMs?: number): void {
    if (ttlMs !== undefined && ttlMs <= 0) {
      this.delete(key);
      return;
    }

    const expiresAt = ttlMs === undefined ? null : Date.now() + ttlMs;

    const existing = this.store.get(key);

    if (existing) {
      existing.value = value;
      existing.expiresAt = expiresAt;
      this.touch(existing);
      return;
    }

    const node = new LRUNode(key, value, expiresAt);

    this.store.set(key, node);
    this.addToFront(node);

    if (this.store.size > this.capacity) {
      const lru = this.tail.prev!;

      this.remove(lru);
    }
  }

  delete(key: string): boolean {
    const node = this.store.get(key);

    if (!node) return false;

    this.remove(node);
    return true;
  }

  get size(): number {
    return this.store.size;
  }
}
