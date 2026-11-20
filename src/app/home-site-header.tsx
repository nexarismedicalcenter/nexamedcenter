"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import ServiceNavigation from "@/components/service-navigation";

export default function HomeSiteHeader() {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        menuButtonRef.current?.focus();
      }
    };

    document.body.classList.add("nexa-menu-lock");
    window.addEventListener("keydown", closeOnEscape);
    closeButtonRef.current?.focus();

    return () => {
      document.body.classList.remove("nexa-menu-lock");
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  const closeMenu = () => {
    setMenuOpen(false);
    menuButtonRef.current?.focus();
  };

  return (
    <header className={`nexa-home-header${menuOpen ? " is-menu-open" : ""}`}>
      <div className="nexa-home-header__inner">
        <Link className="nexa-home__brand" href="/" aria-label="NEXA Medical Center, accueil">
          <span className="nexa-home__mark" aria-hidden="true">N</span>
          <span className="nexa-home__identity">
            <span className="nexa-home__name">NEXA</span>
            <span className="nexa-home__label">Medical Center</span>
          </span>
        </Link>

        <ServiceNavigation className="nexa-home__nav" />
        <button
          ref={menuButtonRef}
          className="nexa-home__menu-button"
          type="button"
          aria-label={menuOpen ? "Fermer la navigation" : "Ouvrir la navigation"}
          aria-expanded={menuOpen}
          aria-controls="nexa-home-mobile-navigation"
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span aria-hidden="true">☰</span>
        </button>

        <Link className="nexa-home__account" href="/connexion?next=%2Fespace" aria-label="Mon espace patient">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.8" />
            <path d="M4.8 20c.4-3.5 3.2-5.5 7.2-5.5s6.8 2 7.2 5.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </Link>

        <button
          className="nexa-home__mobile-backdrop"
          type="button"
          aria-label="Fermer le menu"
          aria-hidden={!menuOpen}
          tabIndex={menuOpen ? 0 : -1}
          onClick={closeMenu}
        />
        <nav
          id="nexa-home-mobile-navigation"
          className="nexa-home__mobile-navigation"
          aria-label="Navigation principale NEXA"
          aria-hidden={!menuOpen}
        >
          <button
            ref={closeButtonRef}
            className="nexa-home__menu-close"
            type="button"
            aria-label="Fermer le menu"
            tabIndex={menuOpen ? 0 : -1}
            onClick={closeMenu}
          >
            ×
          </button>
          <ServiceNavigation className="nexa-home__menu-nav" />
          <Link className="nexa-home__menu-account" href="/connexion?next=%2Fespace" tabIndex={menuOpen ? 0 : -1} onClick={() => setMenuOpen(false)}>
            Mon espace patient
          </Link>
          <Link className="nexa-home__menu-account" href="/inscription" tabIndex={menuOpen ? 0 : -1} onClick={() => setMenuOpen(false)}>
            Créer un compte patient
          </Link>
        </nav>
      </div>
    </header>
  );
}
