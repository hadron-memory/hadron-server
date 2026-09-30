import { beforeEach, describe, expect, it } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';

const server = new ApolloServer<Context>({ typeDefs, resolvers });

const query = async (source: string, slug: string) => {
  const result = await server.executeOperation(
    { query: source, variables: { slug } },
    { contextValue: { db, roles: [] } as Context },
  );
  if (result.body.kind !== 'single') throw new Error('unexpected incremental result');
  return result.body.singleResult;
};

beforeEach(async () => {
  await cleanDb(db);
});

describe('public invitation projection', () => {
  it('gives an anonymous slug holder only the invite page display fields', async () => {
    const org = await db.organization.create({ data: {
      id: generateId(), name: 'Synthetic Customer', urn: 'synthetic-customer',
      policy: { confidential: 'ORG-POLICY' },
    } });
    const sender = await db.user.create({ data: {
      githubId: 920001, githubUsername: 'synthetic-sender', name: 'Synthetic Sender',
      roles: ['ADMIN'], policy: { confidential: 'USER-POLICY' },
    } });
    const invite = await db.userInvitation.create({ data: {
      id: generateId(), slug: 'synthetic-invite', senderUserId: sender.id,
      organizationId: org.id, memberRole: 'READER', maxActivations: 3,
      name: 'Private Invitee', email: 'private@example.test',
    } });

    const result = await query(`query($slug: String!) {
      invitation(slug: $slug) {
        memberRole maxActivations activationCount expiresAt
        sender { name githubUsername }
        organization { name }
      }
    }`, invite.slug);
    expect(result.errors).toBeUndefined();
    expect(result.data?.invitation).toEqual({
      memberRole: 'READER', maxActivations: 3, activationCount: 0,
      expiresAt: null,
      sender: { name: 'Synthetic Sender', githubUsername: 'synthetic-sender' },
      organization: { name: 'Synthetic Customer' },
    });

    // The public return type has no path into full User or Organization fields.
    const forbidden = await query(`query($slug: String!) {
      invitation(slug: $slug) {
        email sender { policy roles } organization { policy agents { name } }
      }
    }`, invite.slug);
    expect(forbidden.errors?.length).toBeGreaterThan(0);
    expect(forbidden.data).toBeUndefined();

    const projected = await resolvers.Query.invitation(
      {}, { slug: invite.slug }, { db, roles: [] } as Context,
    );
    expect(Object.keys(projected ?? {}).sort()).toEqual([
      'activationCount', 'expiresAt', 'maxActivations', 'memberRole', 'organization', 'sender',
    ]);
    expect(projected?.sender).toEqual({ name: 'Synthetic Sender', githubUsername: 'synthetic-sender' });
    expect(projected?.organization).toEqual({ name: 'Synthetic Customer' });
  });

  it('keeps deleted invites hidden and supports invites without a sender or org', async () => {
    const invite = await db.userInvitation.create({ data: {
      id: generateId(), slug: 'synthetic-system-invite', memberRole: 'READER',
    } });
    const source = `query($slug: String!) {
      invitation(slug: $slug) {
        memberRole activationCount sender { name } organization { name }
      }
    }`;
    const shown = await query(source, invite.slug);
    expect(shown.errors).toBeUndefined();
    expect(shown.data?.invitation).toEqual({
      memberRole: 'READER', activationCount: 0, sender: null, organization: null,
    });
    await db.userInvitation.update({ where: { id: invite.id }, data: { deletedAt: new Date() } });
    const hidden = await query(source, invite.slug);
    expect(hidden.errors).toBeUndefined();
    expect(hidden.data?.invitation).toBeNull();
  });
});
