"use client";

import { useEffect } from "react";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "60vh",
        gap: 12,
        padding: 40,
        textAlign: "center",
        fontFamily: "inherit",
      }}
    >
      <div aria-hidden="true" style={{ fontSize: 42 }}>📻</div>
      <h2 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>
        The signal got fuzzy…
      </h2>
      <p
        style={{ color: "#6b7280", maxWidth: 420, lineHeight: 1.5, margin: 0 }}
      >
        Something interrupted this page. Your saved draft will still be here
        when you try again.
      </p>
      <button
        type="button"
        onClick={reset}
        style={{
          marginTop: 8,
          padding: "9px 14px",
          border: "1px solid var(--line-strong)",
          background: "var(--surface)",
          color: "var(--ink)",
          cursor: "pointer",
        }}
      >
        Try again
      </button>
    </main>
  );
}
