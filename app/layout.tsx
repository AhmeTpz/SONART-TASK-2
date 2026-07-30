import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Sonart AI-Vision Basic",
  description: "Stok, satış, kârlılık ve veri kalitesi kontrol merkezi",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="tr" className="h-full antialiased">
      <body>{children}</body>
    </html>
  );
}
