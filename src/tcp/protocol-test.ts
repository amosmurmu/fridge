import { Op, encodeRequest, decodeRequests } from "./protocol.js";

const packet = encodeRequest(Op.SET, "user:1", "Amos");

const decoded = decodeRequests(packet);

console.log(decoded.requests[0]?.key.toString());
console.log(decoded.requests[0]?.value.toString());
console.log(decoded.remaining.length);
