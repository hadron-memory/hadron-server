import { createServer } from './server.js';

const port = Number(process.env.PORT ?? 4000);

const app = await createServer();

app.listen(port, () => {
  console.log(`hadron-server listening on http://localhost:${port}`);
  console.log(`GraphQL: http://localhost:${port}/graphql`);
});
