'use client';

import { useEffect } from 'react';

const ENGINE_VERSION = '4.0.0';

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = false;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Chargement impossible : ${src}`));
    document.body.appendChild(s);
  });
}

/* Charge, dans l'ordre, les icônes puis le moteur
   du planning (l'outil Excel n'est chargé qu'au moment d'un export).
   Tout est servi par le site lui-même : aucune dépendance externe. */
export default function PlanningLoader() {
  useEffect(() => {
    const w = window as unknown as { __agcBooting?: boolean };
    if (w.__agcBooting) return;
    w.__agcBooting = true;
    (async () => {
      await loadScript(`/vendor/lucide.min.js?v=${ENGINE_VERSION}`);
      await loadScript(`/planning/app.js?v=${ENGINE_VERSION}`);
    })().catch((e: Error) => {
      const el = document.getElementById('bootError');
      if (el) {
        el.textContent = e.message + ' — rechargez la page.';
        el.style.display = 'block';
      }
    });
  }, []);
  return null;
}
