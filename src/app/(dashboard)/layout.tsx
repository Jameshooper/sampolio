import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { AppLayout } from '@/components/layout';

// Server-side auth gate for every (dashboard) page. The edge middleware only
// checks cookie presence; this validates the actual session so page shells
// never render unauthenticated. Data stays guarded per-action regardless.
export default async function Layout({ children }: { children: React.ReactNode }) {
    const session = await auth();

    if (!session?.user) {
        redirect('/auth/signin');
    }

    return <AppLayout>{children}</AppLayout>;
}
