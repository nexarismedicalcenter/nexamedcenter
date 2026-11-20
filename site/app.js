const header = document.querySelector(".nexa-site-header");
const toggle = header?.querySelector(".nexa-site-header__toggle");
const nav = header?.querySelector("#nexa-navigation");

if (header && toggle && nav) {
  let closeButton = nav.querySelector(".nexa-site-header__menu-close");
  if (!closeButton) {
    closeButton = document.createElement("button");
    closeButton.className = "nexa-site-header__menu-close";
    closeButton.type = "button";
    closeButton.setAttribute("aria-label", "Fermer le menu");
    closeButton.innerHTML = '<i class="fas fa-times" aria-hidden="true"></i>';
    nav.prepend(closeButton);
  }

  let backdrop = header.querySelector(".nexa-site-header__backdrop");
  if (!backdrop) {
    backdrop = document.createElement("div");
    backdrop.className = "nexa-site-header__backdrop";
    backdrop.setAttribute("aria-hidden", "true");
    header.append(backdrop);
  }

  const setMenuOpen = (open, restoreFocus = false) => {
    header.classList.toggle("is-menu-open", open);
    document.body.classList.toggle("nexa-menu-lock", open && window.matchMedia("(max-width: 1100px)").matches);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Fermer le menu" : "Ouvrir le menu");
    const icon = toggle.querySelector("i");
    icon?.classList.toggle("fa-bars", !open);
    icon?.classList.toggle("fa-times", open);
    if (open) closeButton.focus();
    else if (restoreFocus) toggle.focus();
  };

  toggle.addEventListener("click", () => {
    setMenuOpen(!header.classList.contains("is-menu-open"));
  });
  closeButton.addEventListener("click", () => setMenuOpen(false, true));
  backdrop.addEventListener("click", () => setMenuOpen(false, true));
  nav.querySelectorAll("a").forEach((link) => link.addEventListener("click", () => setMenuOpen(false)));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && header.classList.contains("is-menu-open")) setMenuOpen(false, true);
  });
  window.matchMedia("(min-width: 1101px)").addEventListener("change", (event) => {
    if (event.matches) setMenuOpen(false);
  });
}

function animateHomeSections() {
  const root = document.querySelector(".nexa-home-redesign");
  const gsap = window.gsap;
  const ScrollTrigger = window.ScrollTrigger;
  if (!root || !gsap || !ScrollTrigger || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

  gsap.registerPlugin(ScrollTrigger);
  const heroItems = root.querySelectorAll(".nexa-home-hero [data-home-reveal]");
  if (heroItems.length) {
    gsap.fromTo(heroItems, { autoAlpha: 0, y: 28 }, {
      autoAlpha: 1,
      y: 0,
      duration: 0.8,
      stagger: 0.14,
      ease: "power3.out",
      clearProps: "all",
    });
  }
  root.querySelectorAll("[data-home-reveal]").forEach((element) => {
    if (element.closest(".nexa-home-hero")) return;
    gsap.fromTo(element, { autoAlpha: 0, y: 30 }, {
      autoAlpha: 1,
      y: 0,
      duration: 0.72,
      ease: "power2.out",
      clearProps: "all",
      scrollTrigger: { trigger: element, start: "top 88%", once: true },
    });
  });
  root.querySelectorAll(".nexa-home-service").forEach((element, index) => {
    gsap.fromTo(element, { autoAlpha: 0, y: 18 }, {
      autoAlpha: 1,
      y: 0,
      delay: index * 0.06,
      duration: 0.55,
      ease: "power2.out",
      clearProps: "all",
      scrollTrigger: { trigger: element, start: "top 94%", once: true },
    });
  });
  requestAnimationFrame(() => ScrollTrigger.refresh());
  window.addEventListener("load", () => ScrollTrigger.refresh(), { once: true });
}

animateHomeSections();

const year = document.querySelector("#current-year");
if (year) year.textContent = String(new Date().getFullYear());
