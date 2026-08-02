import type { Metadata } from "next";
import "./globals.css";
import { InstallHint } from "@/components/InstallHint";
import { PwaRegister } from "./pwa-register";
import { SentryInit } from "./sentry-init";

export const metadata: Metadata = {
  title: "Setu",
  description: "A voice companion for government documents.",
  icons: {
    icon: [{ url: "/favicon.png", type: "image/png" }],
    apple: [{ url: "/apple-touch-icon.png", type: "image/png" }],
  },
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Setu",
  },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover" as const,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className="h-full antialiased"
    >
      <body className="min-h-full flex flex-col">
        <SentryInit />
        <PwaRegister />
        <InstallHint />
        {children}
      </body>
    </html>
  );
}
