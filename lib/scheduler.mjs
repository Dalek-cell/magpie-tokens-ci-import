export const DAILY_UPLOAD_TIME = "00:10";

export function dailyUploadAt(date) {
  return new Date(`${date}T${DAILY_UPLOAD_TIME}:00Z`).getTime();
}

export function startDailyScheduler(check, log = console.error) {
  let stopped = false;
  let running = false;
  let timer;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await check(new Date());
    } catch {
      await log("[magpie-tokens-ci-import] Daily schedule check failed.");
    } finally {
      running = false;
      if (!stopped) {
        const now = Date.now();
        const todayUpload = dailyUploadAt(new Date(now).toISOString().slice(0, 10));
        const nextUpload = todayUpload > now ? todayUpload : todayUpload + 86400000;
        timer = setTimeout(() => void tick(), Math.min(60000, Math.max(1, nextUpload - now)));
        timer.unref?.();
      }
    }
  };

  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
