import { PLANNING_MARKUP } from '@/lib/planning-markup';
import PlanningLoader from './PlanningLoader';
import '@/app/planning.css';

/* L'interface du planning : le balisage est rendu par le serveur,
   puis le moteur de l'application prend le relais dans le navigateur. */
export default function PlanningApp() {
  return (
    <>
      <div id="agc-app" style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: PLANNING_MARKUP }} />
      <PlanningLoader />
    </>
  );
}
