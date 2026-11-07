/** Measurement-only: counts observations, never an approved ceiling or product optimization. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Prisma, PrismaClient, type Agent } from '../../../generated/prisma/index.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { serveAgentBootPrompt } from '../../../test/servedBootPrompt.js';
import { PARALLEL_DBS, workerDbName } from '../../../test/dbWorkers.js';
import { QueryCount3638 } from '../../../test/diagnostics/queryCount3638.js';
import { personalOrgAgentLicenseHolds, personalOrgAgentTextAllowed } from '../../../lib/auth/personalOrgAgentInstall.js';
import { getAppMemoryCandidates, participantSystemMemoryFolds } from '../../../mcp/access-control.js';
import { readableInstallMemoryIds } from '../../../lib/auth/installMemory.js';
import { isAgentInstalledAndLicensed } from '../../../lib/appAgent.js';
import { previewServedBootPrompt } from '../../../lib/bootPrompt/serve.js';
import { chatCarrierApps } from './agentChatAccess.js';
import { serveChatPrompt } from './resolvers.mutation.chat.js';
import type { Context } from './resolvers.js';
const span = vi.hoisted(() => ({ active: false }));
vi.mock('../../../integrations/db/client.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../integrations/db/client.js')>();
    const { guardFixtureClient3638 } = await import('../../../test/diagnostics/fixtureGuard3638.js');
    return { ...actual, db: guardFixtureClient3638(actual.db, () => span.active) };
});
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
describe.skipIf(process.env.HADRON_3638_RUN !== '1')('opt-in licence query diagnostic', () => {
    const logged = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL, log: [{ emit: 'event', level: 'query' }] });
    const counter = new QueryCount3638();
    let barrierSeen = false;
    let artifactOwned = false;
    let postgresVersion = 'unrecorded';
    logged.$on('query', event => {
        if (event.query.includes('licence-count-3638-barrier'))
            barrierSeen = true;
        else
            counter.record(event.query);
    });
    type Observation = {
        shape: string;
        path: string;
        repeat: string;
        sqlCount: number;
        tables: Record<string, number>;
        semantic: string;
    };
    const observations: Observation[] = [];
    const states = ['active', 'owner-revoked', 'outsider', 'userless', 'public', 'org-app'] as const;
    const counts = [1, 3] as const;
    const repeats = ['first', 'same-context-repeat'] as const;
    const pathNames = ['licence-helper', 'text-helper', 'installed-licence', 'app-memory-candidates', 'readable-install-memories', 'participant-system-folds', 'chat-carrier-apps', 'serve-chat-prompt', 'boot-serve-preview'] as const;
    const pathCount = pathNames.length;
    const rowsPerCount = states.length * pathCount * repeats.length;
    const expectedObservationCount = rowsPerCount * counts.length + 1;
    let provenance: Record<string, unknown> = {};
    function gitMetadata() {
        try {
            return {
                productionSource: execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(),
                harnessRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(),
                trackedDirty: execFileSync('git', ['diff', '--name-only', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().length > 0,
            };
        }
        catch {
            return { productionSource: 'unrecorded', harnessRevision: 'unrecorded', trackedDirty: 'unrecorded', gitLimit: 'git/source refs unavailable; hashes still identify local harness' };
        }
    }
    function writeArtifact(status: string) {
        if (artifactOwned && process.env.HADRON_3638_ARTIFACT)
            writeFileSync(process.env.HADRON_3638_ARTIFACT, JSON.stringify({
                ...provenance, postgresVersion, prismaVersion: Prisma.prismaVersion.client, nodeVersion: process.version,
                complete: observations.length === expectedObservationCount, status, expectedObservationCount,
                matrix: { states, counts, repeats, paths: pathNames },
                fixedWorkload: 'synthetic physical installs, one App; matrix fields define the full roster',
                definitions: { sqlCount: 'dedicated Prisma query events inside span; setup and named drain barrier excluded; includes transaction statements', tables: 'statements mentioning a quoted table after simple FROM/JOIN/UPDATE/INTO; limited regex, not SQL parser; overlapping categories not additive', repeat: 'same explicit Context/client, not HTTP request or pooled-session/cache benchmark' }, observations,
            }, null, 2));
    }
    beforeAll(async () => {
        expect(PARALLEL_DBS, 'diagnostic requires run-owned parallel clone').toBe(true);
        const expected = workerDbName(process.env.VITEST_POOL_ID ?? '1');
        expect(new URL(process.env.DATABASE_URL!).pathname).toBe(`/${expected}`);
        for (const client of [db, logged]) {
            const rows = await client.$queryRaw<{
                name: string;
            }[]> `SELECT current_database() AS name`;
            expect(rows[0]?.name).toBe(expected);
        }
        const support = ['../../../test/diagnostics/queryCount3638.ts', '../../../test/diagnostics/fixtureGuard3638.ts', '../../../test/servedBootPrompt.ts', '../../../test/helpers.ts', '../../../test/dbWorkers.ts'];
        const hash = createHash('sha256').update(readFileSync(new URL(import.meta.url)));
        for (const file of support)
            hash.update(readFileSync(new URL(file, import.meta.url)));
        provenance = { ...gitMetadata(), harnessSha256: hash.digest('hex'), harnessHashScope: ['campaign', ...support] };
        if (process.env.HADRON_3638_ARTIFACT) {
            writeFileSync(process.env.HADRON_3638_ARTIFACT, JSON.stringify({ complete: false, status: 'environment verified; campaign not complete' }), { flag: 'wx' });
            artifactOwned = true;
        }
        postgresVersion = (await logged.$queryRaw<{
            version: string;
        }[]> `SELECT version() AS version`)[0].version;
        span.active = true;
        try {
            expect(() => db.agent.findMany()).toThrow('unmeasured fixture/global client');
            expect(() => db.$queryRaw `SELECT 1`).toThrow('unmeasured fixture/global client');
        }
        finally {
            span.active = false;
        }
        await measure('observer', 'positive-control', 'first', async () => { await logged.$queryRaw `SELECT 1`; return 'one statement'; });
    });
    afterAll(async () => {
        span.active = false;
        try {
            writeArtifact(observations.length === expectedObservationCount ? 'complete' : 'incomplete; filtered, refused or failed campaign');
        }
        finally {
            await logged.$disconnect();
        }
    });
    async function measure(shape: string, path: string, repeat: string, run: () => Promise<string>) {
        counter.begin();
        span.active = true;
        barrierSeen = false;
        let semantic: string;
        try {
            semantic = await run();
            await logged.$queryRaw `SELECT 'licence-count-3638-barrier'`;
            await vi.waitFor(() => expect(barrierSeen, 'later SQL event drains this dedicated client').toBe(true), { timeout: 10000 });
        }
        catch (error) {
            counter.end();
            throw error;
        }
        finally {
            span.active = false;
        }
        const observed = counter.end();
        observations.push({ shape, path, repeat, ...observed, semantic });
        if (path === 'positive-control')
            expect(observed.sqlCount, 'exactly SELECT 1, no setup or barrier counted').toBe(1);
    }
    it.each(counts)('records the fixed %i-Agent roster, semantic outcomes and same-context repeat', async (count) => {
        const start = observations.length;
        expect(observations.some(row => row.shape.endsWith(`/${count}-agents`)), 'test retries are not a new independent campaign').toBe(false);
        for (const state of states) {
            await cleanDb(db);
            const owner = await db.user.create({ data: { handle: 'diagnostic3638-owner', roles: ['READER'] } });
            const viewer = await db.user.create({ data: { handle: 'diagnostic3638-viewer', roles: ['READER'] } });
            const org = await db.organization.create({ data: { name: 'Publisher', urn: 'diagnostic3638.test' } });
            await db.orgMember.create({ data: { organizationId: org.id, userId: owner.id, role: 'READER', deletedAt: state === 'owner-revoked' ? new Date() : null } });
            const app = await db.app.create({ data: { name: 'Measured', urn: state === 'org-app' ? 'diagnostic3638.test:app' : '@diagnostic3638-owner:app', ...(state === 'org-app' ? { organizationId: org.id } : { ownerUserId: owner.id }) } });
            await db.appMember.createMany({ data: [{ appId: app.id, userId: owner.id, role: 'owner' }, { appId: app.id, userId: viewer.id, role: 'member' }] });
            const agents: Agent[] = [];
            for (let i = 0; i < count; i++) {
                const memory = await db.memory.create({ data: { class: 'system', organizationId: org.id, name: `Definition ${i}`, urn: `diagnostic3638.test:definition-${i}` } });
                const agent = await db.agent.create({ data: { name: `Agent ${i}`, urn: `diagnostic3638.test:agent-${i}`, organizationId: org.id, visibility: state === 'public' ? 'PUBLIC' : 'ORGANIZATION', systemMemoryId: memory.id } });
                await db.agentSubscription.create({ data: { userId: owner.id, agentId: agent.id, activatedAt: new Date('2020-01-01') } });
                await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
                await db.memory.create({ data: { class: 'system', appId: app.id, organizationId: app.organizationId, ownerUserId: app.ownerUserId, isInstallMemory: true, installOfAgentId: agent.id, name: `Install ${i}`, urn: state === 'org-app' ? `diagnostic3638.test:install-${i}` : `@diagnostic3638-owner:install-${i}` } });
                agents.push(agent);
            }
            await serveAgentBootPrompt(db, agents[0].id, 'Synthetic measured prompt.');
            const userId = state === 'userless' ? undefined : state === 'outsider' ? viewer.id : owner.id;
            const ctx: Context = { db: logged, userId, roles: userId ? ['READER'] : [], ...(state === 'userless' ? { appId: app.id } : {}) };
            const licence = state !== 'owner-revoked';
            const text = licence && state !== 'outsider' && state !== 'userless';
            const admitted = state === 'org-app' || state === 'public' || text;
            const shape = `${state}/${count}-agents`;
            const paths: Array<[
                string,
                () => Promise<string>
            ]> = [
                ['licence-helper', async () => { const values = await Promise.all(agents.map(a => personalOrgAgentLicenseHolds(logged, app, a.id))); expect(values).toEqual(agents.map(() => licence)); return `${values.filter(Boolean).length}/${count}`; }],
                ['text-helper', async () => { const values = await Promise.all(agents.map(a => personalOrgAgentTextAllowed(logged, app, a.id, userId))); expect(values).toEqual(agents.map(() => admitted)); return `${values.filter(Boolean).length}/${count}`; }],
                ['installed-licence', async () => { const values = await Promise.all(agents.map(a => isAgentInstalledAndLicensed(logged, app.id, a.id))); expect(values).toEqual(agents.map(() => licence)); return `${values.filter(Boolean).length}/${count}`; }],
                ['app-memory-candidates', async () => { const map = await getAppMemoryCandidates(logged, app.id, { allAgents: true, callerUserId: userId }); const n = agents.filter(a => map.has(a.systemMemoryId!)).length; expect(n).toBe(admitted ? count : 0); return `${n}/${count} definitions`; }],
                ['readable-install-memories', async () => { const ids = await readableInstallMemoryIds(logged, ctx); expect(ids.length).toBe(userId && admitted ? count : 0); return `${ids.length} installs`; }],
                ['participant-system-folds', async () => { const folds = await participantSystemMemoryFolds(logged, ctx); const ids = new Set(folds.flatMap(f => [...f.map.keys()])); const n = agents.filter(a => ids.has(a.systemMemoryId!)).length; expect(n).toBe(userId && admitted ? count : 0); return `${n}/${count} definitions`; }],
                ['chat-carrier-apps', async () => { const apps = await chatCarrierApps(ctx, agents[0].id); expect(apps.length).toBe(admitted ? 1 : 0); return `${apps.length} apps`; }],
                ['serve-chat-prompt', async () => {
                        let result: Awaited<ReturnType<typeof serveChatPrompt>> | undefined;
                        let refusal: unknown;
                        try {
                            result = await serveChatPrompt(logged, agents[0], app.id, null, ctx);
                        }
                        catch (error) {
                            refusal = error;
                        }
                        if (admitted) {
                            if (refusal)
                                throw refusal;
                            expect(result?.text).toBe('Synthetic measured prompt.');
                            return 'served';
                        }
                        expect(result, 'unauthorized producer must not succeed').toBeUndefined();
                        const extensions = refusal && typeof refusal === 'object' && 'extensions' in refusal ? refusal.extensions : undefined;
                        const code = extensions && typeof extensions === 'object' && 'code' in extensions ? extensions.code : refusal && typeof refusal === 'object' && 'code' in refusal ? refusal.code : undefined;
                        if (code !== 'AGENT_NOT_FOUND' && refusal)
                            throw refusal;
                        expect(code).toBe('AGENT_NOT_FOUND');
                        return 'AGENT_NOT_FOUND';
                    }],
                // Internal helper qualification only; this deliberately does NOT claim a viewer-facing preview grant.
                ['boot-serve-preview', async () => { const out = await previewServedBootPrompt(logged, { surface: 'bind', appId: app.id, agent: { id: agents[0].id, name: agents[0].name } }); expect(out.refusal).toBe(licence ? null : 'BOOT_PROMPT_INSTALL_LICENSE_INACTIVE'); return out.refusal ?? 'served'; }],
            ];
            expect(paths.map(([path]) => path)).toEqual([...pathNames]);
            for (const [path, run] of paths)
                for (const repeat of repeats)
                    await measure(shape, path, repeat, run);
        }
        expect(observations.length - start, 'complete six-state fixed roster for this Agent count').toBe(rowsPerCount);
        writeArtifact('partial progress; remaining Agent counts may not have run');
    }, 60000);
});
