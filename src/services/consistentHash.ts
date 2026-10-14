import { createHash } from "node:crypto";

export class ConsistentHash {
  private ring: { hash: string; node: string }[] = [];

  private readonly virtualNodes: number;

  constructor(virtualNodes = 100) {
    if (!Number.isInteger(virtualNodes) || virtualNodes < 1) {
      throw new Error("virtual Nodes must be atleast 1 ");
    }

    this.virtualNodes = virtualNodes;
  }

  private hash(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }

  addNode(node: string): void {
    for (let i = 0; i < this.virtualNodes; i++) {
      const hash = this.hash(`${node}#${i}`);

      this.ring.push({ hash, node });
    }
    this.ring.sort((a, b) => a.hash.localeCompare(b.hash));
  }

  removeNode(node: string): void {
    this.ring = this.ring.filter((entry) => entry.node !== node);
  }

  getNode(key: string): string | null {
    if (this.ring.length === 0) {
      return null;
    }

    const keyHash = this.hash(key);

    // Binary Search
    let left = 0;
    let right = this.ring.length - 1;
    let answer = -1;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);

      if (this.ring[mid]!.hash >= keyHash) {
        answer = mid;
        right = mid - 1;
      } else {
        left = mid + 1;
      }
    }

    if (answer === -1) {
      answer = 0;
    }

    return this.ring[answer]!.node;
  }

  getNodeCount(): number {
    return new Set(this.ring.map((entry) => entry.node)).size;
  }
}
