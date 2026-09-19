import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";

function equalSecret(received: string, expected: string) {
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function hasBearerToken(request: FastifyRequest, expected: string) {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  return equalSecret(header.slice(7), expected);
}
