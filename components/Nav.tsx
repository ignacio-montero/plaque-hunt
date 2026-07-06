"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS: { href: string; label: string }[] = [
  { href: "/", label: "Map" },
  { href: "/capture", label: "Capture" },
  { href: "/tracker", label: "Tracker" },
];

export default function Nav() {
  const pathname = usePathname();

  return (
    <nav className="app-nav" aria-label="Primary">
      <span className="app-nav__brand">
        <span className="app-nav__dot" aria-hidden />
        Blue Plaque Hunter
      </span>
      <div className="app-nav__links">
        {LINKS.map((link) => {
          const active =
            link.href === "/"
              ? pathname === "/"
              : pathname.startsWith(link.href);
          return (
            <Link
              key={link.href}
              href={link.href}
              className="app-nav__link"
              aria-current={active ? "page" : undefined}
            >
              {link.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
