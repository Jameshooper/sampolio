import { redirect } from 'next/navigation';

// Trips merged into the "Trips & Budgets" page. Keep this route as a redirect
// so old links / bookmarks (and the cashflow trip-line deep link) still land.
export default function TripsRedirectPage() {
  redirect('/budgets');
}
