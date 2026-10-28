export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.RUN_SCHEDULER === "false") return;
  const { startScheduler } = await import("./lib/scheduler");
  const { hub } = await import("./lib/realtime/hub");
  void hub().start();
  startScheduler(Number(process.env.SCHEDULER_INTERVAL_MS ?? 2000));
}
