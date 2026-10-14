import { ConsistentHash } from "./consistentHash.js";

const ring = new ConsistentHash(100);

ring.addNode("cache-a");
ring.addNode("cache-b");
ring.addNode("cache-c");

console.log("Nodes:", ring.getNodeCount());

for (const key of [
  "user:1",
  "user:2",
  "user:3",
  "user:4",
  "product:10",
  "session:abc",
]) {
  console.log(key, "->", ring.getNode(key));
}

console.log("Removing cache-b...");

const counts: Record<string, number> = {
  "cache-a": 0,
  "cache-b": 0,
  "cache-c": 0,
};

for (let i = 0; i < 10_000; i++) {
  const node = ring.getNode(`user:${i}`);
  if (node) {
    counts[node] = (counts[node] ?? 0) + 1;
  }
}

console.log(counts);

ring.removeNode("cache-b");

for (const key of [
  "user:1",
  "user:2",
  "user:3",
  "user:4",
  "product:10",
  "session:abc",
]) {
  console.log(key, "->", ring.getNode(key));
}

console.log("Nodes:", ring.getNodeCount());
