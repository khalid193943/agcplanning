import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/session';
import LoginForm from './LoginForm';
import './login.css';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (await verifySessionToken(token)) redirect('/');
  return <LoginForm />;
}
