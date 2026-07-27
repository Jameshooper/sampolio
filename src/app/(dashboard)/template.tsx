import { PageEntrance } from '@/components/ui/page-entrance';

/**
 * Re-mounts on every navigation within the dashboard group, giving each page
 * a calm 250ms fade-rise entrance (opacity + 8px translateY, compositor-only;
 * content is interactive from frame 1). PageEntrance restarts the animation
 * on pathname change — required because Next pre-mounts prefetched routes
 * hidden, which would otherwise spend the animation before reveal. Kept out
 * of the root layout so auth/dev-login don't animate; Home (`/`) sits outside
 * this group and wraps itself in PageEntrance.
 */
export default function Template({ children }: { children: React.ReactNode }) {
    return <PageEntrance>{children}</PageEntrance>;
}
