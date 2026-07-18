'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { clearToken } from '@/lib/api';

const tabs = [
  { href: '/chat', label: 'Chat' },
  { href: '/models', label: 'Models' },
  { href: '/history', label: 'History' },
  { href: '/config', label: 'Config' },
];

export default function Nav() {
  const path = usePathname();
  const router = useRouter();

  function logout() {
    clearToken();
    router.push('/login/');
  }

  return (
    <nav className="bg-white border-b border-gray-200 px-4 flex items-center justify-between h-12 sticky top-0 z-10">
      <div className="flex items-center gap-1">
        <span className="font-bold text-gray-800 mr-4 text-sm">SuperModel</span>
        {tabs.map(t => (
          <Link
            key={t.href}
            href={t.href}
            className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
              path.startsWith(t.href)
                ? 'bg-gray-900 text-white'
                : 'text-gray-600 hover:bg-gray-100'
            }`}
          >
            {t.label}
          </Link>
        ))}
      </div>
      <button
        onClick={logout}
        className="text-xs text-gray-400 hover:text-gray-700 transition-colors"
      >
        Logout
      </button>
    </nav>
  );
}
