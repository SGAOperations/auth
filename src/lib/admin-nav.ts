// Client-safe registry of admin sections. Each admin ticket appends one entry.

export interface AdminSection {
  href: string;
  label: string;
  description: string;
}

export const ADMIN_NAV: readonly AdminSection[] = [
  { href: "/admin", label: "Dashboard", description: "Overview" },
  {
    href: "/admin/users",
    label: "Users",
    description: "Accounts, positions, sessions and activity",
  },
  {
    href: "/admin/products",
    label: "Products",
    description: "Connected tools, trusted origins and visibility",
  },
  {
    href: "/admin/positions",
    label: "Positions",
    description: "Position keys, categories and holders",
  },
  {
    href: "/admin/audit",
    label: "Audit log",
    description: "Search and export security events",
  },
];
