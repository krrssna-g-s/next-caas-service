/**
 * GET /caas-admin  ->  the content console.
 * The page holds no secrets; every action it performs needs an admin token,
 * which lives only in this tab's memory. Expose this path only on an
 * internal route, never on the public CDN hostname.
 */
import type { Metadata } from 'next';
import { connection } from 'next/server';
import { AdminApp } from './admin-app';
import './admin.css';

export const metadata: Metadata = { title: 'CaaS console' };

export default async function AdminPage() {
  // Rendered per request so proxy.ts can give every response its own CSP nonce.
  await connection();
  return <AdminApp />;
}
