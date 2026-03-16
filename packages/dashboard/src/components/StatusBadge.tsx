const variants: Record<string, string> = {
  active: 'bg-green-50 text-green-700 ring-green-600/20',
  inactive: 'bg-gray-50 text-gray-600 ring-gray-500/10',
  revoked: 'bg-red-50 text-red-700 ring-red-600/10',
  pending: 'bg-yellow-50 text-yellow-800 ring-yellow-600/20',
  approved: 'bg-green-50 text-green-700 ring-green-600/20',
  denied: 'bg-red-50 text-red-700 ring-red-600/10',
  ALLOW: 'bg-green-50 text-green-700 ring-green-600/20',
  DENY: 'bg-red-50 text-red-700 ring-red-600/10',
  ESCALATE: 'bg-yellow-50 text-yellow-800 ring-yellow-600/20',
  API_KEY: 'bg-blue-50 text-blue-700 ring-blue-700/10',
  OAUTH2: 'bg-purple-50 text-purple-700 ring-purple-700/10',
  CUSTOM: 'bg-gray-50 text-gray-600 ring-gray-500/10',
};

export function StatusBadge({ variant, label }: { variant: string; label?: string }) {
  const classes = variants[variant] ?? variants.inactive;
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset ${classes}`}
    >
      {label ?? variant}
    </span>
  );
}
