import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { AppLayout } from '@/components/layout';
import { HomeDashboard } from '@/components/home/home-dashboard';

export default async function Home() {
  const session = await auth();

  if (!session?.user) {
    redirect('/auth/signin');
  }

  return (
    <AppLayout>
      <HomeDashboard />
    </AppLayout>
  );
}
