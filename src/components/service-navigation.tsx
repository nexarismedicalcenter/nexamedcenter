import Link from "next/link";

const services = [
  { href: "/care", label: "Nexa - Care" },
  { href: "/pharmacie", label: "Nexa - Pharma" },
  { href: "/laboratoires", label: "Nexa - Lab" },
  { href: "/imagerie", label: "Nexa - Imaging" },
];

export default function ServiceNavigation({ className }: { className: string }) {
  return (
    <nav aria-label="Navigation principale" className={className}>
      {services.map((service) => (
        <Link href={service.href} key={service.href}>{service.label}</Link>
      ))}
    </nav>
  );
}
