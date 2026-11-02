// Both inference and catalog workers must stop if Magpie's Bun host exits,
// including a forced host shutdown that cannot call the plugin's dispose.
export const WatchParent = async () => {
  const parent = Number(process.env.OPENCODE_PROXY_PARENT_PID);
  if (!Number.isInteger(parent) || parent <= 0) return {};
  const timer = setInterval(() => {
    try { process.kill(parent, 0); }
    catch (error) { if (error.code === 'ESRCH') process.exit(0); }
  }, 2000);
  timer.unref?.();
  return { dispose: async () => clearInterval(timer) };
};
