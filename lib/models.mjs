// Public short names never change the provider/model selected inside OpenCode.
// Reserve every qualified ID as well, so a shortened name cannot hijack an old ID.
export function modelCatalog(discovered, configured, style = 'short') {
  const ids = Object.keys(discovered);
  const qualified = new Set(ids);
  const bare = id => id.slice(id.indexOf('/') + 1);
  const counts = new Map();
  for (const id of ids) counts.set(bare(id), (counts.get(bare(id)) ?? 0) + 1);
  const visible = Object.fromEntries(ids.map(id => {
    const name = bare(id);
    const short = style === 'short' && counts.get(name) === 1 && !qualified.has(name) && !Object.hasOwn(configured, name);
    return [short ? name : id, discovered[id]];
  }));
  const models = {
    ...visible,
    ...Object.fromEntries(Object.entries(configured).map(([alias, model]) => [alias, { ...(discovered[model.model] ?? {}), ...model }])),
  };
  return { models, accepted: { ...discovered, ...models } };
}
