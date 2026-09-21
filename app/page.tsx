import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/session';
import PlanningApp from '@/components/PlanningApp';

export const dynamic = 'force-dynamic';

/* Page principale : réservée à l'administrateur connecté. */
export default async function Home() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!(await verifySessionToken(token))) redirect('/login');
  return <PlanningApp />;
}
