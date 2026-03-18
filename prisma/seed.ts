import { PrismaClient } from '../src/generated/prisma/index.js';
import bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';

const db = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // 1. HadronServer
  const server = await db.hadronServer.create({
    data: {
      url: 'https://hc.hadrongraph.io',
      logLevel: 'ERROR',
    },
  });
  console.log(`  Created HadronServer: ${server.url}`);

  // 2. Organization: Baragaun
  const org = await db.organization.create({
    data: {
      name: 'Baragaun',
      domain: 'baragaun-com',
    },
  });
  console.log(`  Created Organization: ${org.name} (${org.domain})`);

  // 3. Users
  const holger = await db.user.create({
    data: {
      githubId: 204708, // shadowbrush GitHub ID
      githubUsername: 'shadowbrush',
      identityProvider: 'GITHUB',
      name: 'Holger',
      email: 'h@baragaun.com',
      roles: ['ADMIN'],
      maxReferrals: 100,
    },
  });
  console.log(`  Created User: ${holger.name} (${holger.githubUsername})`);

  const raghvind = await db.user.create({
    data: {
      identityProvider: 'EMAIL',
      name: 'Raghvind Ragav',
      email: 'raghvind@baragaun.com',
      roles: ['ADMIN'],
    },
  });
  console.log(`  Created User: ${raghvind.name} (${raghvind.email})`);

  const rupali = await db.user.create({
    data: {
      identityProvider: 'EMAIL',
      name: 'Rupali Raijput',
      email: 'rupali@baragaun.com',
      roles: ['ADMIN'],
    },
  });
  console.log(`  Created User: ${rupali.name} (${rupali.email})`);

  // 4. OrgMembers
  for (const { user, role } of [
    { user: holger, role: 'OWNER' as const },
    { user: raghvind, role: 'ADMIN' as const },
    { user: rupali, role: 'ADMIN' as const },
  ]) {
    await db.orgMember.create({
      data: {
        organizationId: org.id,
        userId: user.id,
        role,
        canInvite: true,
      },
    });
    console.log(`  Created OrgMember: ${user.name} → ${org.name} (${role})`);
  }

  // 5. Memory: hadron-core
  const memory = await db.memory.create({
    data: {
      organizationId: org.id,
      name: 'baragaun-com/hadron-core',
      source: 'https://github.com/baragaun/hadron-core.git',
      readBranch: 'main',
      writeBranch: 'hadron-updates',
      visibility: 'PUBLIC',
      syncStatus: 'PENDING',
    },
  });
  console.log(`  Created Memory: ${memory.name}`);

  // 6. MemoryBundle: Engineering
  const bundle = await db.memoryBundle.create({
    data: {
      organizationId: org.id,
      name: 'Engineering',
      description: 'All Baragaun engineering memories',
    },
  });
  console.log(`  Created MemoryBundle: ${bundle.name}`);

  // 7. MemoryBundleItem: Engineering → hadron-core
  await db.memoryBundleItem.create({
    data: {
      bundleId: bundle.id,
      memoryId: memory.id,
    },
  });
  console.log(`  Linked ${memory.name} → ${bundle.name}`);

  // 8. Clients + subscriptions (one per user)
  const clientDefs = [
    { user: holger, label: 'biene-mbp4' },
    { user: raghvind, label: 'raghvind-ws' },
    { user: rupali, label: 'rupali-ws' },
  ];

  for (const { user, label } of clientDefs) {
    const rawKey = randomBytes(32).toString('hex');
    const keyHash = await bcrypt.hash(rawKey, 12);
    const client = await db.client.create({
      data: {
        userId: user.id,
        organizationId: org.id,
        clientType: 'WORKSTATION',
        label,
        keyHash,
        role: 'ADMIN',
        apiKeyShown: false,
      },
    });
    console.log(`  Created Client: ${client.label} (user: ${user.name})`);
    console.log(`    API Key: ${rawKey}`);

    await db.clientBundleSubscription.create({
      data: {
        clientId: client.id,
        bundleId: bundle.id,
        subscriptionType: 'READ_WRITE',
        trainingMode: true,
      },
    });
    console.log(`    Subscribed ${client.label} → ${bundle.name} (READ_WRITE, training)`);
  }

  console.log('\nSeed complete!');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
