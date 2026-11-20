import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import CurrentYear from "@/components/current-year";
import HomeSiteHeader from "./home-site-header";
import "./nexa-home.css";
import "./nexa-home-shell.css";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="10.8" cy="10.8" r="6.8" stroke="currentColor" strokeWidth="2.2" />
      <path d="m16 16 4.5 4.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

function LocationIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M19 10.2c0 5-7 11-7 11s-7-6-7-11a7 7 0 1 1 14 0Z" stroke="currentColor" strokeWidth="2" />
      <circle cx="12" cy="10" r="2.2" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg className="sc-home-arrow-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 12h15m-6-6 6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function Home() {
  return (
    <div className="nexa-home">
      <HomeSiteHeader />

      <main className="health-shell">
        <section className="sc-home-hero" aria-labelledby="nexa-home-title">
          <div className="sc-home-wrap sc-home-hero__inner">
            <div className="sc-home-hero__copy">
              <span className="sc-home-eyebrow">NEXA MEDICAL CENTER</span>
              <h1 id="nexa-home-title">Vivez en meilleure santé</h1>
              <p>Les soins essentiels, les professionnels et les services NEXA réunis au même endroit. Choisissez le pôle qui vous accompagne.</p>
              <div className="sc-home-hero__search" aria-label="Accès rapide aux soins NEXA">
                <Link className="sc-home-hero__search-choice" href="/medecins">
                  <span className="nexa-home__search-icon"><SearchIcon /></span>
                  <span>Médecin, spécialité, consultation</span>
                </Link>
                <Link className="sc-home-hero__search-choice" href="/pharmacie">
                  <span className="nexa-home__search-icon"><LocationIcon /></span>
                  <span>Pharmacie et médicaments</span>
                </Link>
                <Link className="sc-home-hero__search-submit" href="/medecins">
                  <span>Rechercher</span><ArrowIcon />
                </Link>
              </div>
            </div>
            <div className="sc-home-hero__visual">
              <div className="sc-home-hero__image-frame">
                <Image
                  src="/assets/health/heroes/health-home-hero-black-cutout-v4.webp"
                  alt="Une médecin NEXA accueille les patients"
                  width={1667}
                  height={1000}
                  priority
                  sizes="(max-width: 700px) 100vw, 31vw"
                />
              </div>
            </div>
          </div>
        </section>

        <section className="sc-home-promo-wrap" aria-label="Accès à votre espace patient NEXA">
          <article className="sc-home-promo">
            <div className="sc-home-promo__copy">
              <span className="sc-home-kicker">NEXA MEDICAL CENTER</span>
              <h2>Votre santé, plus simple au quotidien</h2>
              <Link href="/inscription">Créer mon espace <ArrowIcon /></Link>
            </div>
            <div className="sc-home-promo__image">
              <Image src="/assets/health/heroes/template-home-promo.webp" alt="Deux personnes échangent dans un cadre de soin" width={560} height={420} loading="lazy" />
            </div>
          </article>
        </section>

        <section className="sc-home-services" aria-label="Les pôles Nexa Medical Center">
          <div className="sc-home-wrap sc-home-services__heading">
            <h2>Votre compagnon de santé au quotidien</h2>
          </div>
          <div className="sc-home-wrap sc-home-services__grid">
            <article className="sc-home-service">
              <Image className="sc-home-service__icon" src="/assets/health/home-icons/template-benefit-calendar.svg" alt="" aria-hidden="true" width={78} height={78} />
              <strong>Accédez aux soins plus facilement</strong>
              <small>Rendez-vous, téléconsultations et demandes de visite à domicile.</small>
              <Link href="/care">Découvrir Nexa - Care <ArrowIcon /></Link>
            </article>
            <article className="sc-home-service">
              <Image className="sc-home-service__icon" src="/assets/health/home-icons/template-benefit-messaging.svg" alt="" aria-hidden="true" width={78} height={78} />
              <strong>Trouvez vos médicaments facilement</strong>
              <small>Parcourez les pharmacies partenaires et leurs produits disponibles.</small>
              <Link href="/pharmacie">Découvrir Nexa - Pharma <ArrowIcon /></Link>
            </article>
            <article className="sc-home-service">
              <Image className="sc-home-service__icon" src="/assets/health/home-icons/template-benefit-heart.svg" alt="" aria-hidden="true" width={78} height={78} />
              <strong>Gérez vos examens</strong>
              <small>Accédez aux laboratoires et aux centres d’imagerie médicale.</small>
              <span className="sc-home-service__links"><Link href="/laboratoires">Nexa - Lab</Link><Link href="/imagerie">Nexa - Imaging</Link></span>
            </article>
          </div>
        </section>

        <section className="sc-home-stats sc-home-wrap" aria-label="NEXA Medical Center en chiffres">
          <h2>NEXA Medical Center</h2>
          <div className="sc-home-stat"><strong>4</strong><span>pôles de santé réunis</span></div>
          <div className="sc-home-stat"><strong>NMC</strong><span>numéro patient attribué automatiquement</span></div>
          <div className="sc-home-stat"><strong>En ligne</strong><span>accédez aux services depuis vos appareils</span></div>
        </section>

        <div className="sc-home-main">
          <section className="sc-home-benefits sc-home-wrap" aria-labelledby="nexa-home-benefits-title">
            <div className="sc-home-benefits__visual">
              <Image src="/assets/health/heroes/template-home-privacy.webp" alt="Une personne utilise son espace de santé depuis un ordinateur" width={900} height={650} loading="lazy" />
            </div>
            <div className="sc-home-benefits__copy">
              <span className="sc-home-kicker">VOTRE ESPACE NEXA</span>
              <h2 id="nexa-home-benefits-title">Votre santé. Vos informations.</h2>
              <p>Retrouvez vos services et vos démarches NEXA depuis votre espace personnel.</p>
              <Link className="sc-home-text-link" href="/connexion?next=%2Fespace">Découvrir mon espace patient <ArrowIcon /></Link>
            </div>
          </section>

          <section className="sc-home-app sc-home-wrap" aria-labelledby="nexa-home-app-title">
            <div className="sc-home-app__copy">
              <h2 id="nexa-home-app-title">Vos services de santé, à portée de main</h2>
              <p>Accédez à votre espace NEXA depuis votre téléphone ou votre ordinateur.</p>
              <Link className="sc-home-button sc-home-button--primary" href="/connexion?next=%2Fespace">Accéder à mon espace <ArrowIcon /></Link>
            </div>
            <div className="sc-home-app__visual">
              <Image src="/assets/health/heroes/smartcut-health-app.webp" alt="Une médecin accompagne une patiente dans l’utilisation d’un service de santé sur téléphone" width={1200} height={800} loading="lazy" />
            </div>
          </section>

          <section className="sc-home-pro" aria-labelledby="nexa-home-pro-title">
            <div className="sc-home-pro__inner">
              <div className="sc-home-pro__visual">
                <Image src="/assets/health/heroes/template-home-professionals.webp" alt="Une médecin accompagne une patiente lors d’une consultation" width={672} height={640} loading="lazy" />
              </div>
              <div className="sc-home-pro__copy">
                <h2 id="nexa-home-pro-title">Rejoignez le réseau NEXA</h2>
                <p>Découvrez l’espace réservé aux professionnels de santé.</p>
                <Link className="sc-home-button sc-home-button--primary" href="/professionnels/candidature">En savoir plus <ArrowIcon /></Link>
              </div>
            </div>
          </section>
        </div>
      </main>

      <footer className="nexa-home__footer">
        <div className="nexa-home__footer-inner">
          <div className="nexa-home__footer-intro">
            <Link className="nexa-home__footer-brand" href="/" aria-label="NEXA Medical Center, accueil">
              <span className="nexa-home__mark" aria-hidden="true">N</span>
              <span>NEXA <small>MEDICAL CENTER</small></span>
            </Link>
            <p>Des soins et des services de santé pensés autour de vous, au sein d’une entreprise indépendante.</p>
          </div>
          <div className="nexa-home__footer-column">
            <h2>Nos pôles</h2>
            <nav aria-label="Pôles NEXA">
              <Link href="/care">Nexa - Care</Link>
              <Link href="/pharmacie">Nexa - Pharma</Link>
              <Link href="/laboratoires">Nexa - Lab</Link>
              <Link href="/imagerie">Nexa - Imaging</Link>
            </nav>
          </div>
          <div className="nexa-home__footer-column">
            <h2>Informations</h2>
            <nav aria-label="Informations NEXA">
              <Link href="/conditions">Conditions d’utilisation</Link>
              <Link href="/confidentialite">Confidentialité</Link>
              <Link href="/professionnels/candidature">Rejoindre le réseau</Link>
              <Link href="/connexion?next=%2Fespace">Mon espace patient</Link>
            </nav>
          </div>
        </div>
        <p className="nexa-home__copyright">© <CurrentYear /> NEXA Medical Center</p>
      </footer>
    </div>
  );
}
