import { resolve } from 'node:path';

export function assertWorkspaceAccess(policy, requestedPath) {
  const raw = String(requestedPath ?? policy.defaultRoot ?? '');
  if (/^\\\\/.test(raw) || /^[a-zA-Z]:\\{2,}/.test(raw) || raw.startsWith('\\\\.\\') || raw.startsWith('\\\\?\\')) {
    const error = new Error('canonical policy violation: UNC or device path');
    error.code = 'workspace_policy_violation';
    throw error;
  }
  const canonical = resolve(raw);
  const roots = (policy.roots ?? []).map((root) => resolve(root).toLowerCase());
  const allowed = roots.some((root) => {
    const target = canonical.toLowerCase();
    return target === root || target.startsWith(`${root}\\`) || target.startsWith(`${root}/`);
  });
  if (!allowed) {
    const error = new Error('canonical policy violation: path escapes configured roots');
    error.code = 'workspace_policy_violation';
    throw error;
  }
  return { allowed: true, canonical };
}
