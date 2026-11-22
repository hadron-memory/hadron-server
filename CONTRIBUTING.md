# Contributing to hadron-server

Thank you for taking the time to look at this project. This page says how to propose a change
and what a maintainer will look at when reviewing it.

Before anything else:

- **Security problems** are not filed as issues. Follow [SECURITY.md](SECURITY.md).
- **Conduct problems** go to the address in the [Code of Conduct](CODE_OF_CONDUCT.md).
- By contributing you agree that your contribution is released under the project's
  [AGPL-3.0 license](LICENSE).

## Start with an issue

For anything more than a typo or a small fix, please open an issue first and describe the
problem you want to solve. This saves you from building something the maintainers cannot
take, for example because it changes behavior other clients rely on. For a bug, include:

- what you did, what you expected and what happened;
- the smallest set of steps that reproduces it on a fresh local setup;
- the commit you ran (`git rev-parse HEAD`).

Please use synthetic data in everything you post. Do not paste tokens, secrets, `.env`
contents, real email addresses or other people's data.

## Set up

Follow [README.md](README.md). In particular, sync your database with `pnpm db:dev-setup`,
not a bare `pnpm db:push`, which drops the vector index.

## Make the change

1. Fork the repository and branch from the current `main`.
2. Keep the change focused on one problem. Unrelated cleanups belong in their own pull request.
3. Add or update tests. A bug fix should come with a test that fails without the fix. If
   you cannot test something, say why in the pull request.
4. Run the checks listed in the README before you push: `pnpm tsc --noEmit`, `pnpm test`
   (or the test files you touched, if the full suite is too heavy for your machine) and the
   `check:` scripts.
5. Open a pull request against `main` and fill in the template.

### Things that need extra care

These areas have contracts that other software depends on, so a small edit can break
people who are not in the room.

- **Authorization.** Who may read or write what is the most sensitive part of the server.
  A change to a read, list or lookup surface must go through the shared access helpers rather
  than a new hand-written check, and must keep working for every visibility a thing can have.
  Explain in the pull request who can see or do what before and after.
- **The GraphQL schema and MCP tools.** Clients are built against them. Do not remove or
  rename a field, argument, tool or error code in the same change that adds its replacement.
  If a schema description changes, regenerate and check it with the `check:sdl-*` scripts.
- **Database changes.** Edit `prisma/schema.prisma` and add a migration under
  `prisma/migrations/`. Prisma cannot express everything (constraints, the vector index); those
  live in the raw SQL files in `prisma/`. A migration must not destroy data without
  saying so plainly in the pull request.
- **Secrets and logs.** Never log a token, key or connection string, and never put one in an
  error message.

## Pull requests

A good pull request:

- says what problem it solves and links the issue (`Closes #123`);
- describes behavior in plain words, not just the diff;
- lists what you tested and how;
- names anything you deliberately left out.

You do not need to rebase. If `main` has moved on, merging it into your branch is fine.
Please do not force-push over a review in progress; add commits instead so reviewers can see what changed.

## Review

A maintainer will review your pull request when they can. We do not promise a response
time. Reviews look at correctness first, then at whether the change is tested, whether it
keeps the contracts above, and whether it is the smallest reasonable change. We may ask you
to split a pull request, add tests, or change the approach; we may also decline a change
that does not fit where the project is going, and we will say why.

Automated checks run on every pull request and must pass before merge. If one fails for a
reason that has nothing to do with your change, say so in a comment.

## Questions

Open a GitHub issue and describe what you are trying to do.
