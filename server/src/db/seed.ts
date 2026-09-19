import { randomUUID } from "node:crypto";
import { closeDatabase, db } from "./client.js";
import { badges, bumpEvents, connections } from "./schema.js";
import { processBump, registerBadge } from "../service.js";

const people = [
  ["badge-001", "Maya Chen", "Product designer", "Northstar"],
  ["badge-002", "Noah Williams", "ML engineer", "Vector Labs"],
  ["badge-003", "Sofia Ahmed", "Founder", "Patchwork"],
  ["badge-004", "Eli Martin", "Developer advocate", "Relay"],
  ["badge-005", "Priya Shah", "Systems engineer", "Current"],
  ["badge-006", "Lucas Kim", "Student", "University of Waterloo"],
  ["badge-007", "Amara Okafor", "Data scientist", "Fieldnote"],
  ["badge-008", "Theo Nguyen", "Frontend engineer", "Lumen"],
  ["badge-009", "Zoe Patel", "Security researcher", "Cipher"],
  ["badge-010", "Sam Rivera", "Hardware hacker", "Open Bench"],
] as const;

await db.delete(bumpEvents);
await db.delete(connections);
await db.delete(badges);

for (const [index, [hardwareId, name, role, company]] of people.entries()) {
  const profileSlug = name.toLowerCase().replaceAll(" ", ".");
  await registerBadge({
    hardwareId,
    name,
    role,
    company,
    bio: `${role} building and sharing ideas with the hacker community.`,
    attendeeId: 2601 + index,
    profileVersion: 1,
    claimId: `HTN26-${String(index + 1).padStart(4, "0")}`,
    email: `${profileSlug}@demo.hackthenorth.com`,
    phone: `+1 416 555 ${String(1100 + index)}`,
    linkedin: `linkedin.com/in/${profileSlug.replaceAll(".", "-")}`,
    discord: `${profileSlug.split(".")[0]}#${String(4100 + index)}`,
    provisionedUnix: Math.floor(Date.now() / 1000) - (people.length - index) * 3600,
    projectorIdentity: "alias",
  });
}

const pairs = [
  [0, 1], [0, 3], [1, 2], [1, 4], [2, 5], [3, 4],
  [3, 6], [4, 7], [5, 8], [6, 7], [7, 8], [8, 9],
] as const;

for (let index = 0; index < pairs.length; index += 1) {
  const [left, right] = pairs[index]!;
  await processBump({
    badge_id_a: people[left]![0],
    badge_id_b: people[right]![0],
    timestamp: new Date(Date.now() - (pairs.length - index) * 90_000).toISOString(),
    signal_strength: -42 - index,
    event_id: `seed-${randomUUID()}`,
    source: "seed",
  });
}

const seeded = await db.select().from(badges);
console.log(`Seeded ${seeded.length} badges.`);
console.log(`Sample private page: /badge/${seeded[0]?.privateToken}`);
await closeDatabase();
