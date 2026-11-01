import { ScrollViewStyleReset } from 'expo-router/html';
import { type PropsWithChildren } from 'react';

/**
 * The web document's head. This file runs only during static rendering, so it
 * may not touch the DOM or browser storage. It exists so the exported web demo
 * has a real title and description before JavaScript runs: the app is a client
 * for a self-hosted gateway, and every page should say so in a tab, a share
 * card, and a search result.
 */
export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no" />
        <meta name="theme-color" content="#0A0A0B" />
        <title>Versutus</title>
        <meta
          name="description"
          content="Versutus is a precise mobile console for a self-hosted AI agent gateway: chat, Bots, live runs, approvals, and voice."
        />
        <ScrollViewStyleReset />
      </head>
      <body>{children}</body>
    </html>
  );
}
