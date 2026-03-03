export const syncGraphFromGithub = async (
  loc: string, // `loc` of the top node of the graph, e.e. `hadrongraph-io`
): Promise<{ error?: string }> => {
  // todo: Implementation steps:
  //       1. Update localFs copy of remote repo
  //       2. Traverse through all nodes and upsert each into the DB
  return {}
}