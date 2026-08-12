/**
 * JSONP transport. Both api.deezer.com (no CORS headers at all) and
 * itunes.apple.com (poisoned per-term ACAO cache, see verification notes)
 * are unreliable over fetch() from a static origin; both support a JSONP
 * `callback` parameter, which is the dependable path for a no-backend app.
 * Falls back to fetch when running outside a document (tests, workers).
 */

let counter = 0;

export function jsonp<T>(url: string, callbackParam = "callback"): Promise<T> {
  if (typeof document === "undefined") {
    // Test/worker environment: plain fetch.
    return fetch(url).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<T>;
    });
  }
  return new Promise<T>((resolve, reject) => {
    const name = `__mc_jsonp_${Date.now()}_${counter++}`;
    const sep = url.includes("?") ? "&" : "?";
    const script = document.createElement("script");
    const cleanup = () => {
      delete (window as unknown as Record<string, unknown>)[name];
      script.remove();
      clearTimeout(timer);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("JSONP timeout"));
    }, 15000);
    (window as unknown as Record<string, unknown>)[name] = (data: T) => {
      cleanup();
      resolve(data);
    };
    script.onerror = () => {
      cleanup();
      reject(new Error("JSONP load error"));
    };
    script.src = `${url}${sep}${callbackParam}=${name}`;
    document.head.appendChild(script);
  });
}
