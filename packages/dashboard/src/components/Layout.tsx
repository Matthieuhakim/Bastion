import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

const navItems = [
  { to: '/agents', label: 'Agents' },
  { to: '/hitl', label: 'HITL Queue' },
  { to: '/audit', label: 'Audit Log' },
  { to: '/credentials', label: 'Credentials' },
];

export function Layout() {
  const { logout } = useAuth();

  return (
    <div className="flex h-screen bg-gray-50">
      <aside className="flex w-56 flex-col border-r border-gray-200 bg-white">
        <div className="border-b border-gray-200 px-5 py-4">
          <h1 className="text-lg font-bold text-gray-900">Bastion</h1>
          <p className="text-xs text-gray-500">Dashboard</p>
        </div>
        <nav className="flex-1 space-y-1 px-3 py-4">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `block rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-gray-100 text-gray-900'
                    : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-gray-200 p-3">
          <button
            onClick={logout}
            className="w-full rounded-md px-3 py-2 text-left text-sm text-gray-600 hover:bg-gray-50 hover:text-gray-900"
          >
            Log out
          </button>
        </div>
      </aside>
      <main className="flex-1 overflow-auto p-8">
        <Outlet />
      </main>
    </div>
  );
}
