import net from "node:net";
import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";
import {
  decodeResponses,
  encodeRequest,
  Op,
  Status,
  type Response,
} from "./protocol.js";

const ROUTER_HOST = "127.0.0.1";
const ROUTER_PORT = 4000;

const REQUESTS = 10_000;
const CONCURRENCY = 50;
const HOT_KEY = "flash-sale:product:123:stock";

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)]!;
}

async function main() {
  const socket = net.createConnection({
    host: ROUTER_HOST,
    port: ROUTER_PORT,
  });

  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  const responses: Buffer[] = [];
  const waiters: {
    resolve: (response: Response) => void;
    reject: (error: Error) => void;
  }[] = [];

  socket.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);

    const result = decodeResponses(pending);
    pending = result.remaining;

    for (const response of result.responses) {
      const waiter = waiters.shift();

      if (waiter) {
        waiter.resolve(response);
      } else {
        responses.push(response.value);
      }
    }
  });

  function request(frame: Buffer): Promise<Response> {
    return new Promise((resolve, reject) => {
      waiters.push({ resolve, reject });
      socket.write(frame, (error) => {
        if (error) {
          const index = waiters.findIndex(
            (waiter) => waiter.resolve === resolve,
          );
          if (index !== -1) waiters.splice(index, 1);
          reject(error);
        }
      });
    });
  }

  // Propagate connection errors to waiting requests.
  socket.on("error", (error) => {
    while (waiters.length > 0) {
      waiters.shift()!.reject(error);
    }
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  // Seed the key before measuring GET latency.
  const setResponse = await request(encodeRequest(Op.SET, HOT_KEY, "100"));

  if (setResponse.status !== Status.OK) {
    throw new Error(`SET failed with status ${setResponse.status}`);
  }

  const latencies: number[] = [];
  let successful = 0;
  let failed = 0;
  let nextRequest = 0;

  const start = performance.now();

  async function worker() {
    while (true) {
      const id = nextRequest++;
      if (id >= REQUESTS) return;

      const requestStart = performance.now();

      try {
        const response = await request(encodeRequest(Op.GET, HOT_KEY));
        const latency = performance.now() - requestStart;

        // The router returns the cache status in the response header,
        // so inspect the full response below instead of only its value.
        if (
          response.status === Status.OK &&
          response.value.toString("utf8") === "100"
        ) {
          successful++;
          latencies.push(latency);
        } else {
          failed++;
        }
      } catch {
        failed++;
      }
    }
  }

  // Run concurrent workers over the same persistent connection.
  // The router's response order matches request order.
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const elapsedMs = performance.now() - start;
  socket.end();

  console.log("\nRouter benchmark");
  console.log("----------------");
  console.log(`Requests requested: ${REQUESTS}`);
  console.log(`Successful: ${successful}`);
  console.log(`Failed: ${failed}`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log(`Elapsed: ${(elapsedMs / 1000).toFixed(2)} s`);
  console.log(
    `Throughput: ${(successful / (elapsedMs / 1000)).toFixed(0)} req/s`,
  );

  if (latencies.length > 0) {
    console.log(`P50: ${percentile(latencies, 50).toFixed(3)} ms`);
    console.log(`P95: ${percentile(latencies, 95).toFixed(3)} ms`);
    console.log(`P99: ${percentile(latencies, 99).toFixed(3)} ms`);
    console.log(`Max: ${Math.max(...latencies).toFixed(3)} ms`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
