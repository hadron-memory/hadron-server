/**
 * Local dev seed (post-008-agent-installation).
 *
 * Builds a minimal-but-narrative fixture set on top of the post-008 schema:
 *
 *   - Three Orgs: a platform Org that authors agents, plus two installer Orgs.
 *   - A "Mealplan" agent (single-org install, unlimited members, shared
 *     app memory) — exercises Story 1 + the personal-memory pivot.
 *   - A "Juno" agent (multi-org install, maxMembers=2, per-user app memory)
 *     installed in TWO Orgs by the same end-user — exercises Story 2's
 *     privacy invariant (the multi-install isolation that 008 hangs on).
 *   - One AppKey per App, with raw keys printed at the end so a developer
 *     can paste them into hadron-portal or hadron-client.
 *
 * All identities are anonymized fixtures — names like "Alice", "Bob", "Mike",
 * org URNs like "platform-co", "acme-corp", etc. No real PII.
 *
 * Re-run with `pnpm db:dev-reset` (drops the dev DB and rebuilds from scratch).
 */
import { PrismaClient } from '../src/generated/prisma/index.js';
import { randomBytes, createHash } from 'crypto';
import { generateId } from '../src/lib/id.js';

const APP_KEY_PREFIX = 'hdr_app_';

function mintAppKey(): { rawKey: string; keyHash: string; keyPreview: string } {
  const rawKey = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  const keyHash = createHash('sha256').update(rawKey).digest('hex');
  // Preview = first 12 + last 4 of the raw key, matching the createAppKey
  // resolver shape so the portal preview UI displays the same thing it would
  // for a real key.
  const keyPreview = `${rawKey.slice(0, 12)}...${rawKey.slice(-4)}`;
  return { rawKey, keyHash, keyPreview };
}

const db = new PrismaClient();

interface MintedKey {
  appName: string;
  rawKey: string;
}

async function main() {
  const mintedKeys: MintedKey[] = [];
  console.log('Seeding hadron_dev (post-008 fixtures)...\n');

  // ── Organizations ─────────────────────────────────────────────────────
  // Platform-co: hosts the Mealplan + Juno agents (the "marketplace" side).
  // Acme-corp: deploys Mealplan (single-org install).
  // Mentor-co: deploys Juno (Mike's first install).
  // Client-co: also deploys Juno (Mike's second install — multi-install case).
  const platformOrg = await db.organization.create({
    data: {
      id: generateId(),
      name: 'Platform Co',
      urn: 'platform-co',
      isVisible: true,
    },
  });
  const acmeOrg = await db.organization.create({
    data: {
      id: generateId(),
      name: 'Acme Corp',
      urn: 'acme-corp',
      isVisible: true,
    },
  });
  const mentorOrg = await db.organization.create({
    data: {
      id: generateId(),
      name: 'Mentor Co',
      urn: 'mentor-co',
      isVisible: true,
    },
  });
  const clientOrg = await db.organization.create({
    data: {
      id: generateId(),
      name: 'Client Co',
      urn: 'client-co',
      isVisible: true,
    },
  });
  console.log(`  Created 4 orgs: platform-co, acme-corp, mentor-co, client-co`);

  // ── Users ─────────────────────────────────────────────────────────────
  // alice: platform-co builder; admin in platform-co.
  // bob: acme-corp owner; deploys Mealplan.
  // mike: ClientCo + MentorCo member; the load-bearing multi-install user.
  // dana: filler member to exercise maxMembers=2 on Juno.
  const alice = await db.user.create({
    data: {
      id: generateId(),
      handle: 'alice',
      identityProvider: 'EMAIL',
      name: 'Alice (fixture)',
      email: 'alice@platform-co.test',
      roles: ['ADMIN'],
    },
  });
  const bob = await db.user.create({
    data: {
      id: generateId(),
      handle: 'bob',
      identityProvider: 'EMAIL',
      name: 'Bob (fixture)',
      email: 'bob@acme-corp.test',
      roles: ['ADMIN'],
    },
  });
  const mike = await db.user.create({
    data: {
      id: generateId(),
      handle: 'mike',
      identityProvider: 'EMAIL',
      name: 'Mike (fixture)',
      email: 'mike@mentor-co.test',
      roles: ['ADMIN'],
    },
  });
  const dana = await db.user.create({
    data: {
      id: generateId(),
      handle: 'dana',
      identityProvider: 'EMAIL',
      name: 'Dana (fixture)',
      email: 'dana@mentor-co.test',
      roles: ['ADMIN'],
    },
  });
  console.log(`  Created 4 users: alice, bob, mike, dana`);

  // ── Org membership ────────────────────────────────────────────────────
  await db.orgMember.createMany({
    data: [
      { id: generateId(), organizationId: platformOrg.id, userId: alice.id, role: 'OWNER', canInvite: true },
      { id: generateId(), organizationId: acmeOrg.id, userId: bob.id, role: 'OWNER', canInvite: true },
      { id: generateId(), organizationId: mentorOrg.id, userId: mike.id, role: 'OWNER', canInvite: true },
      { id: generateId(), organizationId: mentorOrg.id, userId: dana.id, role: 'CONTRIBUTOR' },
      { id: generateId(), organizationId: clientOrg.id, userId: mike.id, role: 'OWNER', canInvite: true },
    ],
  });
  console.log(`  Created 5 org memberships`);

  // ── Knowledge memory (shared across Mealplan + Juno) ──────────────────
  // A simple platform-owned knowledge memory both agents can attach to.
  const sharedKnowledge = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: platformOrg.id,
      urn: `${platformOrg.urn}:recipes`,
      name: 'Recipes (shared knowledge)',
      class: 'knowledge',
      visibility: 'PUBLIC',
      shortDescription: 'Public recipe corpus',
    },
  });
  console.log(`  Created knowledge memory: recipes`);

  // ── Agent: Mealplan ────────────────────────────────────────────────────
  // Mealplan's system memory holds its conversation design. For seed
  // purposes we leave it empty — the chat-flow tests exercise the design.
  const mealplanSystemMemory = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: platformOrg.id,
      urn: `${platformOrg.urn}:mealplan-system`,
      name: 'Mealplan system memory',
      class: 'system',
    },
  });
  const mealplanAgent = await db.agent.create({
    data: {
      id: generateId(),
      organizationId: platformOrg.id,
      urn: `${platformOrg.urn}:mealplan`,
      name: 'Mealplan',
      description: 'Family meal planner agent (fixture)',
      systemMemoryId: mealplanSystemMemory.id,
      visibility: 'PUBLIC',
      memoryProvisioning: { appMemory: 'shared' },
      installationPolicy: {
        maxMembers: 'unlimited',
        memberRoles: ['owner', 'cook', 'eater'],
      },
    },
  });
  await db.agentMemoryItem.create({
    data: {
      id: generateId(),
      agentId: mealplanAgent.id,
      memoryId: sharedKnowledge.id,
      role: 'read',
    },
  });
  console.log(`  Created Mealplan agent (memberRoles: owner/cook/eater)`);

  // ── Agent: Juno ────────────────────────────────────────────────────────
  // Juno is the multi-install agent. installationPolicy.maxMembers=2 means
  // an installation can have at most a principal + guide.
  const junoSystemMemory = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: platformOrg.id,
      urn: `${platformOrg.urn}:juno-system`,
      name: 'Juno system memory',
      class: 'system',
    },
  });
  const junoAgent = await db.agent.create({
    data: {
      id: generateId(),
      organizationId: platformOrg.id,
      urn: `${platformOrg.urn}:juno`,
      name: 'Juno',
      description: 'Mentee mentor-chat agent (fixture)',
      systemMemoryId: junoSystemMemory.id,
      visibility: 'PUBLIC',
      // Per-user app memory — each mentee has private chat history per install.
      memoryProvisioning: { appMemory: 'user' },
      installationPolicy: {
        maxMembers: 2,
        memberRoles: ['principal', 'guide'],
      },
    },
  });
  console.log(`  Created Juno agent (maxMembers=2, appMemory=user)`);

  // ── App: Mealplan in Acme Corp ────────────────────────────────────────
  // Same-org install: platform-co owns Mealplan but acme-corp deploys it.
  // Cross-org → AgentOrgGrant required (008 R-2 / data-model.md gate 1).
  await db.agentOrgGrant.create({
    data: {
      orgId: acmeOrg.id,
      agentId: mealplanAgent.id,
      activatedAt: new Date(),
    },
  });
  const mealplanAppKey = mintAppKey();
  const mealplanApp = await db.app.create({
    data: {
      id: generateId(),
      organizationId: acmeOrg.id,
      urn: `${acmeOrg.urn}:mealplan`,
      name: 'Mealplan @ Acme',
      agentId: mealplanAgent.id,
      surfaces: ['chat', 'web'],
      appType: 'CHATBOT',
    },
  });
  await db.appKey.create({
    data: {
      id: generateId(),
      appId: mealplanApp.id,
      keyHash: mealplanAppKey.keyHash,
      keyPreview: mealplanAppKey.keyPreview,
      label: 'Mealplan @ Acme — initial key',
    },
  });
  await db.appMember.createMany({
    data: [
      { appId: mealplanApp.id, userId: bob.id, role: 'owner' },
      { appId: mealplanApp.id, userId: alice.id, role: 'cook' },
    ],
  });
  mintedKeys.push({ appName: mealplanApp.name, rawKey: mealplanAppKey.rawKey });
  console.log(`  Created App: Mealplan @ Acme (members: bob/owner, alice/cook)`);

  // ── App: Juno in Mentor Co (Mike's first install) ─────────────────────
  await db.agentOrgGrant.create({
    data: {
      orgId: mentorOrg.id,
      agentId: junoAgent.id,
      activatedAt: new Date(),
    },
  });
  const junoMentorAppKey = mintAppKey();
  const junoMentorApp = await db.app.create({
    data: {
      id: generateId(),
      organizationId: mentorOrg.id,
      urn: `${mentorOrg.urn}:juno`,
      name: 'Juno @ Mentor Co',
      agentId: junoAgent.id,
      surfaces: ['chat'],
      appType: 'CHATBOT',
    },
  });
  await db.appKey.create({
    data: {
      id: generateId(),
      appId: junoMentorApp.id,
      keyHash: junoMentorAppKey.keyHash,
      keyPreview: junoMentorAppKey.keyPreview,
      label: 'Juno @ Mentor Co — initial key',
    },
  });
  await db.appMember.createMany({
    data: [
      { appId: junoMentorApp.id, userId: mike.id, role: 'principal' },
      { appId: junoMentorApp.id, userId: dana.id, role: 'guide' },
    ],
  });
  mintedKeys.push({ appName: junoMentorApp.name, rawKey: junoMentorAppKey.rawKey });
  console.log(`  Created App: Juno @ Mentor Co (members: mike/principal, dana/guide)`);

  // ── App: Juno in Client Co (Mike's second install — multi-install) ────
  // The whole point of 008's privacy invariant: Mike's data here is fully
  // isolated from Mike's data at Mentor Co even though both Apps deploy
  // the same Juno agent.
  await db.agentOrgGrant.create({
    data: {
      orgId: clientOrg.id,
      agentId: junoAgent.id,
      activatedAt: new Date(),
    },
  });
  const junoClientAppKey = mintAppKey();
  const junoClientApp = await db.app.create({
    data: {
      id: generateId(),
      organizationId: clientOrg.id,
      urn: `${clientOrg.urn}:juno`,
      name: 'Juno @ Client Co',
      agentId: junoAgent.id,
      surfaces: ['chat'],
      appType: 'CHATBOT',
    },
  });
  await db.appKey.create({
    data: {
      id: generateId(),
      appId: junoClientApp.id,
      keyHash: junoClientAppKey.keyHash,
      keyPreview: junoClientAppKey.keyPreview,
      label: 'Juno @ Client Co — initial key',
    },
  });
  await db.appMember.create({
    data: { appId: junoClientApp.id, userId: mike.id, role: 'principal' },
  });
  mintedKeys.push({ appName: junoClientApp.name, rawKey: junoClientAppKey.rawKey });
  console.log(`  Created App: Juno @ Client Co (members: mike/principal)`);

  // ── AgentSubscription for Mike↔Juno (personal-memory grant) ────────────
  await db.agentSubscription.create({
    data: {
      userId: mike.id,
      agentId: junoAgent.id,
      activatedAt: new Date(),
    },
  });
  console.log(`  Created AgentSubscription: mike → juno (personal-memory grant)`);

  // ── Personal-class memories for Mike (one per Juno install) ────────────
  // The (app_id, user_id) pivot is what gives multi-install isolation.
  // These are seeded so a portal session can immediately demonstrate that
  // the two installs of the same Juno agent have separate user data.
  await db.memory.create({
    data: {
      id: generateId(),
      organizationId: mentorOrg.id,
      urn: `${junoMentorApp.urn}:mike-personal`,
      name: 'Mike\'s personal memory @ Mentor Co',
      class: 'personal',
      visibility: 'PERSONAL',
      userId: mike.id,
      userMemoryOfAgentId: junoAgent.id,
      appId: junoMentorApp.id,
    },
  });
  await db.memory.create({
    data: {
      id: generateId(),
      organizationId: clientOrg.id,
      urn: `${junoClientApp.urn}:mike-personal`,
      name: 'Mike\'s personal memory @ Client Co',
      class: 'personal',
      visibility: 'PERSONAL',
      userId: mike.id,
      userMemoryOfAgentId: junoAgent.id,
      appId: junoClientApp.id,
    },
  });
  console.log(`  Created 2 personal memories for Mike (one per Juno install)`);

  // ── Final summary ──────────────────────────────────────────────────────
  console.log(`\nSeed complete!\n`);
  console.log(`AppKeys (paste into hadron-portal or .hadron/config.json):`);
  for (const k of mintedKeys) {
    console.log(`  ${k.appName}`);
    console.log(`    ${k.rawKey}`);
  }
  console.log('');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
