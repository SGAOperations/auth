// Client-safe registry of admin sections. Each admin ticket appends one entry.

export interface AdminSection {
  href: string;
  label: string;
  description: string;
}

export const ADMIN_NAV: readonly AdminSection[] = [
  { href: "/admin", label: "Dashboard", description: "Overview" },
];
