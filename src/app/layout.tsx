import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

const hostGrotesk = localFont({
  src: "../fonts/HostGrotesk-VariableFont_wght.ttf",
  variable: "--font-host-grotesk",
  display: "swap",
});

const robotoMono = localFont({
  src: "../fonts/RobotoMono-VariableFont_wght.ttf",
  variable: "--font-roboto-mono",
  display: "swap",
});

const pristine = localFont({
  src: "../fonts/Pristine-Bold.otf",
  variable: "--font-pristine",
  display: "swap",
});

export const metadata: Metadata = {
  title: "World Cup Briefing Builder",
  description: "TinyFish discovery and VideoDB video briefing demo.",
  icons: { icon: "/brand/FAV_Orange.svg" },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${hostGrotesk.variable} ${robotoMono.variable} ${pristine.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
