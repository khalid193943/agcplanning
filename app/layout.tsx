import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './fonts.css';

export const metadata: Metadata = {
  title: 'Planning AGC — Emplois du temps',
  description: "Emplois du temps de l'Académie Georges Claude, El Jadida",
  icons: { icon: '/favicon.png', apple: '/apple-touch-icon.png' },
  robots: { index: false, follow: false }, // outil interne : pas de référencement
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#1b2a56',
  colorScheme: 'light',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
