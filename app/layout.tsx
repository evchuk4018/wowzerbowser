import type { Metadata, Viewport } from "next";
import "katex/dist/katex.min.css";
import "./globals.css";
import { ServiceWorkerRegistration } from "./pwa/service-worker-registration";

export const metadata: Metadata = {
  title: "Chat",
  applicationName: "Chat",
  description: "A simple, private chat workspace.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Chat",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#d4ff70",
  colorScheme: "dark",
  interactiveWidget: "resizes-content",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <ServiceWorkerRegistration />
        {children}
      </body>
    </html>
  );
}
