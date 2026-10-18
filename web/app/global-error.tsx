"use client";

/** The root layout itself failed, so nothing else (fonts, shell, styles) can be assumed: plain markup, inline styles. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100vh", background: "#050505", color: "#dedbc8", fontFamily: "system-ui, sans-serif" }}>
        <main style={{ maxWidth: 560, margin: "0 auto", padding: "96px 16px" }}>
          <h1 style={{ fontSize: 22, fontWeight: 500, color: "#f6f3e4" }}>Aftershock failed to load</h1>
          <p style={{ fontSize: 14, color: "#9d998c" }}>{error.message || "An unexpected error stopped the app from rendering."}</p>
          <button
            type="button"
            onClick={reset}
            style={{ marginTop: 16, minHeight: 44, padding: "0 20px", borderRadius: 6, border: 0, background: "#e6c77d", color: "#050505", fontSize: 14, cursor: "pointer" }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
