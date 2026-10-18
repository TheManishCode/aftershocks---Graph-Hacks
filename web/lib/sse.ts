/**
 * Server-sent events over a POST (EventSource only does GET): the agent's steps arrive as `event: <kind>` frames.
 * Pure parsing lives in `parseFrames` so it can be checked without a network.
 */

export interface Frame {
  event: string;
  data: string;
  id?: string;
}

/** Split a buffer into complete frames; returns the frames and the unfinished tail to keep for the next chunk. */
export function parseFrames(buf: string): [Frame[], string] {
  const parts = buf.replace(/\r\n/g, "\n").split("\n\n");
  const tail = parts.pop() ?? "";
  const frames: Frame[] = [];
  for (const part of parts) {
    const f: Frame = { event: "message", data: "" };
    const data: string[] = [];
    for (const line of part.split("\n")) {
      if (!line || line.startsWith(":")) continue; // comment / keepalive
      const i = line.indexOf(":");
      const field = i < 0 ? line : line.slice(0, i);
      const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
      if (field === "event") f.event = value;
      else if (field === "data") data.push(value);
      else if (field === "id") f.id = value;
    }
    if (data.length) {
      f.data = data.join("\n");
      frames.push(f);
    }
  }
  return [frames, tail];
}

export async function postStream(
  url: string,
  body: unknown,
  onFrame: (event: string, data: unknown) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      if (typeof j?.detail === "string") msg = j.detail;
    } catch {
      /* not json */
    }
    throw new Error(msg);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const [frames, tail] = parseFrames(buf + value);
    buf = tail;
    for (const f of frames) {
      let data: unknown = f.data;
      try {
        data = JSON.parse(f.data);
      } catch {
        /* keep text */
      }
      onFrame(f.event, data);
    }
  }
}
