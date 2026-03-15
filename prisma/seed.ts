import { PrismaClient } from '../src/generated/prisma/index.js';
import bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';

const db = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // 1. HadronController
  const controller = await db.hadronController.create({
    data: {
      url: 'https://hc.hadrongraph.io',
      logLevel: 'ERROR',
    },
  });
  console.log(`  Created HadronController: ${controller.url}`);

  // 2. Organization: Baragaun
  const org = await db.organization.create({
    data: {
      name: 'Baragaun',
      domain: 'baragaun-com',
    },
  });
  console.log(`  Created Organization: ${org.name} (${org.domain})`);

  // 3. User: Holger
  const user = await db.user.create({
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
  console.log(`  Created User: ${user.name} (${user.githubUsername})`);

  // 4. OrganizationMember: Holger as OWNER of Baragaun
  await db.organizationMember.create({
    data: {
      organizationId: org.id,
      userId: user.id,
      role: 'OWNER',
      canInvite: true,
    },
  });
  console.log(`  Created OrganizationMember: ${user.name} → ${org.name} (OWNER)`);

  // 5. Graph: hadron-core
  const graph = await db.graph.create({
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
  console.log(`  Created Graph: ${graph.name}`);

  // 6. GraphBundle: Engineering
  const bundle = await db.graphBundle.create({
    data: {
      organizationId: org.id,
      name: 'Engineering',
      description: 'All Baragaun engineering graphs',
    },
  });
  console.log(`  Created GraphBundle: ${bundle.name}`);

  // 7. GraphBundleGraph: Engineering → hadron-core
  await db.graphBundleGraph.create({
    data: {
      bundleId: bundle.id,
      graphId: graph.id,
    },
  });
  console.log(`  Linked ${graph.name} → ${bundle.name}`);

  // 8. Client: biene-mbp4
  const rawKey = randomBytes(32).toString('hex');
  const keyHash = await bcrypt.hash(rawKey, 12);
  const client = await db.client.create({
    data: {
      userId: user.id,
      organizationId: org.id,
      clientType: 'WORKSTATION',
      label: 'biene-mbp4',
      keyHash,
      role: 'ADMIN',
      apiKeyShown: false,
    },
  });
  console.log(`  Created Client: ${client.label}`);
  console.log(`  API Key: ${rawKey}`);
  console.log(`  (Save this key — it will not be shown again)`);

  // 9. ClientBundleSubscription: biene-mbp4 → Engineering (READ_WRITE, training)
  await db.clientBundleSubscription.create({
    data: {
      clientId: client.id,
      bundleId: bundle.id,
      subscriptionType: 'READ_WRITE',
      trainingMode: true,
    },
  });
  console.log(`  Subscribed ${client.label} → ${bundle.name} (READ_WRITE, training)`);

  console.log('\nSeed complete!');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
