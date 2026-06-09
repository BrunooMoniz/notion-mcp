type NotifyOpts = { title?: string; priority?: "low" | "default" | "high" };

let fetchImpl: typeof fetch = fetch;
export function __setFetchForTest(f: typeof fetch): void { fetchImpl = f; }

export async function notify(message: string, opts: NotifyOpts = {}): Promise<void> {
  const url = process.env.NTFY_URL;
  if (!url) return;
  try {
    await fetchImpl(url, {
      method: "POST",
      body: message,
      headers: {
        ...(opts.title ? { Title: opts.title } : {}),
        ...(opts.priority ? { Priority: opts.priority } : {}),
      },
    });
  } catch (err) {
    console.error(`[notify] falha ao enviar alerta ntfy: ${String(err)}`);
  }
}
