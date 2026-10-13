export const desktop = () => window.go?.main?.Desktop;
export async function api(route, body) {
  const method = body === undefined ? "GET" : "POST";
  let status, data;
  if (desktop()) {
    const result = JSON.parse(
      await desktop().Request(
        method,
        route,
        body === undefined ? "" : JSON.stringify(body),
      ),
    );
    ({ status, data } = result);
  } else {
    const response = await fetch(route, {
      method,
      headers: {
        authorization:
          "Bearer " +
          document.querySelector('meta[name="admin-token"]').content,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    status = response.status;
    data = await response.json();
  }
  if (status >= 400)
    throw Error(data.error?.message || "请求失败（" + status + "）");
  return data;
}
export async function copy(value) {
  if (desktop()) await desktop().CopyText(value);
  else await navigator.clipboard.writeText(value);
}
// All full-config writes read the latest state at execution time. A queued key
// rename cannot undo another page's newly saved working directory.
let writes = Promise.resolve();
export function updateConfig(change) {
  const result = writes.then(async () => {
    const current = await api("/admin/state");
    const next = structuredClone(current.settings);
    await change(next);
    return api("/admin/config", next);
  });
  writes = result.catch(() => {});
  return result;
}
