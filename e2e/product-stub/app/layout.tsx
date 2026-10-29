import type { ReactNode } from "react";
import { config } from "../lib/config";

export const metadata = { title: config.productName };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <h1>{config.productName}</h1>
        {children}
      </body>
    </html>
  );
}
