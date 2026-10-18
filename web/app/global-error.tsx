"use client";

/** The root layout itself failed, so nothing else (fonts, shell, styles) can be assumed: plain markup, inline styles. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100vh", background: "#4e5050", color: "#f2f2ef", fontFamily: "Helvetica Neue, Inter, system-ui, sans-serif" }}>
        <main style={{ maxWidth: 560, margin: "0 auto", padding: "96px 16px" }}>
          <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, letterSpacing: ".14em", color: "#d0ff14" }}>ERR · LAYOUT</div>
          <h1 style={{ fontSize: 28, fontWeight: 500, margin: "12px 0" }}>Aftershock failed to load</h1>
          <p style={{ fontSize: 14, color: "#c3c6c4" }}>{error.message || "An unexpected error stopped the app from rendering."}</p>
          <button
            type="button"
            onClick={reset}
            style={{ marginTop: 16, minHeight: 44, padding: "0 20px", border: 0, background: "#d0ff14", color: "#111", fontSize: 13, letterSpacing: ".1em", cursor: "pointer" }}
          >
            TRY AGAIN
          </button>
        </main>
      </body>
    </html>
  );
}
