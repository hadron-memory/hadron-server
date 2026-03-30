import {Prisma, PrismaClient} from '../src/generated/prisma/index.js';
import bcrypt from 'bcrypt';
import { randomBytes, createCipheriv } from 'crypto';
import { generateId } from '../src/lib/id.js';
import MemoryCreateArgs = Prisma.MemoryCreateArgs;

function encryptToken(plaintext: string): string {
  const key = process.env.HADRON_ENCRYPTION_KEY;
  if (!key) throw new Error('HADRON_ENCRYPTION_KEY env var is required for seeding');
  const keyBuf = Buffer.from(key, 'hex');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBuf, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

const db = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // 1. HadronServer
  const server = await db.hadronServer.create({
    data: {
      id: generateId(),
      url: 'https://hc.hadrongraph.io',
      logLevel: 'ERROR',
    },
  });
  console.log(`  Created HadronServer: ${server.url}`);

  // 2. Organization: Hadron Memory
  const hadronOrg = await db.organization.create({
    data: {
      id: generateId(),
      name: 'Hadron Memory',
      urn: 'hadronmemory-com',
      githubAppId: '3125298',
      githubInstallationId: 117769692,
      githubAppPrivateKeyEncrypted: process.env.GITHUB_APP_PRIVATE_KEY
        ? encryptToken(process.env.GITHUB_APP_PRIVATE_KEY)
        : undefined,
      isVisible: true,
    },
  });
  console.log(`  Created Organization: ${hadronOrg.name} (${hadronOrg.urn})`);

  // 2. Organization: Baragaun
  const baragaunOrg = await db.organization.create({
    data: {
      id: generateId(),
      name: 'Baragaun',
      urn: 'baragaun-com',
      githubAppId: '3125298',
      githubInstallationId: 117385803,
      githubAppPrivateKeyEncrypted: process.env.GITHUB_APP_PRIVATE_KEY
        ? encryptToken(process.env.GITHUB_APP_PRIVATE_KEY)
        : undefined,
      isVisible: true,
    },
  });
  console.log(`  Created Organization: ${baragaunOrg.name} (${baragaunOrg.urn})`);

  // 2. Organization: Baragaun
  const micromentorOrg = await db.organization.create({
    data: {
      id: generateId(),
      name: 'Micromentor',
      urn: 'micromentor-org',
      githubAppId: '3125298',
      githubInstallationId: 117769754,
      githubAppPrivateKeyEncrypted: process.env.GITHUB_APP_PRIVATE_KEY
        ? encryptToken(process.env.GITHUB_APP_PRIVATE_KEY)
        : undefined,
      isVisible: true,
    },
  });
  console.log(`  Created Organization: ${micromentorOrg.name} (${micromentorOrg.urn})`);

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
      githubId: 123397631,
      githubUsername: 'RaghvindYadav',
      identityProvider: 'GITHUB',
      name: 'Raghvind Yadav',
      email: 'vadayraghvind@baragaun.com',
      roles: ['ADMIN'],
      maxReferrals: 100,
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

  const noel = await db.user.create({
    data: {
      githubId: 107146551,
      githubUsername: 'LASITW',
      identityProvider: 'GITHUB',
      name: 'Noel Saji',
      email: 'saji.noel@gmail.com',
      roles: ['ADMIN'],
    },
  });
  console.log(`  Created User: ${noel.name} (${noel.email})`);

  // 4. OrgMembers
  for (const { user, role } of [
    { user: holger, role: 'OWNER' as const },
    { user: raghvind, role: 'OWNER' as const },
    { user: rupali, role: 'OWNER' as const },
    { user: noel, role: 'OWNER' as const },
  ]) {
    await db.orgMember.create({
      data: {
        id: generateId(),
        organizationId: baragaunOrg.id,
        userId: user.id,
        role,
        canInvite: true,
      },
    });
    console.log(`  Created OrgMember: ${user.name} → ${baragaunOrg.name} (${role})`);
  }

  for (const { user, role } of [
    { user: holger, role: 'OWNER' as const },
    { user: raghvind, role: 'OWNER' as const },
    { user: rupali, role: 'OWNER' as const },
    { user: noel, role: 'OWNER' as const },
  ]) {
    await db.orgMember.create({
      data: {
        id: generateId(),
        organizationId: hadronOrg.id,
        userId: user.id,
        role,
        canInvite: true,
      },
    });
    console.log(`  Created OrgMember: ${user.name} → ${hadronOrg.name} (${role})`);
  }

  for (const { user, role } of [
    { user: holger, role: 'OWNER' as const },
    { user: raghvind, role: 'OWNER' as const },
    { user: rupali, role: 'OWNER' as const },
    { user: noel, role: 'OWNER' as const },
  ]) {
    await db.orgMember.create({
      data: {
        id: generateId(),
        organizationId: micromentorOrg.id,
        userId: user.id,
        role,
        canInvite: true,
      },
    });
    console.log(`  Created OrgMember: ${user.name} → ${micromentorOrg.name} (${role})`);
  }

  // 5. Memory: hadron-core
  const seedMemories: { id: string, name: string, props: MemoryCreateArgs }[] = [
    {
      id: '',
      name: '',
      props: {
        data: {
          id: generateId(),
          organizationId: hadronOrg.id,
          urn: `${hadronOrg.urn}:core`,
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
          id: generateId(),
          organizationId: baragaunOrg.id,
          urn: `${baragaunOrg.urn}:baragaun-com`,
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
          id: generateId(),
          organizationId: baragaunOrg.id,
          urn: `${baragaunOrg.urn}:bg-code-gen`,
          name: 'baragaun-com.bg-code-gen',
          source: 'https://github.com/baragaun/hadronmem-bg-code-gen',
          readBranch: 'main',
          writeBranch: 'hadron-updates',
          visibility: 'PUBLIC',
          syncStatus: 'PENDING',
        },
      },
    },
    {
      id: '',
      name: '',
      props: {
        data: {
          id: generateId(),
          organizationId: baragaunOrg.id,
          urn: `${baragaunOrg.urn}:bg-node-client`,
          name: 'baragaun-com.bg-node-client',
          source: 'https://github.com/baragaun/hadronmem-bg-node-client',
          readBranch: 'main',
          writeBranch: 'hadron-updates',
          visibility: 'PUBLIC',
          syncStatus: 'PENDING',
        },
      },
    },
    {
      id: '',
      name: '',
      props: {
        data: {
          id: generateId(),
          organizationId: micromentorOrg.id,
          urn: `${micromentorOrg.urn}:mmdata`,
          name: 'micromentor-org.mmdata',
          source: 'https://github.com/micromentor-team/hadronmem-mmdata',
          readBranch: 'main',
          writeBranch: 'hadron-updates',
          visibility: 'PRIVATE',
          syncStatus: 'PENDING',
        },
      },
    },
    {
      id: '',
      name: '',
      props: {
        data: {
          id: generateId(),
          organizationId: micromentorOrg.id,
          urn: `${micromentorOrg.urn}:mm-app`,
          name: 'micromentor-org.mm-app',
          source: 'https://github.com/micromentor-team/hadronmem-mm-app',
          readBranch: 'main',
          writeBranch: 'hadron-updates',
          visibility: 'PRIVATE',
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

  // 6. Agent: Engineering
  const agent = await db.agent.create({
    data: {
      id: generateId(),
      organizationId: baragaunOrg.id,
      urn: `${baragaunOrg.urn}:engineering`,
      name: 'Engineering',
      description: 'All Baragaun engineering memories',
    },
  });
  console.log(`  Created Agent: ${agent.name}`);

  // 7. AgentMemoryItem: Engineering → memories
  for (const mem of seedMemories) {
    await db.agentMemoryItem.create({
      data: {
        id: generateId(),
        agentId: agent.id,
        memoryId: mem.id,
      },
    });
    console.log(`  Linked ${mem.name} → ${agent.name}`);
  }

  // 8. Stations + subscriptions (one per user)
  const stationDefs = [
    { user: holger, name: 'biene-mbp4' },
    { user: raghvind, name: 'raghvind-ws' },
    { user: rupali, name: 'rupali-ws' },
    { user: noel, name: 'noel-ws' },
  ];

  for (const def of stationDefs) {
    const rawKey = randomBytes(32).toString('hex');
    const keyHash = await bcrypt.hash(rawKey, 12);
    const stationUrn = `${baragaunOrg.urn}:${def.name}`;
    const station = await db.station.create({
      data: {
        id: generateId(),
        userId: def.user.id,
        organizationId: baragaunOrg.id,
        stationType: 'WORKSTATION',
        urn: stationUrn,
        name: def.name,
        keyHash,
        role: 'ADMIN',
        apiKeyShown: false,
        agentTools: ['CLAUDE_CODE', 'CURSOR'],
      },
    });
    console.log(`  Created Station: ${station.name} (user: ${def.user.name})`);
    console.log(`    API Key: ${rawKey}`);

    await db.stationAgentSubscription.create({
      data: {
        id: generateId(),
        stationId: station.id,
        agentId: agent.id,
        subscriptionType: 'READ_WRITE',
        trainingMode: true,
      },
    });
    console.log(`    Subscribed ${station.name} → ${agent.name} (READ_WRITE, training)`);
  }

  console.log('\nSeed complete!');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
