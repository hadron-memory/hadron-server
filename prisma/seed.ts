import {Prisma, PrismaClient} from '../src/generated/prisma/index.js';
import bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import MemoryCreateArgs = Prisma.MemoryCreateArgs;

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

  // 2. Organization: Hadron Memory
  const hadronOrg = await db.organization.create({
    data: {
      name: 'Hadron Memory',
      domain: 'hadronmemory-com',
    },
  });
  console.log(`  Created Organization: ${hadronOrg.name} (${hadronOrg.domain})`);

  // 2. Organization: Baragaun
  const baragaunOrg = await db.organization.create({
    data: {
      name: 'Baragaun',
      domain: 'baragaun-com',
    },
  });
  console.log(`  Created Organization: ${baragaunOrg.name} (${baragaunOrg.domain})`);

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
        organizationId: baragaunOrg.id,
        userId: user.id,
        role,
        canInvite: true,
      },
    });
    console.log(`  Created OrgMember: ${user.name} → ${baragaunOrg.name} (${role})`);
  }

  // 5. Memory: hadron-core
  const seedMemories: { id: string, name: string, props: MemoryCreateArgs }[] = [
    {
      id: '',
      name: '',
      props: {
        data: {
          organizationId: hadronOrg.id,
          name: 'hadronmemory-com.core',
          source: 'https://github.com/hadron-memory/hadronmem-core',
          readBranch: 'main',
          writeBranch: 'hadron-updates',
          visibility: 'PUBLIC',
          syncStatus: 'PENDING',
        },
      }
    },
    {
      id: '',
      name: '',
      props: {
        data: {
          organizationId: baragaunOrg.id,
          name: 'baragaun-com',
          source: 'https://github.com/baragaun/hadronmem-baragaun-com',
          readBranch: 'main',
          writeBranch: 'hadron-updates',
          visibility: 'PUBLIC',
          syncStatus: 'PENDING',
        },
      }
    },
    {
      id: '',
      name: '',
      props: {
        data: {
          organizationId: baragaunOrg.id,
          name: 'baragaun-com.bg-code-gen',
          source: 'https://github.com/baragaun/hadronmem-bg-code-gen',
          readBranch: 'main',
          writeBranch: 'hadron-updates',
          visibility: 'PUBLIC',
          syncStatus: 'PENDING',
        },
      },
    },
  ]

  for (const mem of seedMemories) {
    const memory = await db.memory.create(mem.props);
    mem.id = memory.id
    mem.name = memory.name
    console.log(`  Created Memory: ${memory.name}`);
  }

  // 6. MemoryBundle: Engineering
  const bundle = await db.memoryBundle.create({
    data: {
      organizationId: baragaunOrg.id,
      name: 'Engineering',
      description: 'All Baragaun engineering memories',
    },
  });
  console.log(`  Created MemoryBundle: ${bundle.name}`);

  // 7. MemoryBundleItem: Engineering → hadron-core
  for (const mem of seedMemories) {
    await db.memoryBundleItem.create({
      data: {
        bundleId: bundle.id,
        memoryId: mem.id,
      },
    });
    console.log(`  Linked ${mem.name} → ${bundle.name}`);
  }

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
        organizationId: baragaunOrg.id,
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
