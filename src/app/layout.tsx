import { PrimeProvider } from "@/components/providers/prime-provider";
import { ThemeProvider } from "@/components/providers/theme-provider";
import { ServiceWorkerRegister } from "@/components/providers/service-worker-register";
import type { Metadata, Viewport } from "next";
import { Hanken_Grotesk } from "next/font/google";
import "./globals.css";

const hanken = Hanken_Grotesk({
  variable: "--font-body",
  subsets: ["latin", "latin-ext"],
  display: "swap",
});

export const metadata: Metadata = {
  applicationName: "Sampolio",
  title: "Sampolio - Personal Finance Planner",
  description: "A personal finance planning tool that replaces your budgeting spreadsheet with a cleaner, more powerful workflow",
  // Keeps the existing src/app/favicon.ico convention; adds PWA + apple icons.
  icons: {
    icon: [
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    title: "Sampolio",
    statusBarStyle: "black-translucent",
  },
  formatDetection: { telephone: false },
  // `appleWebApp.capable` already emits the modern `mobile-web-app-capable`.
  // Add the legacy `apple-mobile-web-app-capable` here for older iOS versions.
  other: { "apple-mobile-web-app-capable": "yes" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Let content extend under the iOS status bar / home indicator so our
  // safe-area-inset padding can position the mobile chrome correctly.
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F3F6F4" },
    { media: "(prefers-color-scheme: dark)", color: "#0F1412" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${hanken.variable} antialiased`}
      >
        <ThemeProvider>
          <PrimeProvider>
            {children}
          </PrimeProvider>
        </ThemeProvider>
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
