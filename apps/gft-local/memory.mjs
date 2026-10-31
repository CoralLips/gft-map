export function memoryDocument(view) {
  return {
    id: view.id,
    name: view.name,
    scope: view.scope,
    revision: view.revision,
    updatedAt: view.updatedAt,
    document: view.doc,
    graph: {
      nodes: view.graph.nodes.map(({ content, body, ...node }) => node),
      edges: view.graph.edges,
    },
  };
}
