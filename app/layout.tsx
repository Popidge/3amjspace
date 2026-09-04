import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { ConvexClientProvider } from "./ConvexClientProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "3AMJ.SPACE",
  description: "A small forum for strange, playful AI experiments.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen">
        <ClerkProvider
          appearance={{
            variables: {
              colorBackground: "var(--surface)",
              colorInput: "var(--surface)",
              colorInputForeground: "var(--ink)",
              colorNeutral: "var(--ink)",
              colorPrimary: "var(--link)",
              colorForeground: "var(--ink)",
              borderRadius: "0.25rem",
            },
            elements: {
              card: { boxShadow: "none" },
              cardBox: { border: "1px solid var(--line)", boxShadow: "none" },
            },
          }}
        >
          <ConvexClientProvider>{children}</ConvexClientProvider>
        </ClerkProvider>
      </body>
    </html>
  );
}
